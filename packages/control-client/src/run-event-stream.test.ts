import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { streamRunEvents } from "./run-event-stream.ts";

test("parses fragmented CRLF SSE and preserves the durable sequence cursor", async () => {
  const requests: { input: string; headers: Headers }[] = [];
  const payload = [
    ": heartbeat\r\n\r\n",
    "id: 2\r\nevent: run.started\r\ndata: ",
    JSON.stringify(runStartedEvent()),
    "\r\n\r\n",
  ].join("");
  const bytes = new TextEncoder().encode(payload);
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    accessToken: "token-1",
    fetch: async (input, init = {}) => {
      requests.push({
        input: String(input),
        headers: new Headers(init.headers),
      });
      return new Response(fragmentedStream(bytes, [1, 7, 13, 29]), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });

  const events = [];
  for await (const event of streamRunEvents(client, {
    runId: "run/1",
    afterSequence: 1,
    view: "audit",
  })) {
    events.push(event);
  }
  assert.deepEqual(events, [runStartedEvent()]);
  assert.equal(
    requests[0]?.input,
    "https://control.example/api/v1/runs/run%2F1/events?view=audit",
  );
  assert.equal(requests[0]?.headers.get("last-event-id"), "1");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer token-1");
});

test("rejects an SSE identity mismatch without yielding remote data", async () => {
  const event = { ...runStartedEvent(), runId: "run-1" };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(
        `id: 3\nevent: run.started\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  });

  await assert.rejects(async () => {
    for await (const _event of streamRunEvents(client, { runId: "run-1" })) {
      assert.fail("mismatched event must not be yielded");
    }
  }, hasProtocolCode("control_client_event_identity_mismatch"));
});

test("rejects a cross-Run event before yielding remote data", async () => {
  const event = { ...runStartedEvent(), runId: "run-other" };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(
        `id: 2\nevent: run.started\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  });

  await assert.rejects(async () => {
    for await (const _event of streamRunEvents(client, { runId: "run/1" })) {
      assert.fail("cross-Run event must not be yielded");
    }
  }, hasProtocolCode("control_client_event_invalid"));
});

test("rejects malformed discriminated event data before yielding", async () => {
  const event = { ...runStartedEvent(), data: { injected: true } };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(
        `id: 2\nevent: run.started\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  });

  await assert.rejects(async () => {
    for await (const _event of streamRunEvents(client, { runId: "run/1" })) {
      assert.fail("malformed event must not be yielded");
    }
  }, hasProtocolCode("control_client_event_invalid"));
});

test("accepts the content-free durable Plan proposal event", async () => {
  const event = {
    eventId: "event-7",
    runId: "run-1",
    sequence: 7,
    occurredAt: "2026-08-09T00:00:07Z",
    type: "plan.proposed" as const,
    data: {
      planId: "plan-1",
      messageId: "message-1",
      messageSequence: 2,
    },
  };
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(
        `id: 7\nevent: plan.proposed\ndata: ${JSON.stringify(event)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  });

  const events = [];
  for await (const received of streamRunEvents(client, { runId: "run-1" })) {
    events.push(received);
  }
  assert.deepEqual(events, [event]);
  assert.equal("content" in events[0]!.data, false);
});

function runStartedEvent() {
  return {
    eventId: "event-2",
    runId: "run/1",
    sequence: 2,
    occurredAt: "2026-08-09T00:00:02Z",
    type: "run.started" as const,
    data: {},
  };
}

function fragmentedStream(
  bytes: Uint8Array,
  boundaries: readonly number[],
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      for (const boundary of boundaries) {
        controller.enqueue(bytes.slice(offset, boundary));
        offset = boundary;
      }
      controller.enqueue(bytes.slice(offset));
      controller.close();
    },
  });
}

function hasProtocolCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ControlApiProtocolError && error.code === code;
}
