import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopHttpBodyEvent,
  DesktopHttpRequest,
} from "../src/lib/desktop/desktopBridge.ts";
import { desktopFetch } from "./desktopHttp.ts";

const request: DesktopHttpRequest = {
  requestId: "019d0000-0000-7000-8000-000000000001",
  url: "http://127.0.0.1:3210/api/v1/runs/run-1/events",
  method: "GET",
  headers: [["accept", "text/event-stream"]],
  body: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktopFetch", () => {
  it("returns response metadata while forwarding the open body by chunk", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => upstream),
    );
    const activeRequests = new Map<string, AbortController>();
    const events: DesktopHttpBodyEvent[] = [];

    const head = await desktopFetch(request, {
      activeRequests,
      emit: (_requestId, event) => events.push(event),
    });

    expect(head.status).toBe(200);
    expect(activeRequests.has(request.requestId)).toBe(true);
    expect(events).toEqual([]);

    bodyController!.enqueue(new TextEncoder().encode("first"));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      type: "chunk",
      chunk: new TextEncoder().encode("first"),
    });
    expect(events.some((event) => event.type === "end")).toBe(false);

    bodyController!.close();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "end" }));
    expect(activeRequests.has(request.requestId)).toBe(false);
  });
});
