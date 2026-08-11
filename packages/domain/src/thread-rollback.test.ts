import assert from "node:assert/strict";
import test from "node:test";

import { ModelHistoryError, type ModelHistoryItem } from "./model-history.ts";
import {
  reduceThreadLifecycleEvent,
  type ThreadLifecycleEvent,
} from "./thread-lifecycle.ts";
import {
  createThreadRollbackArtifacts,
  planModelHistoryRollback,
  projectEffectiveModelHistory,
  validateThreadRollbackArtifacts,
} from "./thread-rollback.ts";

test("derives turn boundaries and absorbs only non-initial contextual updates", () => {
  const history = [
    message(1, "user", "thread_message", "first"),
    message(2, "assistant", "assistant_completion", "answer one"),
    message(3, "user", "goal_steering", "goal changed"),
    message(4, "user", "thread_message", "second"),
    message(5, "assistant", "assistant_completion", "answer two"),
  ] satisfies readonly ModelHistoryItem[];

  assert.deepEqual(planModelHistoryRollback(history, 1), {
    requestedTurns: 1,
    removedTurns: 1,
    historyFromSequence: 3,
    historyThroughSequence: 5,
    markerHistorySequence: 6,
  });
  assert.deepEqual(planModelHistoryRollback(history, 10), {
    requestedTurns: 10,
    removedTurns: 2,
    historyFromSequence: 1,
    historyThroughSequence: 5,
    markerHistorySequence: 6,
  });
});

test("does not treat assistant or contextual-only history as an instruction turn", () => {
  const history = [
    message(1, "assistant", "assistant_completion", "answer"),
    message(2, "user", "goal_continuation", "continue the goal"),
  ] satisfies readonly ModelHistoryItem[];

  assert.deepEqual(planModelHistoryRollback(history, 1), {
    requestedTurns: 1,
    removedTurns: 0,
    historyFromSequence: null,
    historyThroughSequence: 2,
    markerHistorySequence: 3,
  });
});

test("treats a canonical Automation invocation as an instruction boundary", () => {
  const history = [
    message(1, "user", "thread_message", "first"),
    message(2, "assistant", "assistant_completion", "answer one"),
    message(3, "user", "goal_steering", "goal changed"),
    automationMessage(4, "automation replacement"),
    message(5, "assistant", "assistant_completion", "automation answer"),
  ] satisfies readonly ModelHistoryItem[];

  assert.deepEqual(planModelHistoryRollback(history, 1), {
    requestedTurns: 1,
    removedTurns: 1,
    historyFromSequence: 3,
    historyThroughSequence: 5,
    markerHistorySequence: 6,
  });
  assert.deepEqual(planModelHistoryRollback(history, 2), {
    requestedTurns: 2,
    removedTurns: 2,
    historyFromSequence: 1,
    historyThroughSequence: 5,
    markerHistorySequence: 6,
  });
});

test("applies cumulative rollback tombstones while preserving later raw sequence gaps", () => {
  let history: readonly ModelHistoryItem[] = [
    message(1, "user", "thread_message", "first"),
    message(2, "assistant", "assistant_completion", "answer one"),
    message(3, "user", "thread_message", "second"),
    message(4, "assistant", "assistant_completion", "answer two"),
  ];
  const first = rollback(history, 1, "one");
  history = [...history, first.marker];
  history = [
    ...history,
    message(6, "user", "thread_message", "third"),
    message(7, "assistant", "assistant_completion", "answer three"),
  ];
  const second = rollback(history, 1, "two");
  history = [...history, second.marker];

  assert.deepEqual(
    projectEffectiveModelHistory(history).items.map(({ sequence }) => sequence),
    [1, 2],
  );
  assert.deepEqual(second.boundary, {
    requestedTurns: 1,
    removedTurns: 1,
    historyFromSequence: 6,
    historyThroughSequence: 7,
    markerHistorySequence: 8,
  });

  const withNewTail = [
    ...history,
    message(9, "user", "thread_message", "fourth"),
  ];
  assert.deepEqual(
    projectEffectiveModelHistory(withNewTail).items.map(
      ({ sequence }) => sequence,
    ),
    [1, 2, 9],
  );
  assert.equal(
    projectEffectiveModelHistory(withNewTail).throughHistorySequence,
    9,
  );
});

test("rejects a structurally valid marker whose caller forged the boundary", () => {
  const history: readonly ModelHistoryItem[] = [
    message(1, "user", "thread_message", "first"),
    message(2, "assistant", "assistant_completion", "answer one"),
    message(3, "user", "thread_message", "second"),
    message(4, "assistant", "assistant_completion", "answer two"),
  ];
  const artifacts = rollback(history, 1, "forgery");
  const forged = {
    ...artifacts.marker,
    historyFromSequence: 2,
  } satisfies ModelHistoryItem;

  assert.throws(
    () => projectEffectiveModelHistory([...history, forged]),
    hasHistoryCode("model_history_rollback_boundary_mismatch"),
  );
  assert.throws(
    () =>
      validateThreadRollbackArtifacts(history, {
        ...artifacts,
        marker: forged,
      }),
    hasHistoryCode("model_history_rollback_boundary_mismatch"),
  );
});

test("canonical rollback event advances Thread revision without changing Message head", () => {
  const created: ThreadLifecycleEvent = {
    schemaVersion: "crewon.thread-event.v0",
    type: "thread.created",
    identity: { threadId: "thread-1" },
    eventId: "thread-event-1",
    sequence: 1,
    occurredAt: "2026-08-08T00:00:01Z",
    data: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      createdByActorId: "actor-1",
      title: null,
    },
  };
  const state = reduceThreadLifecycleEvent(null, created);
  const artifacts = createThreadRollbackArtifacts([], {
    tenantId: "tenant-1",
    threadId: "thread-1",
    actorId: "actor-1",
    rollbackId: "rollback-empty",
    markerItemId: "rollback-marker-empty",
    threadEventId: "thread-event-2",
    threadEventSequence: 2,
    occurredAt: "2026-08-08T00:00:02Z",
    requestedTurns: 1,
  });

  assert.deepEqual(reduceThreadLifecycleEvent(state, artifacts.event), {
    ...state,
    revision: 2,
    lastEventSequence: 2,
    lastMessageSequence: 0,
    updatedAt: "2026-08-08T00:00:02Z",
  });
});

function rollback(
  history: readonly ModelHistoryItem[],
  requestedTurns: number,
  suffix: string,
) {
  return createThreadRollbackArtifacts(history, {
    tenantId: "tenant-1",
    threadId: "thread-1",
    actorId: "actor-1",
    rollbackId: `rollback-${suffix}`,
    markerItemId: `rollback-marker-${suffix}`,
    threadEventId: `thread-event-${suffix}`,
    threadEventSequence: 2,
    occurredAt: "2026-08-08T00:00:10Z",
    requestedTurns,
  });
}

function message(
  sequence: number,
  role: "user" | "assistant",
  source:
    | "thread_message"
    | "assistant_completion"
    | "goal_continuation"
    | "goal_steering",
  content: string,
): Extract<ModelHistoryItem, { type: "message" }> {
  return {
    schemaVersion: "crewon.model-history-item.v0",
    type: "message",
    itemId: `history-${sequence}`,
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence,
    runId: null,
    segmentId: null,
    createdAt: "2026-08-08T00:00:00Z",
    role,
    source,
    content,
    contentDigest: `sha256:${"a".repeat(64)}`,
  };
}

function automationMessage(
  sequence: number,
  content: string,
): Extract<
  ModelHistoryItem,
  { type: "message"; source: "automation_invocation" }
> {
  return {
    schemaVersion: "crewon.model-history-item.v0",
    type: "message",
    itemId: `history-${sequence}`,
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence,
    runId: "automation-run-1",
    segmentId: null,
    createdAt: "2026-08-08T00:00:00Z",
    role: "user",
    source: "automation_invocation",
    content,
    contentDigest: `sha256:${"b".repeat(64)}`,
    origin: {
      kind: "automation",
      binding: {
        automationId: "automation-1",
        automationRevision: 1,
        definitionDigest: `sha256:${"c".repeat(64)}`,
        instructionDigest: `sha256:${"b".repeat(64)}`,
        invocationId: "invocation-1",
        runId: "automation-run-1",
        routeDigest: `sha256:${"d".repeat(64)}`,
      },
    },
  };
}

function hasHistoryCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ModelHistoryError && error.code === code;
}
