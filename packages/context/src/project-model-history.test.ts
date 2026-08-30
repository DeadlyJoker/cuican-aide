import assert from "node:assert/strict";
import test from "node:test";

import {
  createThreadRollbackArtifacts,
  type ModelHistoryItem,
} from "@crewon/domain";

import { ContextHistoryError } from "./normalize-context-history.ts";
import {
  CONTEXT_COMPACTION_SUMMARY_PREFIX,
  projectModelHistory,
  projectedContinuationStart,
} from "./project-model-history.ts";

test("projects the latest durable compaction plus its append-only tail", () => {
  const history: readonly ModelHistoryItem[] = [
    message(1, "user", "old user"),
    message(2, "assistant", "old answer"),
    {
      ...base(3),
      type: "compaction",
      mode: "auto",
      replacesThroughSequence: 2,
      sourceDigest: digest("b"),
      summary: "durable summary",
      summaryDigest: digest("c"),
      retainedUserMessages: [
        { content: "old user", contentDigest: digest("a") },
      ],
    },
    message(4, "user", "new user"),
    message(5, "assistant", "new answer"),
    message(6, "user", "next user"),
  ];

  const projection = projectModelHistory(history);

  assert.deepEqual(projection.items, [
    { type: "message", role: "user", content: "old user" },
    {
      type: "message",
      role: "user",
      content: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\ndurable summary`,
    },
    { type: "message", role: "user", content: "new user" },
    { type: "message", role: "assistant", content: "new answer" },
    { type: "message", role: "user", content: "next user" },
  ]);
  assert.deepEqual(projection.sourceSequences, [3, 3, 4, 5, 6]);
  assert.equal(projection.revision, "history-3");
  assert.equal(projection.historyRewritten, true);
  assert.equal(
    projectedContinuationStart(projection, {
      contextRevision: "history-3",
      throughHistorySequence: 5,
    }),
    4,
  );
  assert.equal(
    projectedContinuationStart(projection, {
      contextRevision: "canonical",
      throughHistorySequence: 5,
    }),
    null,
  );
});

test("keeps canonical history cache-stable before the first compaction", () => {
  const history = [
    message(1, "user", "hello"),
    message(2, "assistant", "hi"),
    message(3, "user", "again"),
  ] as const;
  const projection = projectModelHistory(history);

  assert.deepEqual(projection.items, [
    { type: "message", role: "user", content: "hello" },
    { type: "message", role: "assistant", content: "hi" },
    { type: "message", role: "user", content: "again" },
  ]);
  assert.deepEqual(projection.sourceSequences, [1, 2, 3]);
  assert.equal(projection.revision, "canonical");
  assert.equal(projection.historyRewritten, false);
  assert.equal(
    projectedContinuationStart(projection, {
      contextRevision: "canonical",
      throughHistorySequence: 2,
    }),
    2,
  );
  assert.equal(
    projectedContinuationStart(projection, {
      contextRevision: "canonical",
      throughHistorySequence: 3,
    }),
    null,
  );
  assert.equal(
    projectedContinuationStart(projectModelHistory(history.slice(0, 2)), {
      contextRevision: "canonical",
      throughHistorySequence: 2,
    }),
    2,
  );
});

test("projects a compacted prefix without dropping the incoming user suffix", () => {
  const history: readonly ModelHistoryItem[] = [
    message(1, "user", "old user"),
    message(2, "assistant", "old answer"),
    message(3, "user", "after switch"),
    {
      ...base(4),
      type: "compaction",
      mode: "auto",
      replacesThroughSequence: 2,
      sourceDigest: digest("b"),
      summary: "old-model summary",
      summaryDigest: digest("c"),
      retainedUserMessages: [],
    },
  ];

  const projection = projectModelHistory(history);

  assert.deepEqual(projection.items, [
    {
      type: "message",
      role: "user",
      content: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\nold-model summary`,
    },
    { type: "message", role: "user", content: "after switch" },
  ]);
  assert.deepEqual(projection.sourceSequences, [4, 3]);
  assert.equal(projection.compactedThroughSequence, 2);
  assert.equal(projection.throughHistorySequence, 4);
});

test("accepts a maximum-size durable summary after adding the projection prefix", () => {
  const projection = projectModelHistory([
    message(1, "user", "hello"),
    {
      ...base(2),
      type: "compaction",
      mode: "manual",
      replacesThroughSequence: 1,
      sourceDigest: digest("b"),
      summary: "s".repeat(32 * 1024),
      summaryDigest: digest("c"),
      retainedUserMessages: [],
    },
  ]);

  assert.equal(projection.items.length, 1);
  assert.equal(
    projection.items[0]?.type === "message"
      ? projection.items[0].content.length
      : 0,
    CONTEXT_COMPACTION_SUMMARY_PREFIX.length + 1 + 32 * 1024,
  );
});

test("keeps a surviving compaction but advances revision to the rollback marker", () => {
  let history: readonly ModelHistoryItem[] = [
    message(1, "user", "old user"),
    message(2, "assistant", "old answer"),
    compaction(3, 2, "durable summary"),
    message(4, "user", "discarded user"),
    message(5, "assistant", "discarded answer"),
  ];
  const marker = rollbackMarker(history, 1, "after-compaction");
  history = [...history, marker];

  const projection = projectModelHistory(history);

  assert.deepEqual(projection.items, [
    { type: "message", role: "user", content: "old user" },
    {
      type: "message",
      role: "user",
      content: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\ndurable summary`,
    },
  ]);
  assert.deepEqual(projection.sourceSequences, [3, 3]);
  assert.equal(projection.revision, marker.itemId);
  assert.equal(projection.throughHistorySequence, 6);
  assert.equal(projection.compactedThroughSequence, 2);
  assert.equal(
    projectedContinuationStart(projection, {
      contextRevision: "history-3",
      throughHistorySequence: 3,
    }),
    null,
  );
});

test("drops a compacted view when rollback reaches its summarized turns", () => {
  let history: readonly ModelHistoryItem[] = [
    message(1, "user", "old user"),
    message(2, "assistant", "old answer"),
    compaction(3, 2, "now tombstoned"),
    message(4, "user", "second user"),
    message(5, "assistant", "second answer"),
  ];
  const marker = rollbackMarker(history, 2, "through-compaction");
  history = [...history, marker, message(7, "user", "new start")];

  const projection = projectModelHistory(history);

  assert.deepEqual(projection.items, [
    { type: "message", role: "user", content: "new start" },
  ]);
  assert.deepEqual(projection.sourceSequences, [7]);
  assert.equal(projection.revision, marker.itemId);
  assert.equal(projection.throughHistorySequence, 7);
  assert.equal(projection.compactedThroughSequence, null);
});

test("uses a later compaction as revision without resurrecting rolled-back items", () => {
  let history: readonly ModelHistoryItem[] = [
    message(1, "user", "first user"),
    message(2, "assistant", "first answer"),
    message(3, "user", "discarded user"),
    message(4, "assistant", "discarded answer"),
  ];
  history = [
    ...history,
    rollbackMarker(history, 1, "before-compaction"),
    message(6, "user", "replacement user"),
    message(7, "assistant", "replacement answer"),
    compaction(8, 7, "effective-only summary", []),
  ];

  const projection = projectModelHistory(history);

  assert.deepEqual(projection.items, [
    {
      type: "message",
      role: "user",
      content: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\neffective-only summary`,
    },
  ]);
  assert.deepEqual(projection.sourceSequences, [8]);
  assert.equal(projection.revision, "history-8");
  assert.equal(projection.throughHistorySequence, 8);
  assert.equal(projection.compactedThroughSequence, 7);
});

test("projects rollback then replacement Automation through compaction without resurrecting the invocation", () => {
  let history: readonly ModelHistoryItem[] = [
    message(1, "user", "surviving human turn"),
    message(2, "assistant", "surviving answer"),
    automationMessage(3, "rolled automation", "run-rolled", "invocation-rolled"),
    message(4, "assistant", "rolled answer"),
  ];
  history = [
    ...history,
    rollbackMarker(history, 1, "automation"),
    automationMessage(
      6,
      "replacement automation",
      "run-replacement",
      "invocation-replacement",
    ),
    message(7, "assistant", "replacement answer"),
    compaction(8, 7, "automation-safe summary", [
      {
        content: "surviving human turn",
        contentDigest: digest("d"),
      },
      {
        content: "replacement automation",
        contentDigest: digest("e"),
      },
    ]),
  ];

  const projection = projectModelHistory(history);

  assert.deepEqual(projection.items, [
    { type: "message", role: "user", content: "surviving human turn" },
    { type: "message", role: "user", content: "replacement automation" },
    {
      type: "message",
      role: "user",
      content: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\nautomation-safe summary`,
    },
  ]);
  assert.deepEqual(projection.sourceSequences, [8, 8, 8]);
  assert.equal(projection.revision, "history-8");
  assert.equal(
    projection.items.some(
      (item) => item.type === "message" && item.content === "rolled automation",
    ),
    false,
  );
});

test("does not let a zero-removal rollback marker weaken model item or byte caps", () => {
  const history: ModelHistoryItem[] = Array.from(
    { length: 257 },
    (_, index) => ({
      ...base(index + 1),
      type: "message",
      role: "system",
      source: "thread_message",
      content: `system-${index + 1}`,
      contentDigest: digest((index + 1).toString(16).at(-1) ?? "a"),
    }),
  );
  history.push(rollbackMarker(history, 1, "caps"));

  assert.throws(
    () => projectModelHistory(history),
    (error: unknown) =>
      error instanceof ContextHistoryError &&
      error.code === "context_history_item_limit_exceeded",
  );

  const shortHistory: ModelHistoryItem[] = [
    {
      ...base(1),
      type: "message",
      role: "system",
      source: "thread_message",
      content: "bounded content",
      contentDigest: digest("a"),
    },
  ];
  shortHistory.push(rollbackMarker(shortHistory, 1, "byte-caps"));
  assert.throws(
    () => projectModelHistory(shortHistory, { maxBytes: 5 }),
    (error: unknown) =>
      error instanceof ContextHistoryError &&
      error.code === "context_history_byte_limit_exceeded",
  );
});

function message(
  sequence: number,
  role: "user" | "assistant",
  content: string,
): Extract<ModelHistoryItem, { type: "message" }> {
  return {
    ...base(sequence),
    type: "message",
    role,
    source: role === "user" ? "thread_message" : "assistant_completion",
    content,
    contentDigest: digest(sequence.toString(16).at(-1) ?? "a"),
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
    ...base(sequence),
    runId,
    segmentId: null,
    type: "message",
    role: "user",
    source: "automation_invocation",
    content,
    contentDigest: digest("e"),
    origin: {
      kind: "automation",
      binding: {
        automationId: "automation-1",
        automationRevision: 1,
        definitionDigest: digest("f"),
        instructionDigest: digest("e"),
        invocationId,
        runId,
        routeDigest: digest("a"),
      },
    },
  };
}

function compaction(
  sequence: number,
  replacesThroughSequence: number,
  summary: string,
  retainedUserMessages = [{ content: "old user", contentDigest: digest("a") }],
): Extract<ModelHistoryItem, { type: "compaction" }> {
  return {
    ...base(sequence),
    type: "compaction",
    mode: "auto",
    replacesThroughSequence,
    sourceDigest: digest("b"),
    summary,
    summaryDigest: digest("c"),
    retainedUserMessages,
  };
}

function rollbackMarker(
  history: readonly ModelHistoryItem[],
  requestedTurns: number,
  suffix: string,
): Extract<ModelHistoryItem, { type: "rollback" }> {
  return createThreadRollbackArtifacts(history, {
    tenantId: "tenant-1",
    threadId: "thread-1",
    actorId: "actor-1",
    rollbackId: `rollback-${suffix}`,
    markerItemId: `rollback-marker-${suffix}`,
    threadEventId: `thread-event-${suffix}`,
    threadEventSequence: 1,
    occurredAt: "2026-08-08T00:00:01Z",
    requestedTurns,
  }).marker;
}

function base(sequence: number) {
  return {
    schemaVersion: "crewon.model-history-item.v0" as const,
    itemId: `history-${sequence}`,
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence,
    runId: "run-1",
    segmentId: "segment-1",
    createdAt: "2026-08-08T00:00:00Z",
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
