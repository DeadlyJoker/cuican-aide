import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CrewonDesktopBridge,
  DesktopHttpBodyEvent,
} from "./desktopBridge";
import { installDesktopFetch } from "./desktopFetch";

const hostFetch = vi.fn<CrewonDesktopBridge["http"]["fetch"]>(
  async (request, onBodyEvent) => {
    queueMicrotask(() => {
      onBodyEvent({
        type: "chunk",
        chunk: new TextEncoder().encode("from desktop"),
      });
      onBodyEvent({ type: "end" });
    });
    return {
      url: request.url,
      status: 200,
      statusText: "OK",
      headers: [["content-type", "text/plain"]],
    };
  },
);
const hostAbort = vi.fn<CrewonDesktopBridge["http"]["abort"]>();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hostFetch.mockReset();
  hostAbort.mockReset();
  hostAbort.mockResolvedValue();
  hostFetch.mockImplementation(async (request, onBodyEvent) => {
    queueMicrotask(() => {
      onBodyEvent({
        type: "chunk",
        chunk: new TextEncoder().encode("from desktop"),
      });
      onBodyEvent({ type: "end" });
    });
    return {
      url: request.url,
      status: 200,
      statusText: "OK",
      headers: [["content-type", "text/plain"]],
    };
  });
});

function desktopWindow() {
  return {
    location: { hostname: "127.0.0.1", protocol: "http:", search: "" },
    crewonDesktop: {
      version: 1,
      http: { fetch: hostFetch, abort: hostAbort },
    },
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
        requestId: expect.any(String),
        url: "http://127.0.0.1:3210/api/v1/health",
        method: "GET",
        headers: [
          ["accept", "application/json"],
          ["origin", "http://crewon.localhost"],
        ],
        body: null,
      }),
      expect.any(Function),
    );
  });

  it("exposes body chunks before the host response ends", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", desktopWindow());
    let emitBodyEvent: ((event: DesktopHttpBodyEvent) => void) | undefined;
    hostFetch.mockImplementation(async (request, onBodyEvent) => {
      emitBodyEvent = onBodyEvent;
      return {
        url: request.url,
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/event-stream"]],
      };
    });
    await installDesktopFetch();

    const response = await globalThis.fetch(
      "http://127.0.0.1:3210/api/v1/runs/run-1/events",
    );
    const reader = response.body!.getReader();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(hostAbort).not.toHaveBeenCalled();
    emitBodyEvent!({
      type: "chunk",
      chunk: new TextEncoder().encode("first"),
    });

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first");
    expect(first.done).toBe(false);

    emitBodyEvent!({
      type: "chunk",
      chunk: new TextEncoder().encode(" second"),
    });
    emitBodyEvent!({ type: "end" });

    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe(" second");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
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
    expect(hostAbort).toHaveBeenCalledWith(expect.any(String));
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
    expect(hostAbort).toHaveBeenCalledWith(expect.any(String));
  });

  it("cancels an open host stream when the caller aborts", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", desktopWindow());
    hostFetch.mockImplementation(async (request) => ({
      url: request.url,
      status: 200,
      statusText: "OK",
      headers: [["content-type", "text/event-stream"]],
    }));
    const controller = new AbortController();
    await installDesktopFetch();

    const response = await globalThis.fetch(
      "http://127.0.0.1:3210/api/v1/runs/run-1/events",
      { signal: controller.signal },
    );
    const read = response.body!.getReader().read();
    controller.abort(new Error("caller canceled stream"));

    await expect(read).rejects.toThrow("caller canceled stream");
    expect(hostAbort).toHaveBeenCalledWith(expect.any(String));
  });
});
