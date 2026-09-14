import { deliveryRequestBodyLimit } from "@crewon/domain/delivery-http-policy";
import { DESKTOP_HTTP_LIMITS as limits } from "./desktopHttpProtocol";

let active = 0,
  reads = 0,
  bodyBytes = 0;
/** Shared across callers in this renderer, including requests still preparing their body. */
export function acquireDesktopHttpRequest(
  kind: "read" | "write",
  request?: { method: string; url: string },
) {
  const maximumBodyBytes = request
    ? deliveryRequestBodyLimit({
        ...request,
        defaultLimit: limits.requestBodyBytes,
      })
    : limits.requestBodyBytes;
  if (
    active >= limits.activeRequests ||
    (kind === "read" && reads >= limits.readRequests)
  )
    throw new Error("desktop_http_capacity");
  active++;
  if (kind === "read") reads++;
  let ownedBytes = 0,
    released = false;
  const releaseBody = () => {
    bodyBytes -= ownedBytes;
    ownedBytes = 0;
  };
  return {
    reserve(bytes: number) {
      if (released) throw new Error("desktop_http_request_aborted");
      if (ownedBytes + bytes > maximumBodyBytes)
        throw new Error("desktop_http_request_too_large");
      if (bodyBytes + bytes > limits.requestBytes)
        throw new Error("desktop_http_capacity");
      bodyBytes += bytes;
      ownedBytes += bytes;
    },
    releaseBody,
    release() {
      if (!released) {
        released = true;
        releaseBody();
        active--;
        if (kind === "read") reads--;
      }
    },
  };
}

export function desktopAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("desktop_http_request_aborted");
}
export function withDesktopAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(desktopAbortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(desktopAbortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function readDesktopRequestBody(
  request: Request,
  signal: AbortSignal,
  budget: ReturnType<typeof acquireDesktopHttpRequest>,
) {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const cancel = () => {
    void reader.cancel(desktopAbortReason(signal)).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await withDesktopAbort(reader.read(), signal);
      if (chunk.done) break;
      if (!chunk.value.byteLength || chunks.length >= 4096)
        throw new Error("desktop_http_request_fragmentation");
      budget.reserve(chunk.value.byteLength);
      chunks.push(chunk.value);
      bytes += chunk.value.byteLength;
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
