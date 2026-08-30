import assert from "node:assert/strict";
import test from "node:test";

import {
  createThreadRollbackArtifacts,
  isModelHistoryMessageBacked,
  type AutomationInvocationOrigin,
  type ModelHistoryItem,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { MessageRecord } from "./thread-store-port.ts";
import {
  projectThreadForkHistory,
  rebaseThreadForkHistory,
  selectThreadForkMessages,
} from "./thread-fork-history.ts";

test("projects only effective canonical history and message-backed records", () => {
  const fixture = rollbackHistory();
  const projection = projectThreadForkHistory(fixture.history, null);
  const selected = selectThreadForkMessages(projection, fixture.messages);

  assert.deepEqual(
    projection.items.map(({ sequence }) => sequence),
    [1, 2, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(
    projection.rawMessageItems.map(({ sequence }) => sequence),
    [1, 2, 3, 4, 9, 10],
  );
  assert.deepEqual(
    selected.map(({ sequence, content }) => ({ sequence, content })),
    [
      { sequence: 1, content: "first" },
      { sequence: 2, content: "answer one" },
      { sequence: 5, content: "third" },
      { sequence: 6, content: "answer three" },
    ],
  );
  assert.deepEqual(
    selected.find(({ content }) => content === "third")?.origin,
    automationOrigin("automation-run-surviving", "invocation-surviving", "third"),
  );
});

test("fails closed when Automation Message provenance or route digest diverges", () => {
  const fixture = rollbackHistory();
  const projection = projectThreadForkHistory(fixture.history, null);
  const corruptedMessages = fixture.messages.map((message) =>
    message.origin === null
      ? message
      : {
          ...message,
          origin: {
            ...message.origin,
            binding: {
              ...message.origin.binding,
              routeDigest: digest("wrong route"),
            },
          },
        },
  );

  assert.throws(
    () => selectThreadForkMessages(projection, corruptedMessages),
    hasApplicationError("thread_message_history_mismatch"),
  );

  const corruptedHistory = fixture.history.map((item) =>
    item.type === "message" &&
    item.source === "automation_invocation" &&
    item.content === "third"
      ? {
          ...item,
          origin: {
            ...item.origin,
            binding: { ...item.origin.binding, routeDigest: "not-a-digest" },
          },
        }
      : item,
  ) as readonly ModelHistoryItem[];
  assert.throws(
    () => projectThreadForkHistory(corruptedHistory, null),
    hasApplicationError("thread_fork_history_invalid"),
  );
});

test("does not resurrect a rolled-back suffix at an earlier requested boundary", () => {
  const fixture = rollbackHistory();

  assert.deepEqual(
    projectThreadForkHistory(fixture.history, 5).items.map(
      ({ sequence }) => sequence,
    ),
    [1, 2],
  );
  assert.deepEqual(projectThreadForkHistory(fixture.history, 0), {
    items: [],
    rawMessageItems: [],
  });
});

test("rebases gaps and a surviving compaction boundary contiguously", () => {
  const fixture = rollbackHistory();
  const projection = projectThreadForkHistory(fixture.history, null);
  const rebased = rebaseThreadForkHistory(projection.items, {
    tenantId: "tenant-1",
    threadId: "thread-fork",
    createdAt: "2026-08-09T00:00:00Z",
    itemIds: projection.items.map((_, index) => `fork-history-${index + 1}`),
  });

  assert.deepEqual(
    rebased.map((item) => ({
      type: item.type,
      sequence: item.sequence,
      source: item.type === "message" ? item.source : null,
      replacesThroughSequence:
        item.type === "compaction" ? item.replacesThroughSequence : null,
    })),
    [
      {
        type: "message",
        sequence: 1,
        source: "thread_message",
        replacesThroughSequence: null,
      },
      {
        type: "message",
        sequence: 2,
        source: "assistant_completion",
        replacesThroughSequence: null,
      },
      {
        type: "message",
        sequence: 3,
        source: "goal_continuation",
        replacesThroughSequence: null,
      },
      {
        type: "compaction",
        sequence: 4,
        source: null,
        replacesThroughSequence: 3,
      },
      {
        type: "message",
        sequence: 5,
        source: "goal_steering",
        replacesThroughSequence: null,
      },
      {
        type: "message",
        sequence: 6,
        source: "automation_invocation",
        replacesThroughSequence: null,
      },
      {
        type: "message",
        sequence: 7,
        source: "assistant_completion",
        replacesThroughSequence: null,
      },
    ],
  );
  assert.equal(
    rebased.some(({ type }) => type === "rollback"),
    false,
  );
  assert.deepEqual(
    new Set(
      rebased.map(
        ({ tenantId, threadId, createdAt }) =>
          `${tenantId}/${threadId}/${createdAt}`,
      ),
    ),
    new Set(["tenant-1/thread-fork/2026-08-09T00:00:00Z"]),
  );
});

function rollbackHistory(): Readonly<{
  history: readonly ModelHistoryItem[];
  messages: readonly (MessageRecord &
    Readonly<{ origin: AutomationInvocationOrigin | null }>)[];
}> {
  const beforeRollback = [
    message(1, "user", "thread_message", "first"),
    message(2, "assistant", "assistant_completion", "answer one"),
    automationMessage(3, "second", "automation-run-rolled", "invocation-rolled"),
    message(4, "assistant", "assistant_completion", "answer two"),
  ] satisfies readonly ModelHistoryItem[];
  const marker = createThreadRollbackArtifacts(beforeRollback, {
    tenantId: "tenant-1",
    threadId: "thread-1",
    actorId: "actor-1",
    rollbackId: "rollback-1",
    markerItemId: "rollback-marker-1",
    threadEventId: "thread-event-rollback-1",
    threadEventSequence: 9,
    occurredAt: timestamp(5),
    requestedTurns: 1,
  }).marker;
  const history = [
    ...beforeRollback,
    marker,
    message(6, "user", "goal_continuation", "continue objective"),
    compaction(7, 6),
    message(8, "user", "goal_steering", "updated objective"),
    automationMessage(
      9,
      "third",
      "automation-run-surviving",
      "invocation-surviving",
    ),
    message(10, "assistant", "assistant_completion", "answer three"),
  ] satisfies readonly ModelHistoryItem[];
  const messageItems = history.filter(isModelHistoryMessageBacked);
  return {
    history,
    messages: messageItems.map((item, index) => ({
      messageId: `message-${index + 1}`,
      tenantId: item.tenantId,
      threadId: item.threadId,
      sequence: index + 1,
      role: item.role,
      content: item.content,
      contentDigest: item.contentDigest,
      createdAt: item.createdAt,
      origin: item.source === "automation_invocation" ? item.origin : null,
      proposedPlan: null,
      ...(item.sequence === 3 || item.sequence === 4
        ? {
            invalidation: {
              rollbackId: "rollback-1",
              markerItemId: "rollback-marker-1",
              historySequence: item.sequence,
              invalidatedAt: timestamp(5),
            },
          }
        : { invalidation: null }),
    })),
  };
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
    createdAt: timestamp(sequence),
    role,
    source,
    content,
    contentDigest: digest(content),
  };
}

function automationMessage(
  sequence: number,
  content: string,
  runId: string,
  invocationId: string,
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
    runId,
    segmentId: null,
    createdAt: timestamp(sequence),
    role: "user",
    source: "automation_invocation",
    content,
    contentDigest: digest(content),
    origin: automationOrigin(runId, invocationId, content),
  };
}

function automationOrigin(
  runId: string,
  invocationId: string,
  content: string,
): AutomationInvocationOrigin {
  return {
    kind: "automation" as const,
    binding: {
      automationId: "automation-1",
      automationRevision: 1 as const,
      definitionDigest: digest("definition"),
      instructionDigest: digest(content),
      invocationId,
      runId,
      routeDigest: digest("route"),
    },
  };
}

function compaction(
  sequence: number,
  replacesThroughSequence: number,
): Extract<ModelHistoryItem, { type: "compaction" }> {
  return {
    schemaVersion: "crewon.model-history-item.v0",
    type: "compaction",
    itemId: `history-${sequence}`,
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence,
    runId: "run-compaction",
    segmentId: "segment-compaction",
    createdAt: timestamp(sequence),
    mode: "auto",
    replacesThroughSequence,
    sourceDigest: digest("source"),
    summary: "summary",
    summaryDigest: digest("summary"),
    retainedUserMessages: [],
  };
}

function timestamp(sequence: number): string {
  return `2026-08-08T00:00:${sequence.toString().padStart(2, "0")}Z`;
}

function digest(content: string): string {
  const fill = (content.codePointAt(0) ?? 0).toString(16).padStart(2, "0");
  return `sha256:${fill.repeat(32)}`;
}

function hasApplicationError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ApplicationError && error.code === code;
}
