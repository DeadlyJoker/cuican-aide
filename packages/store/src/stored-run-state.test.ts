import assert from "node:assert/strict";
import test from "node:test";

import { RunStoreError } from "@crewon/application";
import type { RunState } from "@crewon/domain";

import { normalizeStoredRunState } from "./stored-run-state.ts";

test("normalizes the complete pre-Goal/Plan and pre-usage Run shape", () => {
  const {
    collaborationMode: _mode,
    goalBinding: _binding,
    goalAccounting: _goalAccounting,
    usage: _usage,
    ...legacy
  } = runState();

  assert.deepEqual(normalizeStoredRunState(legacy as RunState, "corrupt"), {
    ...legacy,
    collaborationMode: "default",
    goalBinding: null,
    goalAccounting: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  });
});

test("normalizes an otherwise current pre-usage Run and rejects corrupt usage", () => {
  const { usage: _usage, ...legacy } = runState();
  assert.deepEqual(normalizeStoredRunState(legacy as RunState, "corrupt"), {
    ...legacy,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  });
  assert.throws(
    () =>
      normalizeStoredRunState(
        {
          ...runState(),
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            totalTokens: 3,
          },
        },
        "corrupt",
      ),
    hasCode("corrupt"),
  );
  const { cachedInputTokens: _cachedInputTokens, ...legacyUsage } =
    runState().usage;
  assert.deepEqual(
    normalizeStoredRunState(
      { ...runState(), usage: legacyUsage } as RunState,
      "corrupt",
    ).usage,
    { ...legacyUsage, cachedInputTokens: 0 },
  );
  assert.throws(
    () =>
      normalizeStoredRunState(
        {
          ...runState(),
          usage: {
            inputTokens: 1,
            cachedInputTokens: 2,
            outputTokens: 0,
            totalTokens: 1,
          },
        },
        "corrupt",
      ),
    hasCode("corrupt"),
  );
});

test("rejects partial or impossible stored Run mode state", () => {
  assert.throws(
    () =>
      normalizeStoredRunState(
        {
          ...runState(),
          collaborationMode: "plan",
          goalBinding: {
            goalId: "goal-1",
            revision: 1,
            objectiveDigest: `sha256:${"a".repeat(64)}`,
          },
        },
        "corrupt",
      ),
    hasCode("corrupt"),
  );
  const { goalBinding: _goalBinding, ...partial } = runState();
  assert.throws(
    () => normalizeStoredRunState(partial as RunState, "corrupt"),
    hasCode("corrupt"),
  );
});

test("normalizes legacy absence and fails closed on malformed Workflow binding", () => {
  assert.equal(
    Object.hasOwn(normalizeStoredRunState(runState(), "corrupt"), "workflowVersionBinding"),
    false,
  );
  assert.throws(
    () =>
      normalizeStoredRunState(
        {
          ...runState(),
          purpose: "workflow",
          workflowVersionBinding: {
            workflowId: " ",
            workflowVersionId: "version-1",
            contentDigest: `sha256:${"a".repeat(64)}`,
          },
        },
        "corrupt",
      ),
    hasCode("corrupt"),
  );
});

function runState(): RunState {
  return {
    runId: "run-1",
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    authorityId: "authority-1",
    runtimeGeneration: "ts-v0",
    agentVersionId: "agent-version-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    collaborationMode: "default",
    goalBinding: null,
    goalAccounting: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    status: "queued",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    suspensionReasonCode: null,
    reconciliationReceiptId: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-09T00:00:01Z",
    updatedAt: "2026-08-09T00:00:01Z",
    terminalAt: null,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
