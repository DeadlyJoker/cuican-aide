import { deliveryRequestBodyLimit } from "@crewon/domain/delivery-http-policy";
import { parseAgentPlatformOrigin } from "./agentPlatformCredentials.ts";
import type {
  DesktopHttpRequest,
  DesktopHttpResponse,
} from "../src/lib/desktop/desktopBridge.ts";
import {
  DESKTOP_HTTP_LIMITS as limits,
  isDesktopEventStream,
  type DesktopHttpReadResult,
} from "../src/lib/desktop/desktopHttpProtocol.ts";

type RequestState = {
  id: string;
  readOnly: boolean;
  controller: AbortController;
  reader: ReadableStreamBYOBReader | null;
  opening: boolean;
  reading: boolean;
  closing: boolean;
  requestBytes: number;
  receivedBytes: number;
  chunkBytes: number;
  idle: ReturnType<typeof setTimeout> | null;
};

/** One owner per desktop renderer. No response push queue or per-request IPC listeners. */
export class DesktopHttpTransport {
  static #active = 0;
  static #reads = 0;
  static #bodyBytes = 0;
  readonly #requests = new Map<string, RequestState>();
  #requestBytes = 0;
  readonly #consumerIdleMs: number;
  readonly #accountOrigin: string | null;
  constructor(
    options: { consumerIdleMs?: number; accountOrigin?: string } = {},
  ) {
    this.#accountOrigin =
      options.accountOrigin === undefined
        ? null
        : parseAgentPlatformOrigin(options.accountOrigin);
    this.#consumerIdleMs = options.consumerIdleMs ?? limits.consumerIdleMs;
    if (
      !Number.isSafeInteger(this.#consumerIdleMs) ||
      this.#consumerIdleMs < 1 ||
      this.#consumerIdleMs > limits.consumerIdleMs
    )
      throw new Error("desktop_http_idle_budget_invalid");
  }
  get usage() {
    return {
      activeRequests: this.#requests.size,
      requestBytes: this.#requestBytes,
      globalActiveRequests: DesktopHttpTransport.#active,
      globalReadRequests: DesktopHttpTransport.#reads,
      globalRequestBytes: DesktopHttpTransport.#bodyBytes,
    };
  }

  async fetch(request: DesktopHttpRequest): Promise<DesktopHttpResponse> {
    validateRequest(request, this.#accountOrigin);
    if (this.#requests.has(request.requestId))
      throw new Error("desktop_http_request_id_conflict");
    const bytes = request.body?.byteLength ?? 0;
    const readOnly = request.method === "GET" || request.method === "HEAD";
    if (
      DesktopHttpTransport.#active >= limits.activeRequests ||
      (readOnly && DesktopHttpTransport.#reads >= limits.readRequests) ||
      DesktopHttpTransport.#bodyBytes + bytes > limits.requestBytes
    )
      throw new Error("desktop_http_capacity");
    const entry: RequestState = {
      id: request.requestId,
      readOnly,
      controller: new AbortController(),
      reader: null,
      opening: true,
      reading: false,
      closing: false,
      requestBytes: bytes,
      receivedBytes: 0,
      chunkBytes: limits.chunkBytes,
      idle: null,
    };
    this.#requests.set(entry.id, entry);
    DesktopHttpTransport.#active++;
    if (readOnly) DesktopHttpTransport.#reads++;
    DesktopHttpTransport.#bodyBytes += bytes;
    this.#requestBytes += bytes;
    const timer = setTimeout(
      () => this.#close(entry, new Error("desktop_http_response_timeout")),
      limits.handshakeMs,
    );
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: new Headers(request.headers as [string, string][]),
        body: request.body === null ? undefined : Uint8Array.from(request.body),
        redirect: "error",
        signal: entry.controller.signal,
      });
      if (entry.closing) {
        await response.body?.cancel().catch(() => {});
        throw entry.controller.signal.reason;
      }
      const headers = [...response.headers.entries()];
      try {
        validateHeaders(headers);
        if (response.body !== null)
          entry.reader = response.body.getReader({ mode: "byob" });
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      entry.opening = false;
      if (isDesktopEventStream(headers))
        entry.chunkBytes = limits.eventChunkBytes;
      if (
        request.method === "HEAD" ||
        [204, 205, 304].includes(response.status)
      )
        this.#close(entry, new Error("desktop_http_body_not_allowed"));
      else this.#armIdle(entry);
      return {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers,
      };
    } catch (error) {
      entry.opening = false;
      this.#close(entry, error);
      throw error;
    } finally {
      clearTimeout(timer);
      this.#requestBytes -= entry.requestBytes;
      DesktopHttpTransport.#bodyBytes -= entry.requestBytes;
      entry.requestBytes = 0;
    }
  }

  async read(requestId: string): Promise<DesktopHttpReadResult> {
    validateId(requestId);
    const entry = this.#requests.get(requestId);
    if (!entry || entry.closing || entry.opening)
      throw new Error("desktop_http_request_unavailable");
    if (entry.reading) throw new Error("desktop_http_read_conflict");
    if (!entry.reader) {
      this.#release(entry);
      return { type: "end" };
    }
    this.#clearIdle(entry);
    entry.reading = true;
    try {
      const result = await entry.reader.read(new Uint8Array(entry.chunkBytes));
      entry.controller.signal.throwIfAborted();
      if (result.done) {
        entry.reader.releaseLock();
        entry.reader = null;
        this.#release(entry);
        return { type: "end" };
      }
      entry.receivedBytes += result.value.byteLength;
      if (entry.receivedBytes > limits.responseBytes)
        throw new Error("desktop_http_response_too_large");
      this.#armIdle(entry);
      // Avoid cloning an entire BYOB allocation for a tiny SSE frame.
      return { type: "chunk", chunk: result.value.slice() };
    } catch (error) {
      this.#close(entry, error);
      throw error;
    } finally {
      entry.reading = false;
    }
  }

  abort(requestId: string): void {
    validateId(requestId);
    const entry = this.#requests.get(requestId);
    if (entry) this.#close(entry, new Error("desktop_http_request_aborted"));
  }
  close(): void {
    for (const entry of this.#requests.values())
      this.#close(entry, new Error("desktop_http_owner_closed"));
  }
  #clearIdle(entry: RequestState) {
    if (entry.idle !== null) clearTimeout(entry.idle);
    entry.idle = null;
  }
  #armIdle(entry: RequestState) {
    this.#clearIdle(entry);
    entry.idle = setTimeout(
      () => this.#close(entry, new Error("desktop_http_consumer_idle")),
      this.#consumerIdleMs,
    );
  }
  #release(entry: RequestState) {
    this.#clearIdle(entry);
    if (this.#requests.get(entry.id) === entry) {
      this.#requests.delete(entry.id);
      DesktopHttpTransport.#active--;
      if (entry.readOnly) DesktopHttpTransport.#reads--;
    }
  }
  #close(entry: RequestState, error: unknown) {
    if (entry.closing) {
      if (!entry.opening && !entry.reader) this.#release(entry);
      return;
    }
    entry.closing = true;
    this.#clearIdle(entry);
    entry.controller.abort(error);
    const reader = entry.reader;
    if (reader) {
      // Admission stays occupied until native cancellation settles.
      void reader
        .cancel(error)
        .catch(() => {})
        .finally(() => {
          reader.releaseLock();
          entry.reader = null;
          this.#release(entry);
        });
    } else if (!entry.opening) this.#release(entry);
  }
}

function validateId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value))
    throw new Error("desktop_http_request_id_invalid");
}
function validateHeaders(
  headers: unknown,
): asserts headers is [string, string][] {
  if (!Array.isArray(headers) || headers.length > limits.headers)
    throw new Error("desktop_http_headers_invalid");
  let bytes = 0;
  for (const pair of headers) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((value) => typeof value !== "string")
    )
      throw new Error("desktop_http_headers_invalid");
    bytes += Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]);
    if (bytes > limits.headerBytes)
      throw new Error("desktop_http_headers_too_large");
  }
}
function validateRequest(
  request: DesktopHttpRequest,
  accountOrigin: string | null,
): void {
  if (typeof request !== "object" || request === null)
    throw new Error("desktop_http_request_invalid");
  validateId(request.requestId);
  if (
    typeof request.url !== "string" ||
    request.url.length > limits.urlCharacters ||
    typeof request.method !== "string" ||
    !/^[A-Z]{1,32}$/u.test(request.method) ||
    !(request.body === null || request.body instanceof Uint8Array)
  )
    throw new Error("desktop_http_request_invalid");
  if (
    (request.body?.byteLength ?? 0) >
    deliveryRequestBodyLimit({
      method: request.method,
      url: request.url,
      defaultLimit: limits.requestBodyBytes,
    })
  )
    throw new Error("desktop_http_request_too_large");
  validateHeaders(request.headers);
  const url = new URL(request.url);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (!loopback && url.origin !== accountOrigin) ||
    url.username ||
    url.password
  )
    throw new Error("desktop_http_url_invalid");
}
