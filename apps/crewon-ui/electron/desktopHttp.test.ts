import { DELIVERY_UPLOAD_BODY_BYTES } from "@crewon/domain/delivery-http-policy";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHttpTransport } from "./desktopHttp.ts";
import { bindDesktopHttpLifetime } from "./desktopHttpLifetime.ts";
import { desktopHttpReply } from "./desktopHttpReply.ts";
import { DESKTOP_HTTP_LIMITS as limits } from "../src/lib/desktop/desktopHttpProtocol.ts";
import type { DesktopHttpRequest } from "../src/lib/desktop/desktopBridge.ts";

let id = 0;
const request = (
  changes: Partial<DesktopHttpRequest> = {},
): DesktopHttpRequest => ({
  requestId: `019d0000-0000-7000-8000-${String(++id).padStart(12, "0")}`,
  url: "http://127.0.0.1:3210/events",
  method: "GET",
  headers: [],
  body: null,
  ...changes,
});
const owners: DesktopHttpTransport[] = [];
function owner(
  options?: ConstructorParameters<typeof DesktopHttpTransport>[0],
) {
  const transport = new DesktopHttpTransport(options);
  owners.push(transport);
  return transport;
}
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
afterEach(async () => {
  for (const t of owners) t.close();
  await tick();
  for (const t of owners)
    expect(t.usage).toMatchObject({
      activeRequests: 0,
      globalActiveRequests: 0,
      globalRequestBytes: 0,
    });
  owners.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function byteResponse(
  total: number,
  options: { events?: boolean; cancel?: () => void; read?: () => void } = {},
) {
  let remaining = total;
  return new Response(
    new ReadableStream({
      type: "bytes",
      pull(controller) {
        options.read?.();
        const byob = controller.byobRequest!;
        const bytes = Math.min(remaining, byob.view!.byteLength);
        new Uint8Array(byob.view!.buffer, byob.view!.byteOffset, bytes).fill(
          37,
        );
        remaining -= bytes;
        if (bytes) byob.respond(bytes);
        if (!remaining) {
          controller.close();
          if (!bytes) byob.respond(0);
        }
      },
      cancel: options.cancel,
    }),
    {
      headers: options.events
        ? { "content-type": "text/event-stream" }
        : undefined,
    },
  );
}

describe("desktop HTTP pull transport", () => {
  it("returns bounded wire errors for expected cancellation without exposing native diagnostics", async () => {
    expect(
      await desktopHttpReply(() => {
        throw new Error("desktop_http_request_aborted");
      }),
    ).toEqual({ ok: false, error: "desktop_http_request_aborted" });
    expect(
      await desktopHttpReply(() => {
        throw new Error("socket diagnostics with private headers");
      }),
    ).toEqual({ ok: false, error: "desktop_http_transport_failed" });
    expect(await desktopHttpReply(() => 42)).toEqual({ ok: true, value: 42 });
  });
  it("returns metadata without pulling, then forwards bounded byte chunks before stream end", async () => {
    const pull = vi.fn(),
      cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => byteResponse(100000, { read: pull, cancel })),
    );
    const transport = owner(),
      input = request();
    expect((await transport.fetch(input)).status).toBe(200);
    expect(pull).not.toHaveBeenCalled();
    expect(transport.usage.activeRequests).toBe(1);
    const first = await transport.read(input.requestId);
    expect(first.type).toBe("chunk");
    if (first.type === "chunk") {
      expect(first.chunk.byteLength).toBe(limits.chunkBytes);
      expect(first.chunk.buffer.byteLength).toBe(first.chunk.byteLength);
    }
    expect(pull).toHaveBeenCalledTimes(1);
    await tick();
    expect(pull).toHaveBeenCalledTimes(1);
    const second = await transport.read(input.requestId);
    if (second.type !== "chunk") throw Error("missing second chunk");
    expect(second.chunk.byteLength).toBe(100000 - limits.chunkBytes);
    expect(await transport.read(input.requestId)).toEqual({ type: "end" });
    expect(transport.usage.activeRequests).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });
  it("uses smaller SSE buffers and clones only actual bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        byteResponse(limits.eventChunkBytes + 3, { events: true }),
      ),
    );
    const transport = owner(),
      input = request();
    await transport.fetch(input);
    const first = await transport.read(input.requestId);
    if (first.type !== "chunk") throw Error();
    expect(first.chunk.byteLength).toBe(limits.eventChunkBytes);
    const last = await transport.read(input.requestId);
    if (last.type !== "chunk") throw Error();
    expect(last.chunk.buffer.byteLength).toBe(3);
    expect(await transport.read(input.requestId)).toEqual({ type: "end" });
  });
  it("shares capacity across owners and never starts excess network requests", async () => {
    const fetch = vi.fn(async () => byteResponse(1));
    vi.stubGlobal("fetch", fetch);
    const first = owner(),
      second = owner();
    await Promise.all(
      Array.from({ length: limits.readRequests }, (_, i) =>
        (i % 2 ? first : second).fetch(request()),
      ),
    );
    await expect(owner().fetch(request())).rejects.toThrow(
      "desktop_http_capacity",
    );
    expect(fetch).toHaveBeenCalledTimes(limits.readRequests);
    await Promise.all(
      Array.from({ length: limits.activeRequests - limits.readRequests }, () =>
        first.fetch(request({ method: "POST" })),
      ),
    );
    await expect(second.fetch(request({ method: "POST" }))).rejects.toThrow(
      "desktop_http_capacity",
    );
    expect(fetch).toHaveBeenCalledTimes(limits.activeRequests);
    first.close();
    second.close();
    await tick();
    expect(await owner().fetch(request())).toMatchObject({ status: 200 });
  });
  it("holds request bytes and admission until an aborted native handshake physically settles", async () => {
    const finish: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => finish.push(resolve))),
    );
    const transport = owner();
    const inputs = Array.from({ length: 8 }, () =>
      request({
        method: "POST",
        body: new Uint8Array(limits.requestBodyBytes),
      }),
    );
    const pending = inputs.map((input) =>
      transport.fetch(input).catch((error) => error),
    );
    await expect(
      owner().fetch(request({ method: "POST", body: Uint8Array.of(1) })),
    ).rejects.toThrow("desktop_http_capacity");
    for (const input of inputs) transport.abort(input.requestId);
    expect(transport.usage).toMatchObject({
      activeRequests: 8,
      globalRequestBytes: limits.requestBytes,
    });
    for (const resolve of finish) resolve(new Response(null));
    expect(
      (await Promise.all(pending)).every((error) => error instanceof Error),
    ).toBe(true);
    expect(transport.usage).toMatchObject({
      activeRequests: 0,
      globalRequestBytes: 0,
    });
  });
  it("times out the handshake and cancels a late response without releasing capacity early", async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    const cancel = vi.fn();
    let signal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options) => {
        signal = options.signal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const transport = owner(),
      input = request();
    const pending = expect(transport.fetch(input)).rejects.toThrow(
      "desktop_http_response_timeout",
    );
    await vi.advanceTimersByTimeAsync(limits.handshakeMs);
    expect(signal.aborted).toBe(true);
    expect(transport.usage.activeRequests).toBe(1);
    finish(byteResponse(10, { cancel }));
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport.usage.activeRequests).toBe(0);
  });
  it("rejects concurrent reads and cancels a pending read exactly once", async () => {
    let cancelDone!: () => void;
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          cancelDone = resolve;
        }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new ReadableStream({ type: "bytes", cancel })),
      ),
    );
    const transport = owner(),
      input = request();
    await transport.fetch(input);
    const pending = expect(transport.read(input.requestId)).rejects.toThrow(
      "desktop_http_request_aborted",
    );
    await expect(transport.read(input.requestId)).rejects.toThrow(
      "desktop_http_read_conflict",
    );
    transport.abort(input.requestId);
    transport.abort(input.requestId);
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport.usage.activeRequests).toBe(1);
    cancelDone();
    await tick();
    expect(transport.usage.activeRequests).toBe(0);
  });
  it("expires unread responses but keeps pending SSE reads alive", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ type: "bytes", cancel }), {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const transport = owner({ consumerIdleMs: 1000 }),
      input = request();
    await transport.fetch(input);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport.usage.activeRequests).toBe(0);
    const next = request();
    await transport.fetch(next);
    const pending = expect(transport.read(next.requestId)).rejects.toThrow(
      "desktop_http_request_aborted",
    );
    await vi.advanceTimersByTimeAsync(120000);
    expect(transport.usage.activeRequests).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    transport.abort(next.requestId);
    await pending;
    await tick();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves the total response cap without retaining a whole response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => byteResponse(limits.responseBytes + 1)),
    );
    const transport = owner(),
      input = request();
    await transport.fetch(input);
    let bytes = 0;
    for (let i = 0; i < limits.responseBytes / limits.chunkBytes; i++) {
      const part = await transport.read(input.requestId);
      if (part.type !== "chunk") throw Error();
      bytes += part.chunk.byteLength;
    }
    expect(bytes).toBe(limits.responseBytes);
    await expect(transport.read(input.requestId)).rejects.toThrow(
      "desktop_http_response_too_large",
    );
    await tick();
    expect(transport.usage.activeRequests).toBe(0);
  });
  it("validates host boundaries before network access and preserves request bytes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null),
    );
    vi.stubGlobal("fetch", fetch);
    const transport = owner();
    for (const input of [
      request({ url: "https://example.com" }),
      request({ url: "http://user:pass@localhost" }),
      request({ body: new Uint8Array(limits.requestBodyBytes + 1) }),
      request({ headers: [["x", "x".repeat(limits.headerBytes + 1)]] }),
    ])
      await expect(transport.fetch(input)).rejects.toThrow(/desktop_http_/);
    expect(fetch).not.toHaveBeenCalled();
    const input = request({ method: "POST", body: Uint8Array.of(0, 255, 12) });
    await transport.fetch(input);
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      body: Uint8Array.of(0, 255, 12),
      redirect: "error",
    });
    expect(await transport.read(input.requestId)).toEqual({ type: "end" });
  });
  it("finishes bodyless statuses and releases failed handshakes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const transport = owner();
    for (const status of [204, 205, 304]) {
      fetch.mockResolvedValueOnce(new Response(null, { status }));
      await transport.fetch(request());
      expect(transport.usage.activeRequests).toBe(0);
    }
    fetch.mockRejectedValueOnce(new Error("network failed"));
    await expect(transport.fetch(request())).rejects.toThrow("network failed");
    expect(transport.usage.activeRequests).toBe(0);
  });
  it("closes ownership on reload, renderer loss and destruction, but not subframes or hash navigation", async () => {
    const contents = new EventEmitter(),
      close = vi.fn();
    bindDesktopHttpLifetime(
      contents as unknown as WebContents,
      { close } as unknown as DesktopHttpTransport,
    );
    contents.emit("did-start-navigation", {
      isMainFrame: false,
      isSameDocument: false,
    });
    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true,
    });
    expect(close).not.toHaveBeenCalled();
    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    contents.emit("render-process-gone");
    contents.emit("destroyed");
    expect(close).toHaveBeenCalledTimes(3);
    expect(contents.eventNames()).toEqual([]);
  });
});

describe("delivery host upload admission", () => {
  const upload =
    "http://127.0.0.1:3210/api/v1/threads/thread_1/delivery/inputs";
  it("validates the larger upload by route on the host and preserves default limits elsewhere", async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", upstream);
    const transport = owner();
    const body = new Uint8Array(DELIVERY_UPLOAD_BODY_BYTES);
    expect(
      (await transport.fetch(request({ url: upload, method: "POST", body })))
        .status,
    ).toBe(204);
    expect(upstream.mock.calls.length).toBe(1);
    for (const url of [
      upload + "?x=1",
      upload + "/",
      upload.replace("inputs", "assemble"),
    ])
      await expect(
        transport.fetch(request({ url, method: "POST", body })),
      ).rejects.toThrow("desktop_http_request_too_large");
    await expect(
      transport.fetch(
        request({
          url: upload,
          method: "POST",
          body: new Uint8Array(DELIVERY_UPLOAD_BODY_BYTES + 1),
        }),
      ),
    ).rejects.toThrow("desktop_http_request_too_large");
  });
  it("holds a large upload in the shared byte budget until an aborted native handshake settles", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const transport = owner();
    const first = request({
      url: upload,
      method: "POST",
      body: new Uint8Array(13 * 1024 * 1024),
    });
    const pending = transport.fetch(first).catch((error) => error);
    await expect(
      owner().fetch(
        request({
          url: upload,
          method: "POST",
          body: new Uint8Array(4 * 1024 * 1024),
        }),
      ),
    ).rejects.toThrow("desktop_http_capacity");
    transport.abort(first.requestId);
    expect(transport.usage.globalRequestBytes).toBe(13 * 1024 * 1024);
    finish(new Response(null, { status: 204 }));
    expect(await pending).toBeInstanceOf(Error);
    expect(transport.usage.globalRequestBytes).toBe(0);
  });
});
