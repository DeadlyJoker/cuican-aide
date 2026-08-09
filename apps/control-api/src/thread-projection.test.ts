import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadLifecycleEvent } from "@crewon/domain";

import { projectThreadEvent } from "./thread-projection.ts";

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
