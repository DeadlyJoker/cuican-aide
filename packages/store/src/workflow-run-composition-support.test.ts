import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { WorkflowExecutionState } from "@crewon/application";
import { compileWorkflowVersion } from "@crewon/domain";

import {
  hasReadyWorkflowNodes,
  scheduleReadyNodes,
  settleWorkflowClaim,
} from "./workflow-run-composition-support.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const objectSchema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const workflow = compileWorkflowVersion(
  {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    name: "parallel gate",
    description: "parallel gate",
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    entryNodeIds: ["root", "gate"],
    outputNodeIds: ["join"],
    nodes: [
      {
        ...node("root", []),
        kind: "agent",
        agentVersionId: "agent-v1",
      },
      {
        ...node("gate", []),
        kind: "humanGate",
        approvalPolicyId: "approval-1",
      },
      {
        ...node("child", ["root"]),
        kind: "agent",
        agentVersionId: "agent-v1",
      },
      {
        ...node("join", ["child", "gate"]),
        kind: "verification",
        verifierAgentVersionId: "verifier-v1",
        inputSchema: fanInSchema(["child", "gate"]),
      },
    ],
  },
  digester,
);

test("schedules a ready branch while an independent Human Gate remains active", () => {
  const execution = state([
    executionNode("root", "agent", "completed"),
    executionNode("gate", "humanGate", "waitingHuman"),
    executionNode("child", "agent", "pending"),
    executionNode("join", "verification", "pending"),
  ]);
  assert.equal(hasReadyWorkflowNodes(execution, workflow), true);
  const scheduled = scheduleReadyNodes({
    execution,
    workflow,
    operationId: "schedule-child",
    now: "2026-08-19T00:00:01.000Z",
    digester,
  });
  assert.deepEqual(
    scheduled.execution.nodes.map(({ nodeId, status }) => ({ nodeId, status })),
    [
      { nodeId: "root", status: "completed" },
      { nodeId: "gate", status: "waitingHuman" },
      { nodeId: "child", status: "queued" },
      { nodeId: "join", status: "pending" },
    ],
  );
  assert.deepEqual(
    scheduled.claims.map(({ node, claimEpoch }) => ({
      nodeId: node.nodeId,
      claimEpoch,
    })),
    [{ nodeId: "child", claimEpoch: 1 }],
  );
});

test("failure atomically cancels every unadmitted node before convergence", () => {
  const execution = state([
    executionNode("root", "agent", "running", "claim-root"),
    executionNode("gate", "humanGate", "waitingHuman", "claim-gate"),
    executionNode("child", "agent", "pending"),
    executionNode("join", "verification", "pending"),
  ]);
  const failed = settleWorkflowClaim({
    execution,
    nodeId: "root",
    claimId: "claim-root",
    claimEpoch: 1,
    outcome: { status: "failed", failureCode: "model_failed" },
    now: "2026-08-19T00:00:01.000Z",
  });
  assert.deepEqual(
    failed.nodes.map(({ nodeId, status }) => ({ nodeId, status })),
    [
      { nodeId: "root", status: "failed" },
      { nodeId: "gate", status: "waitingHuman" },
      { nodeId: "child", status: "canceled" },
      { nodeId: "join", status: "canceled" },
    ],
  );
  assert.equal(failed.status, "running");
  const converged = settleWorkflowClaim({
    execution: failed,
    nodeId: "gate",
    claimId: "claim-gate",
    claimEpoch: 1,
    outcome: { status: "failed", failureCode: "gate_rejected" },
    now: "2026-08-19T00:00:02.000Z",
  });
  assert.equal(converged.status, "failed");
  assert.equal(
    converged.nodes.some((item) => item.status === "pending"),
    false,
  );
});

function node(nodeId: string, dependsOn: readonly string[]) {
  return {
    nodeId,
    title: nodeId,
    instruction: nodeId,
    dependsOn: [...dependsOn],
    inputSchema: objectSchema,
    outputSchema: objectSchema,
  };
}

function fanInSchema(keys: readonly string[]) {
  return {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, objectSchema])),
    required: [...keys],
    additionalProperties: false as const,
  };
}

function executionNode(
  nodeId: string,
  kind: "agent" | "humanGate" | "verification",
  status: WorkflowExecutionState["nodes"][number]["status"],
  claimId: string | null = null,
): WorkflowExecutionState["nodes"][number] {
  return {
    nodeId,
    kind,
    agentVersionId:
      kind === "agent"
        ? "agent-v1"
        : kind === "verification"
          ? "verifier-v1"
          : null,
    status,
    claimId,
    claimOperationId: claimId === null ? null : `operation-${nodeId}`,
    claimEpoch: claimId === null ? 0 : 1,
    leaseExpiresAt: null,
    gateRequestId: kind === "humanGate" ? "gate-request-1" : null,
    inputDigest: claimId === null ? null : digester.sha256(nodeId),
    resultDigest: status === "completed" ? digester.sha256(nodeId) : null,
    failureCode: null,
  };
}

function state(
  nodes: readonly WorkflowExecutionState["nodes"][number][],
): WorkflowExecutionState {
  return {
    schemaVersion: "crewon.workflow-execution.v0",
    tenantId: "tenant-1",
    runId: "run-1",
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    revision: 3,
    status: "running",
    cancelRequested: false,
    nodes,
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}
