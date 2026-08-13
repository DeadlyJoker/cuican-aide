import { afterEach, describe, expect, it, vi } from "vitest";

import { detectRuntimeSurface } from "./platform";

function stubLocation(href: string) {
  const url = new URL(href);
  vi.stubGlobal("window", {
    location: {
      host: url.host,
      hostname: url.hostname,
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      port: url.port,
      protocol: url.protocol,
      search: url.search,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime surface", () => {
  it("reads web when no desktop bridge is present", () => {
    stubLocation("http://127.0.0.1:5175/");

    expect(detectRuntimeSurface()).toBe("web");
  });

  it("reads desktop when the Tauri bridge is injected", () => {
    stubLocation("http://127.0.0.1:5175/");
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    expect(detectRuntimeSurface()).toBe("desktop");
  });

  it("honours an explicit surface override", () => {
    stubLocation("http://127.0.0.1:5175/?surface=desktop");

    expect(detectRuntimeSurface()).toBe("desktop");
  });
});
