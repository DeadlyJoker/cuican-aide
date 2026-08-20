/**
 * Routes network calls through Tauri in a packaged build.
 *
 * The webview enforces CORS, while packaged Control is an authenticated
 * loopback service on a different origin and deliberately does not expose a
 * browser CORS surface. In dev, the Vite BFF keeps Control requests
 * same-origin; a packaged build must route absolute Control requests through
 * Tauri's HTTP plugin.
 *
 * Requests issued from Rust are not subject to the webview's origin rules, so
 * the fix is to send them there. Installing it as `globalThis.fetch` rather than
 * threading a client through every call site ensures the generated Control
 * client captures the correct transport when it is constructed.
 */

import { hasDesktopBridge, hasDevServerProxy } from "../platform";

/** Marks the patched function so installing twice is a no-op. */
const INSTALLED = Symbol.for("crewon.desktopFetch");

type MaybePatched = typeof fetch & { [INSTALLED]?: true };

/**
 * Ceiling on how long a request may hang.
 *
 * A request that never settles is worse than one that fails: the app sat on its
 * loading screen indefinitely, because the code waiting on it treats a rejection
 * as a state to render and a pending promise as "still working". Requests go
 * through Rust here, so a stalled connection has no browser timeout to fall back
 * on.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Replaces `globalThis.fetch` with Tauri's when running packaged.
 *
 * A no-op on web and under `tauri dev`, where the dev-server proxy already makes
 * backend calls same-origin and the platform's own fetch is what tests and
 * tooling expect.
 *
 * Awaited by the caller before rendering: a component that fetches on mount
 * would otherwise race the patch and use the blocked implementation.
 */
export async function installDesktopFetch(): Promise<void> {
  /*
   * Deliberately the bridge check and not the runtime surface: this swap needs
   * real Tauri IPC. `?surface=desktop` in a browser renders the desktop chrome
   * with no IPC behind it, and patching there makes every request fail inside
   * the plugin rather than falling back to the platform's fetch.
   */
  if (!hasDesktopBridge()) {
    return;
  }
  /*
   * `tauri dev` loads the page from the Vite dev server, so every backend call
   * already goes through its proxy and is same-origin. Swapping fetch there buys
   * nothing and costs the platform behaviour the dev flow is tested against:
   * the login request went through the plugin path and never settled, leaving
   * the button spinning with no error to show.
   *
   * Only a packaged build, served from `tauri://localhost` with no proxy behind
   * it, needs Rust to issue the request.
   */
  if (hasDevServerProxy()) {
    return;
  }
  if ((globalThis.fetch as MaybePatched)[INSTALLED]) {
    return;
  }

  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  /*
   * Bound to the realm. WebKit rejects an unbound `fetch` reference with an
   * illegal-invocation error, and because the rejection happens inside the
   * patched function every caller sees a request that simply failed.
   */
  const platformFetch = globalThis.fetch.bind(globalThis);

  /*
   * Both branches get a deadline. A same-origin request can stall too -- a dev
   * server mid-restart accepts the connection and then answers nothing -- and an
   * unsettled promise reads as "still working" to every caller.
   */
  const patched: MaybePatched = (input, init) =>
    isAbsolute(input)
      ? withDeadline(tauriFetch(input, withTimeout(init)))
      : platformFetch(input, withTimeout(init));
  patched[INSTALLED] = true;
  globalThis.fetch = patched;
}

/** A request that never answered, as opposed to one that failed. */
class DeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`request exceeded ${timeoutMs}ms`);
    this.name = "DeadlineError";
  }
}

/**
 * Rejects if the plugin never answers, independently of the abort signal.
 *
 * `AbortSignal` alone cannot cover this. The plugin relays an abort by invoking
 * `plugin:http|fetch_cancel`, so cancellation travels the same IPC channel as
 * the request. Whatever stalls that channel also strands the cancellation, and
 * the timeout silently never fires -- exactly the failure mode this module exists
 * to rule out, since an unsettled promise reads as "still working" to every
 * caller and leaves the app on its loading screen with nothing to render.
 *
 * A race in JS needs nothing from Rust, so it holds even when the bridge does
 * not. The Rust-side request may still be running afterwards; that leaks a
 * request, which is strictly better than an app that never renders.
 */
async function withDeadline(
  pending: Promise<Response>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(timeoutMs)), timeoutMs);
  });
  /*
   * Claim the rejection before racing. Once the deadline wins, nothing is left
   * awaiting the original promise, and its later rejection -- the abort signal
   * firing, say -- would surface as an unhandled rejection.
   */
  pending.catch(() => {});
  try {
    return await Promise.race([pending, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a request target carries its own origin.
 *
 * Rust has no page to resolve a relative URL against, so handing it one produces
 * a request that cannot be built. Relative targets are same-origin by
 * definition and belong on the webview's own fetch; only absolute packaged
 * Control URLs use the plugin.
 */
function isAbsolute(input: RequestInfo | URL): boolean {
  const url =
    input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : input.url;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
}

function withTimeout(init: RequestInit | undefined): RequestInit {
  if (init?.signal) {
    // A caller managing cancellation already owns the lifetime; layering a
    // second signal on top would silently cut their request short.
    return init;
  }
  return { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}
