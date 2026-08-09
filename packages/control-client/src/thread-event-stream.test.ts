import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { streamThreadEvents } from "./thread-event-stream.ts";

test("parses redacted rollback delivery and preserves Last-Event-ID continuity", async () => {
  const requests: { input: string; headers: Headers }[] = [];
  const payload = [frame(rolledBackEvent()), frame(renamedEvent())]
    .join("")
    .replaceAll("\n", "\r\n");
  const bytes = new TextEncoder().encode(payload);
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    accessToken: "thread-event-token",
    fetch: async (input, init = {}) => {
      requests.push({
        input: String(input),
        headers: new Headers(init.headers),
      });
      return new Response(fragmentedStream(bytes, [1, 11, 37, 101]), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });

  const events = [];
  for await (const event of streamThreadEvents(client, {
    threadId: "thread/1",
    afterSequence: 1,
    view: "audit",
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [rolledBackEvent(), renamedEvent()]);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.input,
    "https://control.example/api/v1/threads/thread%2F1/events?view=audit",
  );
  assert.equal(requests[0]?.headers.get("last-event-id"), "1");
  assert.equal(
    requests[0]?.headers.get("authorization"),
    "Bearer thread-event-token",
  );
});

test("rejects private or cross-shaped rollback delivery fields", async (t) => {
  for (const [name, value] of [
    ["schema version", "crewon.thread-event.v0"],
    ["tenant", "tenant-secret"],
    ["actor", "actor-secret"],
    ["rollback marker", "marker-secret"],
    ["raw history start", 3],
    ["raw history end", 9],
  ] as const) {
    await t.test(name, async () => {
      const field = {
        "schema version": "schemaVersion",
        "tenant": "tenantId",
        "actor": "actorId",
        "rollback marker": "markerItemId",
        "raw history start": "historyFromSequence",
        "raw history end": "historyThroughSequence",
      }[name];
      const client = threadEventStreamClient(
        frame({ ...rolledBackEvent(), [field]: value }),
      );

      await assert.rejects(async () => {
        for await (const _event of streamThreadEvents(client, {
          threadId: "thread/1",
          afterSequence: 1,
        })) {
          assert.fail("private rollback event must not be yielded");
        }
      }, hasProtocolCode("control_client_thread_event_invalid"));
    });
  }
});

test("rejects cross-thread events and gaps after Last-Event-ID", async () => {
  const crossThread = threadEventStreamClient(
    frame({ ...rolledBackEvent(), threadId: "thread-2" }),
  );
  await assert.rejects(async () => {
    for await (const _event of streamThreadEvents(crossThread, {
      threadId: "thread/1",
      afterSequence: 1,
    })) {
      assert.fail("cross-thread event must not be yielded");
    }
  }, hasProtocolCode("control_client_thread_event_thread_mismatch"));

  const gap = threadEventStreamClient(
    frame({
      ...renamedEvent(),
      eventId: "thread-event-3",
      sequence: 3,
    }),
  );
  await assert.rejects(async () => {
    for await (const _event of streamThreadEvents(gap, {
      threadId: "thread/1",
      afterSequence: 1,
    })) {
      assert.fail("non-contiguous event must not be yielded");
    }
  }, hasProtocolCode("control_client_thread_event_sequence_invalid"));
});

function rolledBackEvent() {
  return {
    threadId: "thread/1",
    eventId: "thread-event-2",
    sequence: 2,
    occurredAt: "2026-08-09T00:00:02Z",
    type: "thread.rolled_back" as const,
    requestedTurns: 3,
    removedTurns: 2,
  };
}

function renamedEvent() {
  return {
    schemaVersion: "crewon.thread-event.v0" as const,
    threadId: "thread/1",
    eventId: "thread-event-3",
    sequence: 3,
    occurredAt: "2026-08-09T00:00:03Z",
    type: "thread.renamed" as const,
  };
}

function threadEventStreamClient(payload: string): ControlApiClient {
  return new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(payload, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
}

function frame<T extends Readonly<{ sequence: number; type: string }>>(
  event: T,
): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
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
