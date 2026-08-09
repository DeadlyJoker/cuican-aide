import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_THREAD_GOAL_EVENT_BYTES,
  ThreadGoalEventError,
  projectPublicThreadGoalEvent,
  reduceThreadGoalEvent,
  replayThreadGoalEvents,
  validateThreadGoalEvent,
  validateThreadGoalEventPageBoundary,
  type ThreadGoalEvent,
} from "./thread-goal-event.ts";
import type { ThreadGoal } from "./thread-goal.ts";

test("replays an independent Goal event sequence through update and clear", () => {
  const events = [updatedEvent(1, goal(7, 1)), updatedEvent(2, goal(8, 2))];
  const updated = replayThreadGoalEvents(events);
  const cleared = reduceThreadGoalEvent(updated, clearedEvent(3, "goal-1", 8));

  assert.deepEqual(cleared, {
    tenantId: "tenant-1",
    threadId: "thread-1",
    lastSequence: 3,
    lastEventId: "goal-event-3",
    currentGoal: null,
    latestGoalId: "goal-1",
    latestGoalRevision: 8,
    updatedAt: timestamp(3),
  });

  const projected = projectPublicThreadGoalEvent(events[1]!);
  assert.deepEqual(projected, {
    schemaVersion: "crewon.thread-goal-event.v0",
    threadId: "thread-1",
    eventId: "goal-event-2",
    sequence: 2,
    occurredAt: timestamp(2),
    type: "goal.updated",
    data: {
      goal: {
        threadId: "thread-1",
        goalId: "goal-1",
        revision: 8,
        objective: "finish the migration",
        status: "active",
        tokenBudget: 100,
        tokensUsed: 2,
        timeUsedSeconds: 2,
        createdAt: timestamp(1),
        updatedAt: timestamp(2),
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(projected), /tenantId/);
});

test("enforces reducer and catch-up page sequence plus tenant/thread scope", () => {
  const state = reduceThreadGoalEvent(null, updatedEvent(1, goal(7, 1)));
  assert.throws(
    () => reduceThreadGoalEvent(state, updatedEvent(3, goal(8, 3))),
    hasCode("goal_event_sequence_gap"),
  );
  assert.throws(
    () =>
      reduceThreadGoalEvent(state, {
        ...updatedEvent(2, goal(8, 2)),
        tenantId: "tenant-other",
        data: { goal: { ...goal(8, 2), tenantId: "tenant-other" } },
      }),
    hasCode("goal_event_tenant_mismatch"),
  );
  assert.throws(
    () =>
      reduceThreadGoalEvent(state, {
        ...updatedEvent(2, goal(8, 2)),
        threadId: "thread-other",
        data: { goal: { ...goal(8, 2), threadId: "thread-other" } },
      }),
    hasCode("goal_event_thread_mismatch"),
  );

  const page = [updatedEvent(11, goal(20, 11)), clearedEvent(12, "goal-1", 20)];
  assert.doesNotThrow(() =>
    validateThreadGoalEventPageBoundary(page, {
      tenantId: "tenant-1",
      threadId: "thread-1",
      afterSequence: 10,
    }),
  );
  assert.throws(
    () =>
      validateThreadGoalEventPageBoundary([page[1]!], {
        tenantId: "tenant-1",
        threadId: "thread-1",
        afterSequence: 10,
      }),
    hasCode("goal_event_page_sequence_gap"),
  );
});

test("requires a complete scope-consistent Goal snapshot", () => {
  assert.throws(
    () =>
      validateThreadGoalEvent({
        ...updatedEvent(1, goal(7, 1)),
        data: { goal: { ...goal(7, 1), tenantId: "tenant-other" } },
      }),
    hasCode("goal_event_snapshot_mismatch"),
  );
  assert.throws(
    () =>
      validateThreadGoalEvent({
        ...updatedEvent(1, goal(7, 1)),
        data: { goal: { ...goal(7, 1), updatedAt: timestamp(2) } },
      }),
    hasCode("goal_event_snapshot_mismatch"),
  );

  const state = reduceThreadGoalEvent(null, updatedEvent(1, goal(7, 1)));
  assert.throws(
    () => reduceThreadGoalEvent(state, updatedEvent(2, goal(9, 2))),
    hasCode("goal_event_snapshot_progress_invalid"),
  );
});

test("binds clear to the exact previously visible Goal identity", () => {
  const state = reduceThreadGoalEvent(null, updatedEvent(1, goal(7, 1)));
  assert.throws(
    () => reduceThreadGoalEvent(state, clearedEvent(2, "goal-other", 7)),
    hasCode("goal_event_clear_identity_mismatch"),
  );
  assert.throws(
    () => reduceThreadGoalEvent(state, clearedEvent(2, "goal-1", 6)),
    hasCode("goal_event_clear_identity_mismatch"),
  );
});

test("rejects extra fields at every trust boundary and oversized events", () => {
  assert.throws(
    () =>
      validateThreadGoalEvent({ ...updatedEvent(1, goal(7, 1)), admin: true }),
    hasCode("goal_event_envelope_invalid"),
  );
  assert.throws(
    () =>
      validateThreadGoalEvent({
        ...updatedEvent(1, goal(7, 1)),
        data: { goal: goal(7, 1), secret: "leak" },
      }),
    hasCode("goal_event_updated_data_invalid"),
  );
  assert.throws(
    () =>
      validateThreadGoalEvent({
        ...updatedEvent(1, goal(7, 1)),
        data: { goal: { ...goal(7, 1), injected: "value" } },
      }),
    hasCode("goal_event_snapshot_invalid"),
  );
  assert.throws(
    () =>
      validateThreadGoalEvent({
        ...updatedEvent(1, goal(7, 1)),
        eventId: "x".repeat(MAX_THREAD_GOAL_EVENT_BYTES),
      }),
    hasCode("goal_event_too_large"),
  );
});

function updatedEvent(
  sequence: number,
  snapshot: ThreadGoal,
): Extract<ThreadGoalEvent, { type: "goal.updated" }> {
  return {
    ...base(sequence),
    type: "goal.updated",
    data: { goal: snapshot },
  };
}

function clearedEvent(
  sequence: number,
  previousGoalId: string,
  previousRevision: number,
): Extract<ThreadGoalEvent, { type: "goal.cleared" }> {
  return {
    ...base(sequence),
    type: "goal.cleared",
    data: { previousGoalId, previousRevision },
  };
}

function base(sequence: number) {
  return {
    schemaVersion: "crewon.thread-goal-event.v0" as const,
    tenantId: "tenant-1",
    threadId: "thread-1",
    eventId: `goal-event-${sequence}`,
    sequence,
    occurredAt: timestamp(sequence),
  };
}

function goal(revision: number, eventSequence: number): ThreadGoal {
  return {
    schemaVersion: "crewon.thread-goal.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    goalId: "goal-1",
    revision,
    objective: "finish the migration",
    status: "active",
    tokenBudget: 100,
    tokensUsed: eventSequence,
    timeUsedSeconds: eventSequence,
    createdAt: timestamp(1),
    updatedAt: timestamp(eventSequence),
  };
}

function timestamp(sequence: number): string {
  return `2026-08-09T00:00:${sequence.toString().padStart(2, "0")}Z`;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ThreadGoalEventError && error.code === code;
}
