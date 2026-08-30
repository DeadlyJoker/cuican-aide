import { afterEach, describe, expect, it, vi } from "vitest";

import type { CrewonDesktopBridge } from "./desktopBridge";
import { installDesktopFetch } from "./desktopFetch";

const hostFetch = vi.fn<CrewonDesktopBridge["http"]["fetch"]>(
  async (request) => ({
    url: request.url,
    status: 200,
    statusText: "OK",
    headers: [["content-type", "text/plain"]],
    body: new TextEncoder().encode("from desktop"),
  }),
);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hostFetch.mockReset();
  hostFetch.mockImplementation(async (request) => ({
    url: request.url,
    status: 200,
    statusText: "OK",
    headers: [["content-type", "text/plain"]],
    body: new TextEncoder().encode("from desktop"),
  }));
});

function desktopWindow() {
  return {
    location: { hostname: "127.0.0.1", protocol: "http:", search: "" },
    crewonDesktop: { version: 1, http: { fetch: hostFetch } },
  };
}

describe("installDesktopFetch", () => {
  it("leaves fetch untouched on Web", async () => {
    const original = vi.fn();
    vi.stubGlobal("fetch", original);
    vi.stubGlobal("window", { location: { search: "" } });

    await installDesktopFetch();

    expect(globalThis.fetch).toBe(original);
  });

  it("routes absolute desktop requests through the isolated host", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", desktopWindow());

    await installDesktopFetch();
    const response = await globalThis.fetch(
      "http://127.0.0.1:3210/api/v1/health",
      {
        headers: {
          Accept: "application/json",
          Origin: "http://crewon.localhost",
        },
      },
    );

    expect(await response.text()).toBe("from desktop");
    expect(hostFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:3210/api/v1/health",
        method: "GET",
        headers: [
          ["accept", "application/json"],
          ["origin", "http://crewon.localhost"],
        ],
        body: null,
      }),
    );
  });

  it("keeps relative URLs on the renderer fetch", async () => {
    const platformFetch = vi.fn<typeof fetch>(
      async (_input, _init) => new Response("from renderer"),
    );
    vi.stubGlobal("fetch", platformFetch);
    vi.stubGlobal("window", desktopWindow());

    await installDesktopFetch();
    await globalThis.fetch("/agent-platform-api/api/v1/health");

    expect(platformFetch.mock.calls[0]?.[0]).toBe(
      "/agent-platform-api/api/v1/health",
    );
    expect(platformFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("does not wrap itself twice", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", desktopWindow());

    await installDesktopFetch();
    const patched = globalThis.fetch;
    await installDesktopFetch();

    expect(globalThis.fetch).toBe(patched);
  });

  it("bounds an IPC request that never settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", desktopWindow());
    hostFetch.mockImplementation(() => new Promise(() => {}));
    await installDesktopFetch();

    const pending = globalThis.fetch("http://127.0.0.1:3210/api/v1/health");
    const rejected = expect(pending).rejects.toThrow(
      "request exceeded 15000ms",
    );
    await vi.advanceTimersByTimeAsync(15_000);

    await rejected;
  });

  it("honors a caller-owned abort signal", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", desktopWindow());
    hostFetch.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    await installDesktopFetch();

    const pending = globalThis.fetch("http://127.0.0.1:3210/api/v1/health", {
      signal: controller.signal,
    });
    controller.abort(new Error("caller canceled"));

    await expect(pending).rejects.toThrow("caller canceled");
  });
});
