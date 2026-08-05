/**
 * Routes network calls through Tauri in a packaged build.
 *
 * The webview enforces CORS, and the agent-platform backend sends no
 * `Access-Control-Allow-Origin`. In dev that never surfaced because the Vite
 * proxy made every call same-origin; a packaged build dialling the backend
 * directly from `tauri://localhost` had all of them blocked, surfacing as
 * `Load failed` on the login screen.
 *
 * Requests issued from Rust are not subject to the webview's origin rules, so
 * the fix is to send them there. Installing it as `globalThis.fetch` rather than
 * threading a client through every call site means no request can be forgotten,
 * including ones added later.
 */

import { detectRuntimeSurface } from "../platform";

/** Marks the patched function so installing twice is a no-op. */
const INSTALLED = Symbol.for("crewon.desktopFetch");

type MaybePatched = typeof fetch & { [INSTALLED]?: true };

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
  if (detectRuntimeSurface() !== "desktop") {
    return;
  }
  if ((globalThis.fetch as MaybePatched)[INSTALLED]) {
    return;
  }

  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");

  const patched: MaybePatched = (input, init) => tauriFetch(input, init);
  patched[INSTALLED] = true;
  globalThis.fetch = patched;
}
