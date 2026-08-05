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

const tauriFetch = vi.fn(async () => new Response("from tauri"));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...(args as [])),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  tauriFetch.mockClear();
});

describe("installDesktopFetch", () => {
  it("leaves fetch alone on web", async () => {
    const original = vi.fn();
    vi.stubGlobal("fetch", original);
    // No Tauri bridge injected, so the surface reads as web.
    vi.stubGlobal("window", { location: { search: "" } });

    await installDesktopFetch();

    expect(globalThis.fetch).toBe(original);
  });

  it("routes through Tauri in a desktop build", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", { location: { search: "" } });
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    await installDesktopFetch();
    await globalThis.fetch("http://127.0.0.1:8000/api/v1/health");

    expect(tauriFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/health",
      undefined,
    );
  });

  it("does not wrap itself when called twice", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", { location: { search: "" } });
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    await installDesktopFetch();
    const patched = globalThis.fetch;
    await installDesktopFetch();

    expect(globalThis.fetch).toBe(patched);
  });
});
