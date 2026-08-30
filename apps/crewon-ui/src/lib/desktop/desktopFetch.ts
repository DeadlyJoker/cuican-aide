import { hasDesktopBridge } from "../platform";
import { requireDesktopBridge } from "./desktopBridge";

const INSTALLED = Symbol.for("crewon.desktopFetch");
const REQUEST_TIMEOUT_MS = 15_000;
type MaybePatched = typeof fetch & { [INSTALLED]?: true };

/**
 * Installs the desktop request bridge before React mounts. Absolute requests
 * cross the isolated preload into Electron's TypeScript main process, while
 * relative requests retain normal browser/Vite behavior.
 */
export async function installDesktopFetch(): Promise<void> {
  if (!hasDesktopBridge() || (globalThis.fetch as MaybePatched)[INSTALLED]) {
    return;
  }
  const platformFetch = globalThis.fetch.bind(globalThis);
  const patched: MaybePatched = (input, init) =>
    isAbsolute(input)
      ? withDeadline(desktopBridgeFetch(input, withTimeout(init)))
      : platformFetch(input, withTimeout(init));
  patched[INSTALLED] = true;
  globalThis.fetch = patched;
}

/** Serializes one Fetch request across the narrow Electron bridge. */
export async function desktopBridgeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = mergeHeaders(input, init);
  const request = new Request(input, init);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : new Uint8Array(await request.arrayBuffer());
  const result = await withAbort(
    requireDesktopBridge().http.fetch({
      url: request.url,
      method: request.method,
      headers: [...headers.entries()],
      body,
    }),
    request.signal,
  );
  const bodyAllowed =
    request.method !== "HEAD" &&
    result.status !== 204 &&
    result.status !== 205 &&
    result.status !== 304;
  const responseBody = bodyAllowed
    ? (result.body.buffer.slice(
        result.body.byteOffset,
        result.body.byteOffset + result.body.byteLength,
      ) as ArrayBuffer)
    : null;
  return new Response(responseBody, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers as [string, string][],
  });
}

/**
 * Chromium removes forbidden browser headers such as `Origin` while building a
 * `Request`. Desktop Control requests cross a typed host bridge instead of the
 * browser network stack, so preserve the caller's original header collection
 * before constructing the Request used for URL/body normalization.
 */
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

async function withDeadline<T>(
  pending: Promise<T>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(timeoutMs)), timeoutMs);
  });
  pending.catch(() => {});
  try {
    return await Promise.race([pending, expiry]);
  } finally {
    clearTimeout(timer);
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
  if (init?.signal) return init;
  return { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
