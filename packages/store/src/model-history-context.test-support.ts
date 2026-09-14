import assert from "node:assert/strict";
import type {
  ModelHistoryContextState,
  ModelHistoryContextStore,
} from "@crewon/application";
import {
  createThreadRollbackArtifacts,
  projectEffectiveModelHistory,
  type ModelHistoryItem,
} from "@crewon/domain";
export const locator = { tenantId: "tenant-1", threadId: "thread-1" };

export async function assertReplay(
  store: ModelHistoryContextStore,
  history: readonly ModelHistoryItem[],
) {
  const actual = await readWindow(store);
  const oracle = projectEffectiveModelHistory(history);
  const latest =
    oracle.items.filter((item) => item.type === "compaction").at(-1) ?? null;
  assert.deepEqual(actual.state.lastCompaction, latest);
  assert.deepEqual(actual.state.latestRollback, oracle.latestRollback);
  assert.deepEqual(actual.state.lastItem, history.at(-1) ?? null);
  assert.equal(actual.state.checkpoint.throughHistorySequence, history.length);
  assert.deepEqual(
    actual.items,
    oracle.items.filter(
      (item) =>
        item.type !== "compaction" &&
        item.sequence >
          (latest?.type === "compaction" ? latest.replacesThroughSequence : 0),
    ),
  );
}

export async function readWindow(store: ModelHistoryContextStore) {
  let state: ModelHistoryContextState | null = null;
  let through = -1;
  while (state === null) {
    const progress = await store.prepare(locator);
    assert.ok(progress.processedThroughSequence > through);
    through = progress.processedThroughSequence;
    state = progress.context;
  }
  const items: ModelHistoryItem[] = [];
  let cursor = 0;
  while (true) {
    const page = await store.listItems(locator, state.checkpoint, cursor, 3);
    items.push(...page);
    if (page.length < 3) break;
    cursor = page.at(-1)!.sequence;
  }
  return { state, items };
}

export function message(
  sequence: number,
  role: "user" | "assistant" = "user",
  source: "thread_message" | "goal_steering" = "thread_message",
): ModelHistoryItem {
  return {
    ...base(sequence),
    type: "message",
    role,
    source,
    content: `message ${sequence}\n  preserve whitespace`,
    contentDigest: `sha256:${"a".repeat(64)}`,
  };
}

export function compaction(
  sequence: number,
  replacesThroughSequence: number,
): ModelHistoryItem {
  return {
    ...base(sequence),
    type: "compaction",
    mode: "auto",
    replacesThroughSequence,
    sourceDigest: `sha256:${"b".repeat(64)}`,
    summary: `summary ${sequence}\n  exact prefix`,
    summaryDigest: `sha256:${"c".repeat(64)}`,
    retainedUserMessages: [
      {
        content: "original instruction",
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
    ],
  };
}

export function rollback(
  history: readonly ModelHistoryItem[],
  requestedTurns: number,
) {
  const sequence = history.length + 1;
  return createThreadRollbackArtifacts(history, {
    ...locator,
    actorId: "actor-1",
    rollbackId: `rollback-${sequence}`,
    markerItemId: `history-${sequence}`,
    threadEventId: `event-${sequence}`,
    threadEventSequence: sequence,
    occurredAt: "2026-08-08T00:00:00Z",
    requestedTurns,
  }).marker;
}

function base(sequence: number) {
  return {
    ...locator,
    schemaVersion: "crewon.model-history-item.v0" as const,
    sequence,
    itemId: `history-${sequence}`,
    runId: "run-store-1",
    segmentId: "segment-1",
    createdAt: "2026-08-08T00:00:00Z",
  };
}
