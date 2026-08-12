import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowAgentRuntimeAdapter } from "./workflow-agent-runtime-adapter.ts";

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
