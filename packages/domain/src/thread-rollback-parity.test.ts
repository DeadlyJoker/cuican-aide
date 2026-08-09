import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ModelHistoryItem } from "./model-history.ts";
import {
  createThreadRollbackArtifacts,
  planModelHistoryRollback,
  projectEffectiveModelHistory,
} from "./thread-rollback.ts";

type ReferenceItem = Readonly<{
  sequence: number;
  itemId: string;
  kind:
    | "user"
    | "assistant"
    | "contextualGoal"
    | "compaction"
    | "structuredInterAgent";
  goalSource?: "goalContinuation" | "goalSteering";
  replacesThroughSequence?: number;
}>;

type ExpectedState = Readonly<{
  effectiveSequences: readonly number[];
  remainingItemIds: readonly string[];
}>;

type ExpectedRollback = ExpectedState &
  Readonly<{
    requestedTurns: number;
    removedTurns: number;
    historyFromSequence: number | null;
    historyThroughSequence: number;
    markerHistorySequence: number;
  }>;

type ReferenceOperation =
  | Readonly<{
      type: "rollback";
      requestedTurns: number;
      expected: ExpectedRollback;
    }>
  | Readonly<{
      type: "append";
      items: readonly ReferenceItem[];
      expected: ExpectedState;
    }>;

type RollbackParityReference = Readonly<{
  schemaVersion: string;
  cases: readonly Readonly<{
    caseId: string;
    support: Readonly<{
      typescript: "supported" | "unsupported";
      rust: "supported" | "unsupported";
      reason?: string;
    }>;
    initialItems: readonly ReferenceItem[];
    operations: readonly ReferenceOperation[];
  }>[];
}>;

const reference = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/thread-rollback-parity.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as RollbackParityReference;

test("matches the shared provider-neutral rollback parity fixture", () => {
  assert.equal(reference.schemaVersion, "crewon.thread-rollback-parity.v0");
  let unsupportedStructuredInterAgentCases = 0;

  for (const fixtureCase of reference.cases) {
    assert.equal(fixtureCase.support.rust, "supported", fixtureCase.caseId);
    if (fixtureCase.support.typescript === "unsupported") {
      assert.equal(fixtureCase.caseId, "structured-inter-agent-boundary");
      assert.equal(
        fixtureCase.support.reason,
        "typescript_model_history_has_no_structured_inter_agent_source",
      );
      unsupportedStructuredInterAgentCases += 1;
      continue;
    }

    let history = fixtureCase.initialItems.map(modelHistoryItem);
    let rollbackIndex = 0;
    assertExpectedState(fixtureCase.caseId, history, {
      effectiveSequences: fixtureCase.initialItems.map(
        ({ sequence }) => sequence,
      ),
      remainingItemIds: fixtureCase.initialItems.map(({ itemId }) => itemId),
    });

    for (const operation of fixtureCase.operations) {
      if (operation.type === "append") {
        history = [...history, ...operation.items.map(modelHistoryItem)];
        assertExpectedState(fixtureCase.caseId, history, operation.expected);
        continue;
      }

      const boundary = planModelHistoryRollback(
        history,
        operation.requestedTurns,
      );
      assert.deepEqual(
        boundary,
        {
          requestedTurns: operation.expected.requestedTurns,
          removedTurns: operation.expected.removedTurns,
          historyFromSequence: operation.expected.historyFromSequence,
          historyThroughSequence: operation.expected.historyThroughSequence,
          markerHistorySequence: operation.expected.markerHistorySequence,
        },
        fixtureCase.caseId,
      );
      const artifacts = createThreadRollbackArtifacts(history, {
        tenantId: "tenant-parity",
        threadId: "thread-parity",
        actorId: "actor-parity",
        rollbackId: `${fixtureCase.caseId}-rollback-${rollbackIndex}`,
        markerItemId: `${fixtureCase.caseId}-marker-${rollbackIndex}`,
        threadEventId: `${fixtureCase.caseId}-event-${rollbackIndex}`,
        threadEventSequence: rollbackIndex + 1,
        occurredAt: "2026-08-09T00:00:00Z",
        requestedTurns: operation.requestedTurns,
      });
      history = [...history, artifacts.marker];
      rollbackIndex += 1;
      assertExpectedState(fixtureCase.caseId, history, operation.expected);
    }
  }

  assert.equal(unsupportedStructuredInterAgentCases, 1);
});

function assertExpectedState(
  caseId: string,
  history: readonly ModelHistoryItem[],
  expected: ExpectedState,
): void {
  const effective = projectEffectiveModelHistory(history);
  assert.deepEqual(
    effective.items.map(({ sequence }) => sequence),
    expected.effectiveSequences,
    caseId,
  );
  assert.deepEqual(
    effective.items.map(({ itemId }) => itemId),
    expected.remainingItemIds,
    caseId,
  );
}

function modelHistoryItem(item: ReferenceItem): ModelHistoryItem {
  const base = {
    schemaVersion: "crewon.model-history-item.v0" as const,
    itemId: item.itemId,
    tenantId: "tenant-parity",
    threadId: "thread-parity",
    sequence: item.sequence,
    runId: null,
    segmentId: null,
    createdAt: "2026-08-09T00:00:00Z",
  };
  switch (item.kind) {
    case "user":
      return {
        ...base,
        type: "message",
        role: "user",
        source: "thread_message",
        content: item.itemId,
        contentDigest: digest(),
      };
    case "assistant":
      return {
        ...base,
        type: "message",
        role: "assistant",
        source: "assistant_completion",
        content: item.itemId,
        contentDigest: digest(),
      };
    case "contextualGoal":
      assert.ok(item.goalSource !== undefined);
      return {
        ...base,
        type: "message",
        role: "user",
        source:
          item.goalSource === "goalContinuation"
            ? "goal_continuation"
            : "goal_steering",
        content: item.itemId,
        contentDigest: digest(),
      };
    case "compaction":
      assert.ok(item.replacesThroughSequence !== undefined);
      return {
        ...base,
        type: "compaction",
        runId: "run-compaction-parity",
        segmentId: "segment-compaction-parity",
        mode: "auto",
        replacesThroughSequence: item.replacesThroughSequence,
        sourceDigest: digest("b"),
        summary: item.itemId,
        summaryDigest: digest("c"),
        retainedUserMessages: [],
      };
    case "structuredInterAgent":
      throw new Error(
        "typescript_model_history_has_no_structured_inter_agent_source",
      );
  }
}

function digest(character = "a"): string {
  return `sha256:${character.repeat(64)}`;
}
