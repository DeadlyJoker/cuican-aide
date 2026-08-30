import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadLifecycleEvent, ThreadState } from "@crewon/domain";

import {
  projectThreadEvent,
  projectThreadSnapshot,
} from "./thread-projection.ts";

test("projects the Thread and its SSE cursor from one canonical state", () => {
  const state: ThreadState = {
    threadId: "thread-1",
    tenantId: "tenant-secret",
    spaceId: "space-secret",
    createdByActorId: "actor-secret",
    title: "Thread",
    status: "active",
    revision: 4,
    lastEventSequence: 4,
    lastMessageSequence: 2,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:04Z",
    archivedAt: null,
    deletedAt: null,
    deletedByActorId: null,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
  };

  assert.deepEqual(projectThreadSnapshot(state), {
    thread: {
      threadId: "thread-1",
      title: "Thread",
      status: "active",
      revision: 4,
      lastMessageSequence: 2,
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:04Z",
      archivedAt: null,
      deletedAt: null,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
    },
    eventSequence: 4,
  });
  assert.throws(
    () => projectThreadSnapshot({ ...state, lastEventSequence: 3 }),
    /thread_snapshot_event_sequence_invalid/u,
  );
});

test("projects a redacted public rollback event", () => {
  const projected = projectThreadEvent(rolledBackEvent());

  assert.deepEqual(projected, {
    threadId: "thread-1",
    eventId: "thread-event-2",
    sequence: 2,
    occurredAt: "2026-08-09T00:00:02Z",
    type: "thread.rolled_back",
    requestedTurns: 3,
    removedTurns: 2,
  });
  for (const forbidden of [
    "schemaVersion",
    "actorId",
    "rollbackId",
    "markerItemId",
    "historyFromSequence",
    "historyThroughSequence",
    "markerHistorySequence",
    "tenantId",
  ]) {
    assert.equal(forbidden in projected, false);
  }
});

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
