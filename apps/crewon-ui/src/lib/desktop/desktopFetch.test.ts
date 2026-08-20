import { afterEach, describe, expect, it, vi } from "vitest";

import { installDesktopFetch } from "./desktopFetch";

/*
 * The packaged app could not talk to the backend: the webview enforces CORS and
 * agent-platform sends no `Access-Control-Allow-Origin`, so every request failed
 * with `Load failed`. Dev never hit it because the Vite proxy made those calls
 * same-origin. These cover the two things that would silently undo the fix --
 * patching on web, where the platform fetch is what tests and tooling expect,
 * and patching twice, which would wrap a wrapper.
 */

const tauriFetch = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("from tauri"),
);

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    tauriFetch(input, init),
}));

/*
 * A packaged build is served from the synthetic `tauri.localhost` host, which has
 * no dev server behind it. That is the only case where requests need Rust: under
 * `tauri dev` the Vite proxy already makes them same-origin.
 */
const packagedLocation = {
  hostname: "tauri.localhost",
  protocol: "http:",
  search: "",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Reset, not clear: the stalled-plugin test replaces the implementation, and
  // leaving that in place would stall every test after it.
  tauriFetch.mockReset();
  tauriFetch.mockImplementation(async () => new Response("from tauri"));
});

/** Finds the recorded request by URL, so assertions do not ride on call order. */
function requestTo(url: string): RequestInit | undefined {
  const call = tauriFetch.mock.calls.find(([input]) => input === url);
  expect(call).toBeDefined();
  return call?.[1];
}

describe("installDesktopFetch", () => {
  it("leaves fetch alone on web", async () => {
    const original = vi.fn();
    vi.stubGlobal("fetch", original);
    // No Tauri bridge injected, so the surface reads as web.
    vi.stubGlobal("window", { location: { search: "" } });

    await installDesktopFetch();

    expect(globalThis.fetch).toBe(original);
  });

  it("leaves fetch alone under tauri dev, where the proxy already applies", async () => {
    // The window loads from the Vite dev server, so backend calls are already
    // same-origin. Routing them through the plugin anyway is what left the login
    // button spinning: the request went to Rust and never settled.
    const original = vi.fn();
    vi.stubGlobal("fetch", original);
    vi.stubGlobal("window", {
      location: { hostname: "127.0.0.1", protocol: "http:", search: "" },
    });
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    await installDesktopFetch();

    expect(globalThis.fetch).toBe(original);
  });

  it("routes through Tauri in a desktop build", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", { location: packagedLocation });
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    await installDesktopFetch();
    await globalThis.fetch("http://127.0.0.1:8000/api/v1/health");

    expect(requestTo("http://127.0.0.1:8000/api/v1/health")).toBeDefined();
  });

  it("does not wrap itself when called twice", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", { location: packagedLocation });
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    await installDesktopFetch();
    const patched = globalThis.fetch;
    await installDesktopFetch();

    expect(globalThis.fetch).toBe(patched);
  });

  it("leaves a relative URL on the webview's fetch", async () => {
    // Rust has no page to resolve it against. Sending `/agent-platform-api` there
    // produced a request that never settled, and the app hung on its loading
    // screen -- which is also why these are same-origin and need no escape hatch.
    const platformFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("from webview"),
    );
    vi.stubGlobal("fetch", platformFetch);
    vi.stubGlobal("window", { location: packagedLocation });
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    await installDesktopFetch();
    await globalThis.fetch("/agent-platform-api/api/v1/health");

    expect(platformFetch.mock.calls[0]?.[0]).toBe(
      "/agent-platform-api/api/v1/health",
    );
    // Same-origin requests get the deadline too: a dev server mid-restart
    // accepts the connection and then answers nothing.
    expect(platformFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(
      tauriFetch.mock.calls.some(
        ([input]) => input === "/agent-platform-api/api/v1/health",
      ),
    ).toBe(false);
  });

  it("applies a timeout so a stalled request cannot hang the app", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", { location: packagedLocation });
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    await installDesktopFetch();
    await globalThis.fetch("http://127.0.0.1:8000/api/v1/health");

    expect(
      requestTo("http://127.0.0.1:8000/api/v1/health")?.signal,
    ).toBeInstanceOf(AbortSignal);
  });

  it("bounds a request the plugin never answers", async () => {
    /*
     * The failure this was written for: `plugin:http|fetch` returned a request id
     * and the follow-up `fetch_send` never settled, so the request hung and the
     * app stayed on its loading screen with nothing to render. A rejection is a
     * state callers already handle; a pending promise is not.
     */
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", { location: packagedLocation });
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    await installDesktopFetch();
    // Stalls only once the patch is in place, which is the shape of the real bug.
    tauriFetch.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const pending = globalThis.fetch("http://127.0.0.1:8000/api/v1/health");

    /*
     * The deadline is armed by the wrapper rather than left to each caller. The
     * signal is asserted instead of advancing a clock: `AbortSignal.timeout` runs
     * on the real one, so faking time here would only make the test slow.
     */
    const signal = requestTo("http://127.0.0.1:8000/api/v1/health")?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    // Aborting stands in for the ceiling elapsing, and the caller sees a
    // rejection rather than a promise that never settles.
    (signal as AbortSignal & { dispatchEvent: (event: Event) => boolean })
      .dispatchEvent(new Event("abort"));
    await expect(pending).rejects.toThrow();
  });

  it("keeps a caller's own signal rather than overriding it", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", { location: packagedLocation });
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const controller = new AbortController();

    await installDesktopFetch();
    await globalThis.fetch("http://127.0.0.1:8000/api/v1/health", {
      signal: controller.signal,
    });

    expect(requestTo("http://127.0.0.1:8000/api/v1/health")?.signal).toBe(
      controller.signal,
    );
  });
});
