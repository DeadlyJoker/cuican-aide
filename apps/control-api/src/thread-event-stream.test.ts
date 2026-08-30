import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";

import type { ThreadLifecycleEvent } from "@crewon/domain";

import { writeThreadSseEvent } from "./thread-event-stream.ts";

test("waits for drain without dropping or leaking a backpressured Thread event", async () => {
  const response = new BackpressuredResponse();
  const controller = new AbortController();
  let settled = false;
  const pending = writeThreadSseEvent(
    response as unknown as ServerResponse,
    archivedEvent(),
    controller.signal,
  ).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(response.chunks.length, 1);
  assert.equal(response.chunks[0]?.includes("actor-1"), false);
  assert.match(response.chunks[0] ?? "", /^id: 2\nevent: thread\.archived\n/);

  response.writableNeedDrain = false;
  response.emit("drain");
  assert.equal(await pending, true);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("error"), 0);
});

test("delivers a redacted rollback without breaking durable event IDs", async () => {
  const response = new RecordingResponse();
  const signal = new AbortController().signal;

  assert.equal(
    await writeThreadSseEvent(
      response as unknown as ServerResponse,
      rolledBackEvent(),
      signal,
    ),
    true,
  );
  assert.equal(
    await writeThreadSseEvent(
      response as unknown as ServerResponse,
      renamedEvent(),
      signal,
    ),
    true,
  );

  assert.deepEqual(
    response.chunks.map((chunk) => {
      const [id, event, data] = chunk.trim().split("\n");
      return {
        id,
        event,
        data: JSON.parse(data?.slice("data: ".length) ?? "null"),
      };
    }),
    [
      {
        id: "id: 2",
        event: "event: thread.rolled_back",
        data: {
          threadId: "thread-1",
          eventId: "thread-event-2",
          sequence: 2,
          occurredAt: "2026-08-09T00:00:02Z",
          type: "thread.rolled_back",
          requestedTurns: 3,
          removedTurns: 2,
        },
      },
      {
        id: "id: 3",
        event: "event: thread.renamed",
        data: {
          schemaVersion: "crewon.thread-event.v0",
          threadId: "thread-1",
          eventId: "thread-event-3",
          sequence: 3,
          occurredAt: "2026-08-09T00:00:03Z",
          type: "thread.renamed",
        },
      },
    ],
  );
});

class BackpressuredResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = true;
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return false;
  }
}

class RecordingResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

function archivedEvent(): ThreadLifecycleEvent {
  return {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: "thread-event-2",
    sequence: 2,
    occurredAt: "2026-08-09T00:00:01Z",
    type: "thread.archived",
    data: { actorId: "actor-1" },
  };
}

function rolledBackEvent(): ThreadLifecycleEvent {
  return {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: "thread-event-2",
    sequence: 2,
    occurredAt: "2026-08-09T00:00:02Z",
    type: "thread.rolled_back",
    data: {
      actorId: "actor-secret",
      rollbackId: "rollback-secret",
      markerItemId: "marker-secret",
      requestedTurns: 3,
      removedTurns: 2,
      historyFromSequence: 4,
      historyThroughSequence: 10,
      markerHistorySequence: 11,
    },
  };
}

function renamedEvent(): ThreadLifecycleEvent {
  return {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: "thread-event-3",
    sequence: 3,
    occurredAt: "2026-08-09T00:00:03Z",
    type: "thread.renamed",
    data: { actorId: "actor-secret", title: "Renamed" },
  };
}
