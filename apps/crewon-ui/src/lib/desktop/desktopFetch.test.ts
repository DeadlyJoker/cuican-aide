import { DELIVERY_UPLOAD_BODY_BYTES } from "@crewon/domain/delivery-http-policy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrewonDesktopBridge } from "./desktopBridge";
import { desktopBridgeFetch, installDesktopFetch } from "./desktopFetch";
import {
  DESKTOP_HTTP_LIMITS as limits,
  DESKTOP_HTTP_VERSION,
} from "./desktopHttpProtocol";

const hostFetch = vi.fn<CrewonDesktopBridge["http"]["fetch"]>();
const hostRead = vi.fn<CrewonDesktopBridge["http"]["read"]>();
const hostAbort = vi.fn<CrewonDesktopBridge["http"]["abort"]>();
const responses: Response[] = [];
const url = "http://127.0.0.1:3210/api/v1/health";
function desktopWindow(version: number = DESKTOP_HTTP_VERSION) {
  return {
    location: { hostname: "127.0.0.1", protocol: "http:", search: "" },
    crewonDesktop: {
      version: 1,
      http: { version, fetch: hostFetch, read: hostRead, abort: hostAbort },
    },
  };
}
async function open(input: RequestInfo | URL = url, init?: RequestInit) {
  const response = await desktopBridgeFetch(input, init);
  responses.push(response);
  return response;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", desktopWindow());
  hostFetch.mockImplementation(async (request) => ({
    url: request.url,
    status: 200,
    statusText: "OK",
    headers: [["content-type", "text/event-stream"]],
  }));
  hostRead.mockResolvedValue({ type: "end" });
  hostAbort.mockResolvedValue();
});
afterEach(async () => {
  for (const response of responses.splice(0))
    if (response.body && !response.body.locked)
      await response.body.cancel().catch(() => {});
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("desktop HTTP fetch", () => {
  it("shares the prepared-body byte budget and releases it after failed handshakes", async () => {
    hostFetch.mockImplementation(() => new Promise(() => {}));
    const pending = Array.from({ length: 8 }, () =>
      open(url, {
        method: "POST",
        body: new Uint8Array(limits.requestBodyBytes),
      }).catch((error) => error),
    );
    await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(8));
    await expect(
      open(url, { method: "POST", body: Uint8Array.of(1) }),
    ).rejects.toThrow("desktop_http_capacity");
    expect(hostFetch).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(15000);
    expect(
      (await Promise.all(pending)).every(
        (error) => error instanceof Error && error.message.includes("15000ms"),
      ),
    ).toBe(true);
    hostFetch.mockImplementation(async (request) => ({
      url: request.url,
      status: 204,
      statusText: "No Content",
      headers: [],
    }));
    expect(
      (await open(url, { method: "POST", body: Uint8Array.of(1) })).status,
    ).toBe(204);
  });
  it("bounds fragmented request preparation and cancels the source on rejection", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(Uint8Array.of(1));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    await expect(
      open(
        new Request(url, {
          method: "POST",
          body,
          duplex: "half",
        } as RequestInit),
      ),
    ).rejects.toThrow("desktop_http_request_fragmentation");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(hostFetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects excessive headers before IPC serialization", async () => {
    await expect(
      open(url, { headers: { "x-large": "x".repeat(limits.headerBytes + 1) } }),
    ).rejects.toThrow("desktop_http_headers_too_large");
    expect(hostFetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("leaves fetch untouched on Web", async () => {
    const original = vi.fn();
    vi.stubGlobal("fetch", original);
    vi.stubGlobal("window", { location: { search: "" } });
    await installDesktopFetch();
    expect(fetch).toBe(original);
  });
  it("routes absolute desktop requests through the isolated host and preserves explicit Origin", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await installDesktopFetch();
    hostRead.mockResolvedValueOnce({
      type: "chunk",
      chunk: new TextEncoder().encode("from desktop"),
    });
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Origin: "http://crewon.localhost",
      },
    });
    expect(await response.text()).toBe("from desktop");
    expect(hostFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        url,
        method: "GET",
        headers: [
          ["accept", "application/json"],
          ["origin", "http://crewon.localhost"],
        ],
        body: null,
      }),
    );
  });
  it("keeps relative URLs on renderer fetch and does not wrap twice", async () => {
    const original = vi.fn(async () => new Response("web"));
    vi.stubGlobal("fetch", original);
    await installDesktopFetch();
    const patched = fetch;
    await installDesktopFetch();
    expect(fetch).toBe(patched);
    await fetch("/health");
    expect(original).toHaveBeenCalledWith(
      "/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(hostFetch).not.toHaveBeenCalled();
  });
  it("does not prefetch or accumulate unread response chunks", async () => {
    const response = await open();
    await Promise.resolve();
    expect(hostRead).not.toHaveBeenCalled();
    hostRead.mockResolvedValueOnce({
      type: "chunk",
      chunk: new TextEncoder().encode("first"),
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await Promise.resolve();
    expect(hostRead).toHaveBeenCalledTimes(1);
    hostRead.mockResolvedValueOnce({
      type: "chunk",
      chunk: new TextEncoder().encode(" second"),
    });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      " second",
    );
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
    expect(hostAbort).not.toHaveBeenCalled();
  });
  it("preserves UTF-8 bytes across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("中😀文");
    for (const byte of bytes)
      hostRead.mockResolvedValueOnce({
        type: "chunk",
        chunk: Uint8Array.of(byte),
      });
    expect(await (await open()).text()).toBe("中😀文");
  });
  it("bounds an IPC request that never settles", async () => {
    hostFetch.mockImplementation(() => new Promise(() => {}));
    const pending = expect(open()).rejects.toThrow("request exceeded 15000ms");
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(hostAbort).toHaveBeenCalledTimes(1);
  });
  it.each(["init", "request"])(
    "honors the %s caller abort during the handshake",
    async (source) => {
      hostFetch.mockImplementation(() => new Promise(() => {}));
      const controller = new AbortController();
      const pending =
        source === "init"
          ? open(url, { signal: controller.signal })
          : open(new Request(url, { signal: controller.signal }));
      const rejected = expect(pending).rejects.toThrow("caller canceled");
      await Promise.resolve();
      await Promise.resolve();
      controller.abort(new Error("caller canceled"));
      await rejected;
      expect(hostAbort).toHaveBeenCalledTimes(1);
    },
  );
  it("cancels an open host stream when the caller aborts and ignores a late read result", async () => {
    const controller = new AbortController();
    const response = await open(url, { signal: controller.signal });
    let done!: (part: { type: "end" }) => void;
    hostRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const reader = response.body!.getReader();
    const rejected = expect(reader.read()).rejects.toThrow(
      "caller canceled stream",
    );
    await Promise.resolve();
    controller.abort(new Error("caller canceled stream"));
    await rejected;
    done({ type: "end" });
    await Promise.resolve();
    reader.releaseLock();
    expect(hostAbort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps a pending SSE read alive while the server is quiet", async () => {
    const response = await open();
    let done!: (part: { type: "end" }) => void;
    hostRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const reader = response.body!.getReader();
    const read = reader.read();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120000);
    expect(hostAbort).not.toHaveBeenCalled();
    done({ type: "end" });
    expect((await read).done).toBe(true);
    reader.releaseLock();
  });
  it("expires an abandoned response without an upstream read", async () => {
    const response = await open();
    await vi.advanceTimersByTimeAsync(limits.consumerIdleMs);
    expect(hostRead).not.toHaveBeenCalled();
    await expect(response.text()).rejects.toThrow("desktop_http_consumer_idle");
    expect(hostAbort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shares admission across all callers and releases it on cancellation", async () => {
    const batch = await Promise.all(
      Array.from({ length: limits.readRequests }, () => open()),
    );
    await expect(open()).rejects.toThrow("desktop_http_capacity");
    expect(hostFetch).toHaveBeenCalledTimes(limits.readRequests);
    batch.push(
      ...(await Promise.all(
        Array.from(
          { length: limits.activeRequests - limits.readRequests },
          () => open(url, { method: "POST" }),
        ),
      )),
    );
    await expect(open(url, { method: "POST" })).rejects.toThrow(
      "desktop_http_capacity",
    );
    expect(hostFetch).toHaveBeenCalledTimes(limits.activeRequests);
    for (const response of batch) await response.body!.cancel();
    expect(await (await open()).text()).toBe("");
  });
  it("rejects oversized request bodies before sending and cancels body preparation", async () => {
    await expect(
      open(url, {
        method: "POST",
        body: new Uint8Array(limits.requestBodyBytes + 1),
      }),
    ).rejects.toThrow("desktop_http_request_too_large");
    expect(hostFetch).not.toHaveBeenCalled();
    const cancel = vi.fn();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const pending = open(
      new Request(url, { method: "POST", body, duplex: "half" } as RequestInit),
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toThrow("stop preparing");
    await Promise.resolve();
    controller.abort(new Error("stop preparing"));
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(hostFetch).not.toHaveBeenCalled();
  });
  it("preserves binary request bytes and releases body quota after the handshake", async () => {
    await (
      await open(url, { method: "POST", body: Uint8Array.of(0, 255, 31) })
    ).body!.cancel();
    expect(hostFetch.mock.calls[0]![0].body).toEqual(Uint8Array.of(0, 255, 31));
  });
  it("does not read bodyless responses and clears all timers", async () => {
    hostFetch.mockImplementationOnce(async (request) => ({
      url: request.url,
      status: 204,
      statusText: "No Content",
      headers: [],
    }));
    expect((await open()).body).toBeNull();
    expect(hostRead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("propagates read failures and rejects malformed oversized chunks", async () => {
    hostRead.mockRejectedValueOnce(new Error("broken stream"));
    await expect((await open()).text()).rejects.toThrow("broken stream");
    hostRead.mockResolvedValueOnce({
      type: "chunk",
      chunk: new Uint8Array(limits.chunkBytes + 1),
    });
    await expect((await open()).text()).rejects.toThrow(
      "desktop_http_chunk_invalid",
    );
    expect(hostAbort).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("fails closed for an older push bridge before any request starts", async () => {
    vi.stubGlobal("window", desktopWindow(1));
    await expect(open()).rejects.toThrow("desktop_http_version_incompatible");
    expect(hostFetch).not.toHaveBeenCalled();
  });
});

describe("delivery upload request budget", () => {
  const upload =
    "http://127.0.0.1:3210/api/v1/threads/thread_1/delivery/inputs";
  it("prepares the complete large CSV envelope only on the exact upload route", async () => {
    const body = JSON.stringify({
      contentBase64: btoa("a".repeat(10 * 1024 * 1024)),
    });
    await open(upload, { method: "POST", body });
    expect(hostFetch.mock.calls[0][0].body?.byteLength).toBe(
      new TextEncoder().encode(body).byteLength,
    );
    for (const target of [upload + "?x=1", upload + "/", url])
      await expect(open(target, { method: "POST", body })).rejects.toThrow(
        "desktop_http_request_too_large",
      );
    await expect(
      open(upload, {
        method: "POST",
        body: new Uint8Array(DELIVERY_UPLOAD_BODY_BYTES + 1),
      }),
    ).rejects.toThrow("desktop_http_request_too_large");
  });
  it("a large upload consumes the existing global 16 MiB budget and releases it after failure", async () => {
    hostFetch.mockImplementation(() => new Promise(() => {}));
    const first = open(upload, {
      method: "POST",
      body: new Uint8Array(13 * 1024 * 1024),
    }).catch((error) => error);
    await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(1));
    await expect(
      open(upload, { method: "POST", body: new Uint8Array(4 * 1024 * 1024) }),
    ).rejects.toThrow("desktop_http_capacity");
    await vi.advanceTimersByTimeAsync(15000);
    expect(await first).toBeInstanceOf(Error);
    hostFetch.mockImplementation(async (request) => ({
      url: request.url,
      status: 204,
      statusText: "No Content",
      headers: [],
    }));
    expect(
      (
        await open(upload, {
          method: "POST",
          body: new Uint8Array(13 * 1024 * 1024),
        })
      ).status,
    ).toBe(204);
  });
});
