import { hasDesktopBridge } from "../platform";
import {
  requireDesktopBridge,
  type DesktopHttpBodyEvent,
} from "./desktopBridge";

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
      ? desktopBridgeFetch(input, init)
      : platformFetch(input, withTimeout(init));
  patched[INSTALLED] = true;
  globalThis.fetch = patched;
}

/** Serializes one Fetch request across the narrow Electron bridge. */
export async function desktopBridgeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const bridge = requireDesktopBridge();
  const requestId = globalThis.crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DeadlineError(REQUEST_TIMEOUT_MS)),
    REQUEST_TIMEOUT_MS,
  );
  // If the caller supplied their own signal, race it against the deadline.
  const callerSignal = init?.signal;
  const relayCallerAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(reasonFromSignal(callerSignal!));
    }
  };
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      throw reasonFromSignal(callerSignal);
    }
    callerSignal.addEventListener("abort", relayCallerAbort, { once: true });
  }
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let bodyFinished = false;
  let receivedTerminalEvent = false;
  const pendingBodyEvents: DesktopHttpBodyEvent[] = [];
  const finishBody = () => {
    clearTimeout(timer);
    if (callerSignal) {
      callerSignal.removeEventListener("abort", relayCallerAbort);
    }
  };
  const deliverBodyEvent = (event: DesktopHttpBodyEvent) => {
    if (bodyFinished || bodyController === null) return;
    if (event.type === "chunk") {
      bodyController.enqueue(event.chunk);
      return;
    }
    bodyFinished = true;
    if (event.type === "end") {
      bodyController.close();
    } else {
      bodyController.error(new Error(event.message));
    }
  };
  const onBodyEvent = (event: DesktopHttpBodyEvent) => {
    if (bodyFinished || receivedTerminalEvent) return;
    if (event.type === "end" || event.type === "error") {
      receivedTerminalEvent = true;
      finishBody();
    }
    if (bodyController === null) {
      pendingBodyEvents.push(event);
      return;
    }
    deliverBodyEvent(event);
  };
  const abortHostRequest = () => {
    void bridge.http.abort(requestId).catch(() => undefined);
  };
  const abortBody = () => {
    if (bodyFinished) return;
    bodyFinished = true;
    receivedTerminalEvent = true;
    bodyController?.error(reasonFromSignal(controller.signal));
    finishBody();
    abortHostRequest();
  };
  controller.signal.addEventListener("abort", abortBody, { once: true });
  try {
    const headers = mergeHeaders(input, init);
    const request = new Request(input, init);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : new Uint8Array(await request.arrayBuffer());
    // The IPC bridge does not accept an AbortSignal, so wrap the pending
    // promise so that aborting the controller rejects the outstanding call.
    const result = await withAbort(
      bridge.http.fetch(
        {
          requestId,
          url: request.url,
          method: request.method,
          headers: [...headers.entries()],
          body,
        },
        onBodyEvent,
      ),
      controller.signal,
    );
    const contentType = result.headers.find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1];
    if (/^text\/event-stream(?:;|$)/iu.test(contentType ?? "")) {
      clearTimeout(timer);
    }
    const bodyAllowed =
      request.method !== "HEAD" &&
      result.status !== 204 &&
      result.status !== 205 &&
      result.status !== 304;
    const responseBody = bodyAllowed
      ? new ReadableStream<Uint8Array>({
          start(streamController) {
            bodyController = streamController;
            for (const event of pendingBodyEvents.splice(0)) {
              deliverBodyEvent(event);
            }
          },
          cancel() {
            if (!bodyFinished) {
              bodyFinished = true;
              receivedTerminalEvent = true;
              finishBody();
              abortHostRequest();
            }
          },
        })
      : null;
    return new Response(responseBody, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers as [string, string][],
    });
  } finally {
    if (bodyController === null && !receivedTerminalEvent) {
      abortHostRequest();
      finishBody();
    }
  }
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

function isAbsolute(input: RequestInfo | URL): boolean {
  const url =
    input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : input.url;
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(url);
}

/**
 * Returns a meaningful Error from an aborted signal. Some Electron/Node
 * runtimes leave `signal.reason` as `undefined` when
 * `AbortSignal.timeout()` fires, which surfaces as the opaque
 * "signal is aborted without reason" message. Fall back to a
 * `DeadlineError` so the UI can display actionable text.
 */
function reasonFromSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new DeadlineError(REQUEST_TIMEOUT_MS);
}

function withTimeout(init: RequestInit | undefined): RequestInit {
  if (init?.signal) return init;
  return { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(reasonFromSignal(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(reasonFromSignal(signal));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
