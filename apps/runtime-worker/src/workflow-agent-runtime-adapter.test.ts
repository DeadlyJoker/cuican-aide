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
        status: "running",
        attemptNumber: 7,
        providerTurnState: null,
      };
    },
    async renewWorkItemLease() {
      calls.push("renew");
      return {};
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
