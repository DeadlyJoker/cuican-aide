import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  WorkflowExecutionState,
  WorkflowRunCompositionStore,
} from "@crewon/application";
import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
} from "@crewon/domain";

import { ProductionWorkflowRuntimeDispatcher } from "./workflow-runtime-dispatcher.ts";

const schema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const workflow = compileWorkflowVersion(
  {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-1",
    workflowVersionId: "version-1",
    name: "workflow",
    description: "workflow",
    inputSchema: schema,
    outputSchema: schema,
    entryNodeIds: ["node-1"],
    outputNodeIds: ["verify-1"],
    nodes: [
      {
        nodeId: "node-1",
        title: "node",
        instruction: "execute",
        kind: "agent",
        agentVersionId: "frozen-node-agent",
        dependsOn: [],
        inputSchema: schema,
        outputSchema: schema,
      },
      {
        nodeId: "verify-1",
        title: "verify",
        instruction: "verify",
        kind: "verification",
        verifierAgentVersionId: "frozen-verifier-agent",
        dependsOn: ["node-1"],
        inputSchema: schema,
        outputSchema: schema,
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

test("loads the immutable binding and admits through the atomic composition boundary", async () => {
  const admitted: Parameters<
    WorkflowRunCompositionStore["admitWorkflowNodes"]
  >[0][] = [];
  const composition: WorkflowRunCompositionStore = {
    async admitWorkflowNodes(input) {
      admitted.push(input);
      return { execution: state("running"), admissions: [] };
    },
  };
  let executed = 0;
  const dispatcher = new ProductionWorkflowRuntimeDispatcher({
    versions: {
      async loadWorkflowVersion(input) {
        assert.equal(input.workflowVersionId, "version-1");
        return {
          schemaVersion: "crewon.workflow-version-asset.v0",
          tenantId: "tenant-1",
          workflowId: workflow.workflowId,
          workflowVersionId: workflow.workflowVersionId,
          contentDigest: workflow.contentDigest,
          definitionJson: serializeCompiledWorkflowVersion(workflow),
          createdAt: "2026-08-12T00:00:00.000Z",
        };
      },
      async registerWorkflowVersion() {
        throw new Error("not used");
      },
      async listWorkflowVersions() {
        throw new Error("not used");
      },
    },
    composition,
    digester: { sha256: digest },
    leaseDurationMs: 30_000,
    executor: {
      async executeAdmissions(input) {
        executed += 1;
        assert.deepEqual(input.workflow, workflow);
        return state("completed");
      },
      async settleHumanGate() {
        throw new Error("not used");
      },
    },
  });

  assert.deepEqual(
    await dispatcher.dispatch({ claim: claim() as never, run: run() as never }),
    { kind: "completed", runId: "run-1" },
  );
  assert.equal(executed, 1);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]?.schedulerOperationId, "workflow:work-1:7");
  assert.deepEqual(admitted[0]?.binding, binding);
});

test("fails closed before admission when immutable content does not match", async () => {
  let admitted = false;
  const dispatcher = new ProductionWorkflowRuntimeDispatcher({
    versions: {
      async loadWorkflowVersion() {
        return {
          schemaVersion: "crewon.workflow-version-asset.v0",
          tenantId: "tenant-1",
          workflowId: workflow.workflowId,
          workflowVersionId: workflow.workflowVersionId,
          contentDigest: `${workflow.contentDigest}-tampered`,
          definitionJson: serializeCompiledWorkflowVersion(workflow),
          createdAt: "2026-08-12T00:00:00.000Z",
        };
      },
      async registerWorkflowVersion() {
        throw new Error("not used");
      },
      async listWorkflowVersions() {
        throw new Error("not used");
      },
    },
    composition: {
      async admitWorkflowNodes() {
        admitted = true;
        throw new Error("must not admit");
      },
    },
    digester: { sha256: digest },
    leaseDurationMs: 30_000,
    executor: {
      async executeAdmissions() {
        throw new Error("not used");
      },
      async settleHumanGate() {
        throw new Error("not used");
      },
    },
  });

  await assert.rejects(
    dispatcher.dispatch({ claim: claim() as never, run: run() as never }),
    /workflow_version_binding_unresolvable/,
  );
  assert.equal(admitted, false);
});

test("uses the admitted Workflow node identity and rejects root-agent substitution", async () => {
  let executed = false;
  const dispatcher = new ProductionWorkflowRuntimeDispatcher({
    versions: versionStore(),
    composition: {
      async admitWorkflowNodes() {
        return {
          execution: {
            ...state("running"),
            nodes: [
              {
                nodeId: "node-1",
                kind: "agent",
                agentVersionId: "root-agent-must-not-substitute",
                status: "running",
                claimId: "claim-1",
                claimOperationId: "operation-1",
                claimEpoch: 1,
                leaseExpiresAt: "2026-08-12T00:01:00.000Z",
                gateRequestId: null,
                inputDigest: digest("input"),
                resultDigest: null,
                failureCode: null,
              },
            ],
          },
          admissions: [
            {
              claim: {
                node: workflow.nodes[0]!,
                claimId: "claim-1",
                claimEpoch: 1,
                gateRequestId: null,
                inputDigest: digest("input"),
              },
              step: { stepId: "step-1" } as never,
              attempt: { attemptId: "attempt-1" } as never,
            },
          ],
        };
      },
    },
    digester: { sha256: digest },
    leaseDurationMs: 30_000,
    executor: {
      async executeAdmissions() {
        executed = true;
        return state("completed");
      },
      async settleHumanGate() {
        throw new Error("not used");
      },
    },
  });

  await assert.rejects(
    dispatcher.dispatch({ claim: claim() as never, run: run() as never }),
    /workflow_node_execution_identity_mismatch/,
  );
  assert.equal(executed, false);
});

function run() {
  return {
    tenantId: "tenant-1",
    runId: "run-1",
    purpose: "workflow",
    workflowVersionBinding: binding,
  };
}

function claim() {
  return {
    workItem: { workItemId: "work-1", tenantId: "tenant-1", runId: "run-1" },
    lease: { ownerId: "worker-1", leaseId: "lease-1", epoch: 7 },
  };
}

function versionStore() {
  return {
    async loadWorkflowVersion() {
      return {
        schemaVersion: "crewon.workflow-version-asset.v0" as const,
        tenantId: "tenant-1",
        workflowId: workflow.workflowId,
        workflowVersionId: workflow.workflowVersionId,
        contentDigest: workflow.contentDigest,
        definitionJson: serializeCompiledWorkflowVersion(workflow),
        createdAt: "2026-08-12T00:00:00.000Z",
      };
    },
    async registerWorkflowVersion() {
      throw new Error("not used");
    },
    async listWorkflowVersions() {
      throw new Error("not used");
    },
  };
}

function state(
  status: WorkflowExecutionState["status"],
): WorkflowExecutionState {
  return {
    schemaVersion: "crewon.workflow-execution.v0",
    tenantId: "tenant-1",
    runId: "run-1",
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    revision: 1,
    status,
    cancelRequested: false,
    nodes: [],
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
