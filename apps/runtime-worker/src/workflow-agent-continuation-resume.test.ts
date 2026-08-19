import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "@crewon/application";
import type {
  WorkflowNodeContinuationResume,
  WorkflowPendingToolResume,
} from "@crewon/application";

import { prepareWorkflowAgentContinuationResume } from "./workflow-agent-continuation-resume.ts";

test("assistant continuation resumes from the last durable assistant boundary", async () => {
  const fixture = resumeFixture();
  fixture.resume.continuation.history = [
    { type: "message", role: "user", content: "first" },
    { type: "message", role: "assistant", content: "older" },
    { type: "message", role: "user", content: "next" },
    { type: "message", role: "assistant", content: "continue" },
  ];
  const prepared = await prepareWorkflowAgentContinuationResume(
    fixture.dependencies,
    fixture.input(),
  );
  assert.equal(prepared.kind, "execute");
  if (prepared.kind !== "execute") return;
  assert.deepEqual(prepared.input.continuationState.continuation, {
    kind: "providerCheckpoint",
    checkpoint: fixture.providerCheckpoint,
    newHistoryStartIndex: 3,
  });
  assert.equal(prepared.input.adopted.attempt, fixture.resume.attempt);
  assert.equal(fixture.modelCalls, 0);
  assert.equal(fixture.toolCalls, 0);
});

test("completed Tool continuation restores its exact suffix without repeating the effect", async () => {
  const fixture = resumeFixture();
  fixture.resume.continuation.history = [
    { type: "message", role: "user", content: "use the tool" },
    { type: "message", role: "assistant", content: "calling" },
    {
      type: "tool_call",
      kind: "function",
      callId: "call-1",
      name: "lookup",
      input: "{}",
    },
    {
      type: "tool_result",
      kind: "function",
      callId: "call-1",
      output: "done",
    },
  ];
  fixture.events = [
    {
      sequence: 1,
      type: "tool.requested",
      data: {
        segmentId: fixture.resume.continuation.segmentId,
        segmentSequence: 1,
        callId: "call-1",
        kind: "function",
        name: "lookup",
        input: "{}",
      },
    },
    {
      sequence: 2,
      type: "tool.completed",
      data: {
        segmentId: fixture.resume.continuation.segmentId,
        segmentSequence: 2,
        callId: "call-1",
      },
    },
  ];
  const prepared = await prepareWorkflowAgentContinuationResume(
    fixture.dependencies,
    fixture.input(),
  );
  assert.equal(prepared.kind, "execute");
  if (prepared.kind !== "execute") return;
  assert.deepEqual(prepared.input.continuationState.continuation, {
    kind: "providerCheckpoint",
    checkpoint: fixture.providerCheckpoint,
    newHistoryStartIndex: 1,
  });
  assert.equal(fixture.toolCalls, 0);
});

test("adopted pending Tool authority resumes each receipt status without a new Attempt", async (t) => {
  for (const status of ["prepared", "dispatched", "unknownOutcome"] as const)
    await t.test(status, async () => {
      const fixture = pendingToolFixture(status);
      const prepared = await prepareWorkflowAgentContinuationResume(
        fixture.dependencies,
        fixture.input(),
      );
      assert.equal(prepared.kind, "execute");
      assert.deepEqual(fixture.calls, {
        begin: 0,
        recovery: 0,
        validate: 1,
        dispatch: status === "prepared" ? 1 : 0,
        execute: status === "prepared" ? 1 : 0,
        reconcile: status === "prepared" ? 0 : 1,
        commit: 1,
      });
    });
});

test("pending Tool adoption drift fails closed before Tool effects", async () => {
  const fixture = pendingToolFixture("dispatched");
  const adopted = fixture.resume.pendingTools[0]!;
  fixture.resume.pendingTools = [
    {
      ...adopted,
      attempt: { ...adopted.attempt, leaseEpoch: 99 },
    },
  ];
  await assert.rejects(
    prepareWorkflowAgentContinuationResume(
      fixture.dependencies,
      fixture.input(),
    ),
    /workflow_node_resume_tool_authority_mismatch/u,
  );
  assert.deepEqual(fixture.calls, {
    begin: 0,
    recovery: 0,
    validate: 0,
    dispatch: 0,
    execute: 0,
    reconcile: 0,
    commit: 0,
  });
});

test("provider identity drift and an unprovable history boundary fail closed", async () => {
  const providerDrift = resumeFixture();
  providerDrift.runtime.kernel.modelIdentity.modelId = "other-model";
  await assert.rejects(
    prepareWorkflowAgentContinuationResume(
      providerDrift.dependencies,
      providerDrift.input(),
    ),
    /workflow_node_resume_authority_mismatch/u,
  );
  assert.equal(providerDrift.loadRunCalls, 0);

  const missingBoundary = resumeFixture();
  missingBoundary.resume.continuation.history = [
    { type: "message", role: "user", content: "no response boundary" },
  ];
  await assert.rejects(
    prepareWorkflowAgentContinuationResume(
      missingBoundary.dependencies,
      missingBoundary.input(),
    ),
    /workflow_node_resume_history_boundary_missing/u,
  );
  assert.equal(missingBoundary.modelCalls, 0);
  assert.equal(missingBoundary.toolCalls, 0);
});

function resumeFixture() {
  const providerCheckpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0" as const,
    adapterName: "responses",
    adapterVersion: "1",
    modelId: "model-1",
    opaquePayload: { responseId: "resp-1" },
  };
  const node = {
    nodeId: "node-a",
    title: "Agent",
    instruction: "work",
    kind: "agent" as const,
    agentVersionId: "agent-a",
    dependsOn: [],
    inputSchema: schema,
    outputSchema: schema,
  };
  const claim = {
    workItem: {
      workItemId: "reconcile-work",
      tenantId: "tenant-1",
      runId: "run-1",
      kind: "run.execute" as const,
      payload: {},
      createdAt: "2026-08-19T00:00:00.000Z",
    },
    lease: {
      ownerId: "worker-1",
      leaseId: "lease-1",
      epoch: 3,
      expiresAt: "2026-08-19T00:01:00.000Z",
    },
  };
  const reconciliationLease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  const authority = {
    tenantId: claim.workItem.tenantId,
    runId: claim.workItem.runId,
    workItemId: claim.workItem.workItemId,
    leaseEpoch: claim.lease.epoch,
    nodeId: node.nodeId,
    nodeKind: node.kind,
    claimId: "claim-1",
    claimEpoch: 2,
    agentVersionId: node.agentVersionId,
    attempt: { stepId: "step-1", attemptId: "attempt-1" },
  } as const;
  const resume: MutableResume = {
    claim: {
      node,
      claimId: authority.claimId,
      claimEpoch: authority.claimEpoch,
      gateRequestId: null,
      inputDigest: digest("input"),
    },
    reconciliationLease,
    pendingTools: [],
    step: {
      schemaVersion: "crewon.run-step.v0",
      stepId: authority.attempt.stepId,
      tenantId: authority.tenantId,
      runId: authority.runId,
      kind: "workflowNode",
      status: "running",
      revision: 2,
      currentAttemptId: authority.attempt.attemptId,
      attemptCount: 1,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:01.000Z",
      terminalAt: null,
    },
    attempt: {
      schemaVersion: "crewon.run-attempt.v0",
      attemptId: authority.attempt.attemptId,
      tenantId: authority.tenantId,
      runId: authority.runId,
      stepId: authority.attempt.stepId,
      workItemId: authority.workItemId,
      attemptNumber: 1,
      retryOfAttemptId: null,
      leaseEpoch: authority.leaseEpoch,
      status: "running",
      checkpointDigest: digest(canonicalJson(providerCheckpoint)),
      providerCheckpoint,
      providerTurnState: null,
      failure: null,
      startedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:01.000Z",
      terminalAt: null,
    },
    continuation: {
      schemaVersion: "crewon.workflow-node-continuation.v0",
      authority,
      segmentId: "segment:attempt-1",
      modelSampleIndex: 0,
      toolRoundsConsumed: 0,
      providerCheckpoint,
      providerTurnState: null,
      activeDispatch: null,
      terminalCandidate: null,
      history: [
        { type: "message", role: "user", content: "work" },
        { type: "message", role: "assistant", content: "continue" },
      ],
      revision: 2,
      updatedAt: "2026-08-19T00:00:01.000Z",
    },
  };
  const runtime = {
    version: {
      agentVersionId: node.agentVersionId,
      tools: [],
    },
    kernel: {
      modelIdentity: {
        adapterName: providerCheckpoint.adapterName,
        adapterVersion: providerCheckpoint.adapterVersion,
        modelId: providerCheckpoint.modelId,
      },
    },
    toolRuntime: {
      executionPolicy() {
        return null;
      },
      async execute() {
        fixture.toolCalls += 1;
        throw new Error("committed Tool effect must not repeat");
      },
      async reconcile() {
        throw new Error("not used");
      },
    },
  };
  const fixture = {
    events: [] as unknown[],
    loadRunCalls: 0,
    modelCalls: 0,
    toolCalls: 0,
    providerCheckpoint,
    resume,
    runtime,
  };
  const dependencies = {
    execution: {
      async loadRun() {
        fixture.loadRunCalls += 1;
        return {
          tenantId: claim.workItem.tenantId,
          runId: claim.workItem.runId,
          lastSequence: fixture.events.length,
          cancelRequested: false,
        };
      },
    } as never,
    store: {
      async listRunEvents() {
        return fixture.events;
      },
    } as never,
    approvalTtlMs: 1_000,
    approvalRecheckMs: 100,
  };
  const input = () => ({
    claim,
    binding: {
      workflowId: "workflow-1",
      workflowVersionId: "workflow-version-1",
      contentDigest: digest("workflow"),
    },
    node,
    resume,
    runtime: runtime as never,
  });
  return Object.assign(fixture, { dependencies, input });
}

function pendingToolFixture(
  status: "prepared" | "dispatched" | "unknownOutcome",
) {
  const fixture = resumeFixture();
  const call = {
    segmentId: fixture.resume.continuation.segmentId,
    callId: "call-1",
    kind: "function" as const,
    name: "lookup",
    input: "{}",
  };
  fixture.resume.continuation.history = [
    { type: "message", role: "assistant", content: "calling" },
    { type: "tool_call", ...call },
  ];
  fixture.events = [
    {
      sequence: 1,
      type: "tool.requested",
      data: { ...call, segmentSequence: 1 },
    },
  ];
  fixture.resume.pendingTools = [adoptedTool(fixture, call, status)];
  Object.assign(fixture.runtime.version, {
    policySnapshotId: "policy-1",
    tools: [{ kind: "function", name: "lookup" }],
  });
  const calls = {
    begin: 0,
    recovery: 0,
    validate: 0,
    dispatch: 0,
    execute: 0,
    reconcile: 0,
    commit: 0,
  };
  Object.assign(fixture.dependencies.execution, {
    validateToolExecutionInput() {
      calls.validate += 1;
    },
    async beginToolExecution() {
      calls.begin += 1;
      throw new Error("new Tool Attempt forbidden");
    },
    async beginToolRecovery() {
      calls.recovery += 1;
      throw new Error("Tool recovery Attempt forbidden");
    },
    async dispatchToolExecution(_claim: unknown, receipt: object) {
      calls.dispatch += 1;
      return { ...receipt, status: "dispatched" };
    },
  });
  Object.assign(fixture.runtime.toolRuntime, {
    executionPolicy: () => toolPolicy,
    execute: async () => {
      calls.execute += 1;
      return toolCompleted;
    },
    reconcile: async () => {
      calls.reconcile += 1;
      return toolCompleted;
    },
  });
  Object.assign(fixture.dependencies.store, {
    async commitWorkflowToolContinuation(input: {
      receipt: object;
      next: object;
    }) {
      calls.commit += 1;
      return {
        receipt: { ...input.receipt, status: "completed" },
        continuation: {
          ...input.next,
          revision: fixture.resume.continuation.revision + 1,
          updatedAt: "2026-08-19T00:00:02.000Z",
        },
      };
    },
  });
  return Object.assign(fixture, { calls });
}

function adoptedTool(
  fixture: ReturnType<typeof resumeFixture>,
  call: Readonly<{
    segmentId: string;
    callId: string;
    kind: "function";
    name: string;
    input: string;
  }>,
  status: "prepared" | "dispatched" | "unknownOutcome",
): WorkflowPendingToolResume {
  const claim = fixture.input().claim;
  const stepId = "tool-step-1";
  const attemptId = "tool-attempt-1";
  return {
    receipt: {
      schemaVersion: "crewon.tool-execution-receipt.v0",
      receiptId: "receipt-1",
      tenantId: claim.workItem.tenantId,
      runId: claim.workItem.runId,
      stepId,
      attemptId,
      workItemId: claim.workItem.workItemId,
      executionId: "execution-1",
      idempotencyKey: "tool-key-1",
      actionDigest: digest("action"),
      actionIntent: {
        schemaVersion: "crewon.action-intent.v0",
        runId: claim.workItem.runId,
        segmentId: call.segmentId,
        callId: call.callId,
        tool: {
          kind: call.kind,
          name: call.name,
          inputDigest: digest(call.input),
        },
        ...toolPolicy,
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
      },
      call: {
        segmentId: call.segmentId,
        callId: call.callId,
        kind: call.kind,
        name: call.name,
        inputDigest: digest(call.input),
      },
      effect: toolPolicy.effect,
      recovery: toolPolicy.recovery,
      status,
      revision: 2,
      providerReceiptId: status === "unknownOutcome" ? "provider-1" : null,
      result: null,
      preparedAt: "2026-08-19T00:00:00.000Z",
      dispatchedAt: status === "prepared" ? null : "2026-08-19T00:00:01.000Z",
      updatedAt: "2026-08-19T00:00:01.000Z",
      resolvedAt: null,
    },
    step: {
      schemaVersion: "crewon.run-step.v0",
      stepId,
      tenantId: claim.workItem.tenantId,
      runId: claim.workItem.runId,
      kind: "tool",
      status: "running",
      revision: 2,
      currentAttemptId: attemptId,
      attemptCount: 1,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:01.000Z",
      terminalAt: null,
    },
    attempt: {
      schemaVersion: "crewon.run-attempt.v0",
      attemptId,
      tenantId: claim.workItem.tenantId,
      runId: claim.workItem.runId,
      stepId,
      workItemId: claim.workItem.workItemId,
      attemptNumber: 1,
      retryOfAttemptId: null,
      leaseEpoch: claim.lease.epoch,
      status: "running",
      checkpointDigest: null,
      providerCheckpoint: null,
      providerTurnState: null,
      failure: null,
      startedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:01.000Z",
      terminalAt: null,
    },
  };
}

type MutableResume = Omit<
  WorkflowNodeContinuationResume,
  "continuation" | "pendingTools"
> & {
  pendingTools: WorkflowPendingToolResume[];
  continuation: Omit<
    WorkflowNodeContinuationResume["continuation"],
    "history"
  > & {
    history: import("@crewon/application").WorkflowContinuationHistoryItem[];
  };
};

const toolPolicy = {
  effect: "readOnly" as const,
  recovery: "replaySafe" as const,
  resourceBindingId: null,
  credentialBindingId: null,
  executionTarget: { kind: "control" as const, bindingId: "lookup" },
  capability: "workspace.read",
  approvalRequirement: "none" as const,
  limits: { timeoutMs: 1_000, maxOutputBytes: 1_024, maxArtifactBytes: 1_024 },
};
const toolCompleted = {
  status: "completed" as const,
  executionId: "execution-1",
  providerReceiptId: "provider-1",
  result: {
    schemaVersion: "crewon.tool-result.v0" as const,
    callId: "call-1",
    output: "done",
    isError: false,
    artifactRef: null,
  },
};

const schema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
