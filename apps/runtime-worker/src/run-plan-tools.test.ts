import assert from "node:assert/strict";
import test from "node:test";

import type { RunState } from "@crewon/domain";

import {
  isRunPlanToolCall,
  runPlanToolsForRun,
} from "./run-plan-tools.ts";

test("publishes a domain-aligned update_plan schema for ordinary turns", () => {
  const [definition] = runPlanToolsForRun(run());
  assert.ok(definition !== undefined);
  if (definition.kind !== "function") {
    assert.fail("update_plan must be a function tool");
  }
  assert.equal(definition.name, "update_plan");
  assert.deepEqual(definition.inputSchema, {
    type: "object",
    properties: {
      explanation: {
        anyOf: [
          { type: "string", minLength: 1, maxLength: 1_000 },
          { type: "null" },
        ],
      },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              minLength: 1,
              maxLength: 64,
              pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
            },
            title: { type: "string", minLength: 1, maxLength: 256 },
            status: {
              type: "string",
              enum: [
                "pending",
                "in_progress",
                "completed",
                "blocked",
                "canceled",
              ],
            },
          },
          required: ["id", "title", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  });
});

test("hides update_plan outside ordinary default turns", () => {
  assert.deepEqual(runPlanToolsForRun(run({ collaborationMode: "plan" })), []);
  assert.deepEqual(
    runPlanToolsForRun(run({ purpose: "manualCompaction" })),
    [],
  );
  assert.deepEqual(runPlanToolsForRun(run({ purpose: "workflow" })), []);
});

test("recognizes only the exact server-owned function identity", () => {
  assert.equal(
    isRunPlanToolCall({ kind: "function", name: "update_plan" }),
    true,
  );
  assert.equal(
    isRunPlanToolCall({ kind: "custom", name: "update_plan" }),
    false,
  );
  assert.equal(
    isRunPlanToolCall({ kind: "function", name: "update_goal" }),
    false,
  );
});

function run(overrides: Partial<RunState> = {}): RunState {
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
    workspaceBindingId: null,
    collaborationMode: "default",
    purpose: "turn",
    origin: null,
    goalBinding: null,
    goalAccounting: null,
    plan: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    status: "running",
    revision: 2,
    lastSequence: 2,
    cancelRequested: false,
    waitingApproval: null,
    suspensionReasonCode: null,
    reconciliationReceiptId: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-09-02T00:00:00Z",
    updatedAt: "2026-09-02T00:00:01Z",
    terminalAt: null,
    ...overrides,
  };
}
