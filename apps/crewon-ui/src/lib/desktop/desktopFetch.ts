import { hasDesktopBridge } from "../platform";
import { requireDesktopBridge } from "./desktopBridge";
import {
  DESKTOP_HTTP_LIMITS as limits,
  DESKTOP_HTTP_VERSION,
  isDesktopEventStream,
} from "./desktopHttpProtocol";
import {
  acquireDesktopHttpRequest,
  desktopAbortReason,
  readDesktopRequestBody,
  withDesktopAbort,
} from "./desktopHttpClientBudget";

const INSTALLED = Symbol.for("crewon.desktopFetch");
const REQUEST_TIMEOUT_MS = 15_000;
type MaybePatched = typeof fetch & { [INSTALLED]?: true };

/** Keep relative Web requests on the platform; absolute Desktop requests use the isolated host. */
export async function installDesktopFetch(): Promise<void> {
  if (!hasDesktopBridge() || (globalThis.fetch as MaybePatched)[INSTALLED])
    return;
  const platformFetch = globalThis.fetch.bind(globalThis);
  const patched: MaybePatched = (input, init) =>
    isAbsolute(input)
      ? desktopBridgeFetch(input, init)
      : platformFetch(input, withTimeout(init));
  patched[INSTALLED] = true;
  globalThis.fetch = patched;
}

/** HTTP transport v2 pulls at most one bounded chunk for each consumer read. */
export async function desktopBridgeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const bridge = requireDesktopBridge();
  if (
    bridge.http?.version !== DESKTOP_HTTP_VERSION ||
    typeof bridge.http.read !== "function"
  )
    throw new Error("desktop_http_version_incompatible");
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const budget = acquireDesktopHttpRequest(
    method === "GET" || method === "HEAD" ? "read" : "write",
  );
  const requestId = globalThis.crypto.randomUUID();
  const controller = new AbortController();
  let finished = false,
    sent = false,
    abortSent = false,
    receivedBytes = 0;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let callerSignal: AbortSignal | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(
    () => controller.abort(new DeadlineError(REQUEST_TIMEOUT_MS)),
    REQUEST_TIMEOUT_MS,
  );
  const relayCallerAbort = () =>
    controller.abort(desktopAbortReason(callerSignal!));
  const clearIdle = () => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
  };
  const armIdle = () => {
    clearIdle();
    idle = setTimeout(
      () => controller.abort(new Error("desktop_http_consumer_idle")),
      limits.consumerIdleMs,
    );
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearIdle();
    callerSignal?.removeEventListener("abort", relayCallerAbort);
    controller.signal.removeEventListener("abort", abortBody);
    budget.release();
  };
  const abortHost = () => {
    if (!sent || abortSent) return;
    abortSent = true;
    void bridge.http.abort(requestId).catch(() => {});
  };
  const abortBody = () => {
    if (finished) return;
    bodyController?.error(desktopAbortReason(controller.signal));
    finish();
    abortHost();
  };
  controller.signal.addEventListener("abort", abortBody, { once: true });
  try {
    const headers = mergeHeaders(input, init);
    const request = new Request(input, init);
    if (request.url.length > limits.urlCharacters)
      throw new Error("desktop_http_request_invalid");
    const headerEntries: [string, string][] = [];
    let headerBytes = 0;
    for (const [name, value] of headers) {
      if (
        headerEntries.length >= limits.headers ||
        name.length + value.length > limits.headerBytes
      )
        throw new Error("desktop_http_headers_too_large");
      headerBytes +=
        new TextEncoder().encode(name).length +
        new TextEncoder().encode(value).length;
      if (headerBytes > limits.headerBytes)
        throw new Error("desktop_http_headers_too_large");
      headerEntries.push([name, value]);
    }
    callerSignal = request.signal;
    if (callerSignal.aborted) throw desktopAbortReason(callerSignal);
    callerSignal.addEventListener("abort", relayCallerAbort, { once: true });
    const body = await readDesktopRequestBody(
      request,
      controller.signal,
      budget,
    );
    controller.signal.throwIfAborted();
    sent = true;
    const result = await withDesktopAbort(
      bridge.http.fetch({
        requestId,
        url: request.url,
        method: request.method,
        headers: headerEntries,
        body,
      }),
      controller.signal,
    );
    budget.releaseBody();
    const eventStream = isDesktopEventStream(result.headers);
    if (eventStream) clearTimeout(timer);
    const bodyAllowed =
      request.method !== "HEAD" && ![204, 205, 304].includes(result.status);
    if (!bodyAllowed) finish();
    const responseBody = bodyAllowed
      ? new ReadableStream<Uint8Array>(
          {
            start(streamController) {
              bodyController = streamController;
              armIdle();
            },
            async pull(streamController) {
              if (finished) return;
              clearIdle();
              try {
                const part = await withDesktopAbort(
                  bridge.http.read(requestId),
                  controller.signal,
                );
                if (finished) return;
                if (part.type === "end") {
                  finish();
                  streamController.close();
                  return;
                }
                if (
                  part.type !== "chunk" ||
                  !(part.chunk instanceof Uint8Array) ||
                  !part.chunk.byteLength ||
                  part.chunk.byteLength > limits.chunkBytes
                )
                  throw new Error("desktop_http_chunk_invalid");
                receivedBytes += part.chunk.byteLength;
                if (receivedBytes > limits.responseBytes)
                  throw new Error("desktop_http_response_too_large");
                streamController.enqueue(part.chunk);
                armIdle();
              } catch (error) {
                if (finished) return;
                finish();
                abortHost();
                streamController.error(error);
              }
            },
            cancel() {
              finish();
              abortHost();
            },
          },
          { highWaterMark: 0 },
        )
      : null;
    return new Response(responseBody, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers as [string, string][],
    });
  } catch (error) {
    finish();
    abortHost();
    throw error;
  }
}

/** Preserve explicit Origin, which Chromium can strip while constructing Request. */
function mergeHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return headers;
}
class DeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`request exceeded ${timeoutMs}ms`);
    this.name = "DeadlineError";
  }
}
function isAbsolute(input: RequestInfo | URL): boolean {
  const url =
    input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : input.url;
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(url);
}
function withTimeout(init: RequestInit | undefined): RequestInit {
  return init?.signal
    ? init
    : { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}
