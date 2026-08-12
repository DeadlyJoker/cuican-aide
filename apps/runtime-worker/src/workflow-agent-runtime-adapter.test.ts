import assert from "node:assert/strict";
import test from "node:test";
import {
  SharedWorkflowAdmittedAgentExecutionEngine,
  WorkflowAgentRuntimeAdapter,
} from "./workflow-agent-runtime-adapter.ts";

test("resolves the frozen node runtime and preserves admitted authority and actual input", async () => {
  const runtime = { version: { agentVersionId: "node-agent" } } as never;
  let received:
    | Parameters<
        ConstructorParameters<
          typeof WorkflowAgentRuntimeAdapter
        >[0]["engine"]["execute"]
      >[0]
    | undefined;
  const adapter = new WorkflowAgentRuntimeAdapter({
    runtimes: {
      async resolve(locator) {
        assert.deepEqual(locator, {
          tenantId: "tenant-1",
          agentVersionId: "node-agent",
        });
        return runtime;
      },
    },
    engine: {
      async execute(input) {
        received = input;
        return { status: "completed", value: { answer: 42 } };
      },
    },
  });
  const workItemClaim = { workItem: { workItemId: "node-work" } } as never;
  const inputValue = {
    schemaVersion: "crewon.workflow-execution-value.v0",
    valueId: "value-1",
    value: { task: "run" },
    valueDigest: "sha256:value",
  } as const;
  assert.deepEqual(
    await adapter.execute({
      tenantId: "tenant-1",
      runId: "run-1",
      nodeId: "node-1",
      agentVersionId: "node-agent",
      node: agentNode(),
      inputValue,
      claimId: "claim-1",
      claimEpoch: 2,
      stepId: "step-1",
      attemptId: "attempt-1",
      workItemClaim,
    }),
    { status: "completed", value: { answer: 42 } },
  );
  assert.equal(received?.runtime, runtime);
  assert.equal(received?.authority.workItemClaim, workItemClaim);
  assert.equal(received?.inputValue, inputValue);
});

test("fails closed instead of substituting the root Agent runtime", async () => {
  const adapter = new WorkflowAgentRuntimeAdapter({
    runtimes: {
      async resolve() {
        return null;
      },
    },
    engine: {
      async execute() {
        throw new Error("must not execute");
      },
    },
  });
  await assert.rejects(
    adapter.execute({
      tenantId: "tenant-1",
      runId: "run-1",
      nodeId: "node-1",
      agentVersionId: "node-agent",
      node: agentNode(),
      inputValue: {
        schemaVersion: "crewon.workflow-execution-value.v0",
        valueId: "v",
        value: {},
        valueDigest: "d",
      },
      claimId: "c",
      claimEpoch: 1,
      stepId: "s",
      attemptId: "a",
      workItemClaim: {} as never,
    }),
    /workflow_node_agent_runtime_unavailable/,
  );
});

test("shared engine consumes the supplied attempt and actual value without beginning another attempt", async () => {
  const calls: string[] = [];
  const claim = {
    workItem: {
      workItemId: "node-work",
      tenantId: "tenant-1",
      runId: "run-1",
    },
    lease: { ownerId: "worker", leaseId: "lease-1", epoch: 3 },
  } as never;
  const execution = {
    async loadRun() {
      return { cancelRequested: false };
    },
    async checkpointModelAttempt() {
      calls.push("checkpoint");
    },
    async recordAgentEvent() {
      calls.push("event");
      return {};
    },
    async recordProviderTurnState() {
      calls.push("turn-state");
    },
    async beginModelAttempt() {
      throw new Error("must not begin a second attempt");
    },
  } as never;
  const store = {
    async loadRunAttempt(locator: unknown) {
      assert.deepEqual(locator, {
        tenantId: "tenant-1",
        runId: "run-1",
        stepId: "step-admitted",
        attemptId: "attempt-admitted",
      });
      return {
        tenantId: "tenant-1",
        runId: "run-1",
        stepId: "step-admitted",
        attemptId: "attempt-admitted",
        workItemId: "node-work",
        leaseEpoch: 3,
        status: "running",
        attemptNumber: 7,
        providerTurnState: null,
      };
    },
    async loadRunStep() {
      return { status: "running", currentAttemptId: "attempt-admitted" };
    },
    async renewWorkItemLease() {
      calls.push("renew");
      return {};
    },
    async prepareModelDispatch() {
      throw new Error("unexpected dispatch evidence");
    },
    async markModelDispatchPossiblySent() {
      throw new Error("unexpected dispatch evidence");
    },
    async loadModelDispatchReceipt() {
      throw new Error("unexpected dispatch evidence");
    },
  } as never;
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    execution,
    store,
    leaseDurationMs: 30_000,
  });
  const node = {
    ...agentNode(),
    outputSchema: {
      type: "object" as const,
      properties: {
        answer: { type: "string" as const, maxLength: 32, enum: null },
      },
      required: ["answer"],
      additionalProperties: false as const,
    },
  };
  const outcome = await engine.execute({
    runtime: {
      version: {
        agentVersionId: "node-agent",
        policySnapshotId: "node-policy",
      },
      kernel: {
        supportsModelDispatchEvidence: true,
        modelIdentity: {
          adapterName: "test",
          adapterVersion: "1",
          modelId: "model",
        },
        async *runSegment(contract: { history: readonly unknown[] }) {
          assert.match(
            (contract.history[0] as { content: string }).content,
            /"task":"run"/,
          );
          yield kernelEvent(1, "segment.started", {
            attempt: 7,
            model: "model",
          });
          yield kernelEvent(2, "model.output.delta", {
            delta: '{"answer":"done"}',
          });
          yield kernelEvent(3, "segment.completed", {
            output: '{"answer":"done"}',
          });
        },
      },
      governedContext: { modelItems: () => [] },
    } as never,
    authority: {
      tenantId: "tenant-1",
      runId: "run-1",
      nodeId: "node-1",
      agentVersionId: "node-agent",
      claimId: "claim-1",
      claimEpoch: 1,
      stepId: "step-admitted",
      attemptId: "attempt-admitted",
      workItemClaim: claim,
    },
    node,
    inputValue: {
      schemaVersion: "crewon.workflow-execution-value.v0",
      valueId: "value-1",
      value: { task: "run" },
      valueDigest: "sha256:value",
    },
  });
  assert.deepEqual(outcome, {
    status: "completed",
    value: { answer: "done" },
  });
  assert.deepEqual(calls, [
    "renew",
    "event",
    "renew",
    "renew",
    "event",
  ]);
});

test("workflow lifecycle renews a stalled segment and aborts it on durable cancel", async () => {
  let renewals = 0;
  let runLoads = 0;
  let kernelAborted = false;
  const dependencies = workflowEngineDependencies({
    loadRun: async () => ({ cancelRequested: ++runLoads >= 3 }),
    renew: async () => {
      renewals += 1;
    },
  });
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    ...dependencies,
    leaseDurationMs: 18,
  });
  const outcome = await engine.execute(
    workflowEngineInput(async function* (_contract, signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            kernelAborted = true;
            resolve();
          },
          { once: true },
        );
      });
    }),
  );
  assert.equal(kernelAborted, true);
  assert.ok(renewals > 0);
  assert.deepEqual(outcome, {
    status: "canceled",
  });
  const settledRenewals = renewals;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(renewals, settledRenewals, "heartbeat timer must be closed");
});

test("workflow heartbeat failure aborts a stalled segment without becoming canceled", async () => {
  let renewals = 0;
  let kernelAborted = false;
  const dependencies = workflowEngineDependencies({
    loadRun: async () => ({ cancelRequested: false }),
    renew: async () => {
      renewals += 1;
      throw new Error("lease_renewal_failed");
    },
  });
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    ...dependencies,
    leaseDurationMs: 18,
  });
  await assert.rejects(
    engine.execute(
      workflowEngineInput(async function* (_contract, signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              kernelAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      }),
    ),
    /lease_renewal_failed/,
  );
  assert.equal(kernelAborted, true);
  assert.equal(renewals, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(renewals, 1, "failed heartbeat timer must be closed");
});

test("workflow Direct dispatch fails closed before kernel when evidence Store is missing", async () => {
  let kernelCalls = 0;
  const dependencies = workflowEngineDependencies({
    loadRun: async () => ({ cancelRequested: false }),
    renew: async () => undefined,
  });
  const store = dependencies.store as unknown as Record<string, unknown>;
  delete store.prepareModelDispatch;
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    execution: dependencies.execution,
    store: store as never,
    leaseDurationMs: 30_000,
  });
  await assert.rejects(
    engine.execute(
      workflowEngineInput(async function* () {
        kernelCalls += 1;
      }),
    ),
    /model_dispatch_evidence_store_missing/,
  );
  assert.equal(kernelCalls, 0);
});

function agentNode() {
  return {
    nodeId: "node-1",
    title: "Node",
    instruction: "Complete the node.",
    kind: "agent" as const,
    agentVersionId: "node-agent",
    dependsOn: [],
    inputSchema: {
      type: "object" as const,
      properties: {
        task: { type: "string" as const, maxLength: 32, enum: null },
      },
      required: [],
      additionalProperties: false as const,
    },
    outputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
      additionalProperties: false as const,
    },
  };
}

function kernelEvent(sequence: number, type: string, data: unknown) {
  return {
    schemaVersion: "crewon.agent-event.v0" as const,
    runId: "run-1",
    segmentId: "segment:attempt-admitted",
    sequence,
    type,
    data,
  } as never;
}

function workflowEngineDependencies(input: {
  loadRun: () => Promise<{ cancelRequested: boolean }>;
  renew: () => Promise<void>;
}) {
  return {
    execution: {
      loadRun: input.loadRun,
      async recordAgentEvent() {
        return {};
      },
      async checkpointModelAttempt() {},
      async recordProviderTurnState() {},
    } as never,
    store: {
      async loadRunAttempt() {
        return {
          tenantId: "tenant-1",
          runId: "run-1",
          stepId: "step-admitted",
          attemptId: "attempt-admitted",
          workItemId: "node-work",
          leaseEpoch: 3,
          status: "running",
          attemptNumber: 1,
          providerTurnState: null,
        };
      },
      async loadRunStep() {
        return { status: "running", currentAttemptId: "attempt-admitted" };
      },
      renewWorkItemLease: input.renew,
      async prepareModelDispatch() {},
      async markModelDispatchPossiblySent() {},
      async loadModelDispatchReceipt() {},
    } as never,
  };
}

function workflowEngineInput(
  runSegment: (
    contract: unknown,
    signal: AbortSignal,
  ) => AsyncIterable<never>,
) {
  return {
    runtime: {
      version: {
        agentVersionId: "node-agent",
        policySnapshotId: "node-policy",
      },
      kernel: {
        supportsModelDispatchEvidence: true,
        modelIdentity: {
          adapterName: "test",
          adapterVersion: "1",
          modelId: "model",
        },
        runSegment,
      },
    } as never,
    authority: {
      tenantId: "tenant-1",
      runId: "run-1",
      nodeId: "node-1",
      agentVersionId: "node-agent",
      claimId: "claim-1",
      claimEpoch: 1,
      stepId: "step-admitted",
      attemptId: "attempt-admitted",
      workItemClaim: {
        workItem: {
          workItemId: "node-work",
          tenantId: "tenant-1",
          runId: "run-1",
        },
        lease: { ownerId: "worker", leaseId: "lease-1", epoch: 3 },
      } as never,
    },
    node: agentNode(),
    inputValue: {
      schemaVersion: "crewon.workflow-execution-value.v0" as const,
      valueId: "value-1",
      value: { task: "run" },
      valueDigest: "sha256:value",
    },
  };
}
