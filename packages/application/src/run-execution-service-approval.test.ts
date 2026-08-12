import assert from "node:assert/strict";
import { test } from "node:test";

import { ApplicationError } from "./application-error.ts";
import type { DomainStore } from "./domain-store-port.ts";
import { RunExecutionService } from "./run-execution-service.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";

test("rejects an invalid replacement approval expiry before Store access", async () => {
  let storeCalls = 0;
  const store = new Proxy(
    {},
    {
      get() {
        storeCalls += 1;
        throw new Error("Store must not be accessed");
      },
    },
  ) as DomainStore;
  const service = new RunExecutionService({
    store,
    clock: { now: () => "2026-08-11T00:00:00Z" },
    ids: { nextId: (kind) => `${kind}-1` },
    digester: { sha256: () => `sha256:${"a".repeat(64)}` },
  });

  for (const expiresAfterMs of [Number.NaN, -1, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      service.replaceToolApproval(claim(), null as never, null as never, {
        expiresAfterMs,
        retryAfterMs: 1,
      }),
      (error) =>
        error instanceof ApplicationError &&
        error.category === "validation" &&
        error.code === "approval_expiry_invalid",
    );
  }
  assert.equal(storeCalls, 0);
});

test("workflow Tool authority creates a distinct child Attempt bound to the current Agent Attempt", async () => {
  const started: unknown[] = [];
  const store = {
    async loadRun() {
      return {
        tenantId: "tenant-1",
        runId: "run-1",
        status: "running",
        cancelRequested: false,
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
      };
    },
    async loadRunAttempt(input: { attemptId: string }) {
      assert.equal(input.attemptId, "agent-attempt-1");
      return {
        status: "running",
        workItemId: "work-item-1",
        leaseEpoch: 1,
      };
    },
    async loadRunStep(input: { stepId: string }) {
      assert.equal(input.stepId, "agent-step-1");
      return {
        kind: "model",
        status: "running",
        currentAttemptId: "agent-attempt-1",
      };
    },
    async loadToolExecutionReceiptByAction() {
      return null;
    },
    async beginRunAttempt(input: unknown) {
      started.push(input);
      return {
        step: {},
        abandonedAttempt: null,
        attempt: {
          attemptId: "tool-attempt-1",
          stepId: "tool-step-from-store",
          startedAt: "2026-08-11T00:00:00Z",
        },
      };
    },
    async prepareToolExecution(input: { receipt: unknown }) {
      return input.receipt;
    },
  } as unknown as DomainStore;
  const service = new RunExecutionService({
    store,
    clock: { now: () => "2026-08-11T00:00:00Z" },
    ids: { nextId: (kind) => `${kind}-1` },
    digester: { sha256: () => `sha256:${"a".repeat(64)}` },
  });
  const result = await service.beginToolExecution(
    claim(),
    {
      segmentId: "segment:agent-attempt-1",
      callId: "call-1",
      kind: "function",
      name: "read_file",
      input: "{}",
    },
    {
      effect: "readOnly",
      recovery: "replaySafe",
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: { kind: "control", bindingId: "tool-binding-1" },
      capability: "workspace.read",
      approvalRequirement: "none",
      limits: {
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
        maxArtifactBytes: 1_024,
      },
    },
    {
      kind: "workflowAgentAttempt",
      attempt: {
        stepId: "agent-step-1",
        attemptId: "agent-attempt-1",
      },
    },
  );
  assert.equal(started.length, 1);
  assert.deepEqual(started[0], {
    tenantId: "tenant-1",
    lease: {
      workItemId: "work-item-1",
      ownerId: "worker-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
    },
    runId: "run-1",
    stepId: `tool:${"a".repeat(64)}`,
    kind: "tool",
    attemptId: "attempt-1",
    startedAt: "2026-08-11T00:00:00Z",
  });
  assert.equal(result.attempt?.attempt.attemptId, "tool-attempt-1");
  assert.equal(result.receipt.attemptId, "tool-attempt-1");
  assert.notEqual(result.receipt.attemptId, "agent-attempt-1");
});

function claim(): WorkItemClaim {
  return {
    workItem: {
      workItemId: "work-item-1",
      tenantId: "tenant-1",
      runId: "run-1",
      kind: "run.execute",
      payload: { throughSequence: 1 },
      createdAt: "2026-08-11T00:00:00Z",
    },
    lease: {
      ownerId: "worker-1",
      leaseId: "lease-1",
      epoch: 1,
      expiresAt: "2026-08-11T00:01:00Z",
    },
  };
}
