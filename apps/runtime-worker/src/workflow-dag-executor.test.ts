import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkflowExecutionService } from "@crewon/application";
import { compileWorkflowVersion } from "@crewon/domain";
import { SqliteWorkflowExecutionStore } from "@crewon/store";

import { WorkflowDagExecutor } from "./workflow-dag-executor.ts";

const objectSchema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const node = (nodeId: string, dependsOn: string[]) => ({
  nodeId,
  title: nodeId,
  instruction: nodeId,
  dependsOn,
  inputSchema: objectSchema,
  outputSchema: objectSchema,
});
const workflow = compileWorkflowVersion(
  {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-1",
    workflowVersionId: "version-1",
    name: "workflow",
    description: "workflow",
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    entryNodeIds: ["agent"],
    outputNodeIds: ["verify"],
    nodes: [
      { ...node("agent", []), kind: "agent", agentVersionId: "agent-node" },
      {
        ...node("gate", ["agent"]),
        kind: "humanGate",
        approvalPolicyId: "policy-1",
      },
      {
        ...node("verify", ["gate"]),
        kind: "verification",
        verifierAgentVersionId: "verifier-node",
      },
    ],
  },
  { sha256: digest },
);
const binding = {
  workflowId: workflow.workflowId,
  workflowVersionId: workflow.workflowVersionId,
  contentDigest: workflow.contentDigest,
};

test("dispatches frozen Agent and verifier identities while releasing a durable Human Gate", async () => {
  const database = new DatabaseSync(":memory:");
  let sequence = 0;
  const execution = new WorkflowExecutionService({
    store: new SqliteWorkflowExecutionStore(database),
    now: () => "2026-08-12T00:00:00.000Z",
    nextId: () => `id-${++sequence}`,
    sha256: digest,
  });
  const dispatched: string[] = [];
  const gates: string[] = [];
  const executor = new WorkflowDagExecutor({
    execution,
    agent: {
      async execute(input) {
        dispatched.push(input.agentVersionId);
        return { status: "completed", resultDigest: digest(input.nodeId) };
      },
    },
    gate: {
      async publish(input) {
        gates.push(input.gateRequestId);
      },
    },
  });
  await execution.initialize({
    tenantId: "tenant-1",
    runId: "run-1",
    binding,
    workflow,
  });
  const tick = async () => {
    const operationId = `tick-${++sequence}`;
    const claims = await execution.claimReady({
      tenantId: "tenant-1",
      runId: "run-1",
      binding,
      workflow,
      leaseDurationMs: 1_000,
      operationId,
    });
    return executor.executeAdmissions({
      tenantId: "tenant-1",
      runId: "run-1",
      binding,
      workflow,
      admissions: claims.map((claim) => ({
        claim,
        step: { stepId: `step:${claim.node.nodeId}` } as never,
        attempt:
          claim.node.kind === "humanGate"
            ? null
            : ({ attemptId: `attempt:${claim.node.nodeId}` } as never),
        agentVersionId:
          claim.node.kind === "agent"
            ? claim.node.agentVersionId
            : claim.node.kind === "verification"
              ? claim.node.verifierAgentVersionId
              : null,
      })),
    });
  };

  assert.equal((await tick()).nodes[0]?.status, "completed");
  const waiting = await tick();
  const gate = waiting.nodes.find((candidate) => candidate.nodeId === "gate")!;
  assert.equal(waiting.status, "waitingHuman");
  assert.equal(gate.status, "waitingHuman");
  assert.equal(gate.leaseExpiresAt, null);
  assert.deepEqual(dispatched, ["agent-node"]);
  assert.equal(gates.length, 1);

  await executor.settleHumanGate({
    tenantId: "tenant-1",
    runId: "run-1",
    binding,
    workflow,
    nodeId: "gate",
    claimId: gate.claimId!,
    operationId: "gate-approved-1",
    approved: true,
    resultDigest: digest("approved"),
  });
  assert.equal((await tick()).status, "completed");
  assert.deepEqual(dispatched, ["agent-node", "verifier-node"]);
  database.close();
});

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
