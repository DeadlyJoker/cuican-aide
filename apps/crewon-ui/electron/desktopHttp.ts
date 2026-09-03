import type {
  DesktopHttpBodyEvent,
  DesktopHttpRequest,
  DesktopHttpResponse,
} from "../src/lib/desktop/desktopBridge.ts";

const MAXIMUM_RESPONSE_BYTES = 64 * 1024 * 1024;
const RESPONSE_HANDSHAKE_TIMEOUT_MS = 30_000;
const REQUEST_ID_PATTERN = /^[0-9a-f-]{36}$/iu;

type DesktopFetchOptions = Readonly<{
  activeRequests: Map<string, AbortController>;
  emit: (requestId: string, event: DesktopHttpBodyEvent) => void;
}>;

/** Opens a loopback request and forwards its response body incrementally. */
export async function desktopFetch(
  request: DesktopHttpRequest,
  options: DesktopFetchOptions,
): Promise<DesktopHttpResponse> {
  validateRequest(request);
  const url = new URL(request.url);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback) {
    throw new Error("desktop_http_url_invalid");
  }
  if (options.activeRequests.has(request.requestId)) {
    throw new Error("desktop_http_request_id_conflict");
  }
  const requestBody =
    request.body === null
      ? undefined
      : (request.body.buffer.slice(
          request.body.byteOffset,
          request.body.byteOffset + request.body.byteLength,
        ) as ArrayBuffer);
  const controller = new AbortController();
  options.activeRequests.set(request.requestId, controller);
  const handshakeTimer = setTimeout(
    () => controller.abort(new Error("desktop_http_response_timeout")),
    RESPONSE_HANDSHAKE_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers: new Headers(request.headers as [string, string][]),
      body: requestBody,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    options.activeRequests.delete(request.requestId);
    throw error;
  } finally {
    clearTimeout(handshakeTimer);
  }
  void streamResponseBody(response, request.requestId, controller, options);
  return {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
  };
}

function validateRequest(request: DesktopHttpRequest): void {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(request.requestId) ||
    typeof request.url !== "string" ||
    typeof request.method !== "string" ||
    !Array.isArray(request.headers) ||
    !(request.body === null || request.body instanceof Uint8Array)
  ) {
    throw new Error("desktop_http_request_invalid");
  }
}

async function streamResponseBody(
  response: Response,
  requestId: string,
  controller: AbortController,
  options: DesktopFetchOptions,
): Promise<void> {
  let receivedBytes = 0;
  try {
    if (response.body !== null) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          receivedBytes += chunk.value.byteLength;
          if (receivedBytes > MAXIMUM_RESPONSE_BYTES) {
            controller.abort(new Error("desktop_http_response_too_large"));
            throw new Error("desktop_http_response_too_large");
          }
          options.emit(requestId, { type: "chunk", chunk: chunk.value });
        }
      } finally {
        reader.releaseLock();
      }
    }
    options.emit(requestId, { type: "end" });
  } catch {
    options.emit(requestId, {
      type: "error",
      message: controller.signal.aborted
        ? "desktop_http_request_aborted"
        : "desktop_http_response_stream_failed",
    });
  } finally {
    options.activeRequests.delete(requestId);
  }
}
