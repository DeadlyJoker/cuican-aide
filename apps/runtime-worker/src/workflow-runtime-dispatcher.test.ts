import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { WorkflowRunCompositionStore } from "@crewon/application";
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
    workflowId: "wf",
    workflowVersionId: "v1",
    name: "wf",
    description: "wf",
    inputSchema: schema,
    outputSchema: schema,
    entryNodeIds: ["a"],
    outputNodeIds: ["z"],
    nodes: [
      {
        nodeId: "a",
        title: "a",
        instruction: "a",
        kind: "agent",
        agentVersionId: "agent-a",
        dependsOn: [],
        inputSchema: schema,
        outputSchema: schema,
      },
      {
        nodeId: "z",
        title: "z",
        instruction: "z",
        kind: "verification",
        verifierAgentVersionId: "agent-z",
        dependsOn: ["a"],
        inputSchema: schema,
        outputSchema: schema,
      },
    ],
  },
  { sha256: digest },
);
const binding = {
  workflowId: "wf",
  workflowVersionId: "v1",
  contentDigest: workflow.contentDigest,
};

test("scheduler receipt fanout never executes a node", async () => {
  const fixture = composition();
  let executions = 0;
  const dispatcher = create(fixture.store, async () => {
    executions += 1;
    return { status: "completed", resultDigest: digest("x") };
  });
  const outcome = await dispatcher.dispatch(input("scheduler"));
  assert.deepEqual(outcome, {
    kind: "recovery",
    runId: "r",
    code: "workflow_fanout_committed",
  });
  assert.equal(executions, 0);
  assert.equal(fixture.schedules, 1);
});

test("node admission replay performs zero duplicate side effects", async () => {
  const fixture = composition();
  fixture.nodeDisposition = "replay";
  let executions = 0;
  const dispatcher = create(fixture.store, async () => {
    executions += 1;
    return { status: "completed", resultDigest: digest("x") };
  });
  await dispatcher.dispatch(input("node"));
  assert.equal(executions, 0);
  assert.equal(fixture.settlements, 0);
});

test("fresh sibling node WorkItems execute and settle independently in reverse order", async () => {
  const left = composition();
  const right = composition();
  const order: string[] = [];
  const run = async (
    fixture: ReturnType<typeof composition>,
    claimId: string,
  ) =>
    create(fixture.store, async (node) => {
      order.push(node.claimId);
      return { status: "completed", resultDigest: digest(node.claimId) };
    }).dispatch(input("node", claimId));
  await run(right, "claim-right");
  await run(left, "claim-left");
  assert.deepEqual(order, ["claim-right", "claim-left"]);
  assert.equal(left.settlements, 1);
  assert.equal(right.settlements, 1);
});

test("uncertain settlement does not issue a second mutation under the node lease", async () => {
  const fixture = composition();
  fixture.failSettlement = true;
  const dispatcher = create(fixture.store, async () => ({
    status: "completed",
    resultDigest: digest("x"),
  }));
  assert.deepEqual(await dispatcher.dispatch(input("node")), {
    kind: "recovery",
    runId: "r",
    code: "workflow_settlement_result_unknown",
  });
  assert.equal(fixture.settlements, 1);
  assert.equal(fixture.reconciliations, 0);
});

function composition() {
  const state = (status: "running" | "completed" = "running") => ({
    schemaVersion: "crewon.workflow-execution.v0" as const,
    tenantId: "t",
    runId: "r",
    workflowId: "wf",
    workflowVersionId: "v1",
    contentDigest: workflow.contentDigest,
    revision: 1,
    status,
    cancelRequested: false,
    nodes: [
      {
        nodeId: "a",
        kind: "agent" as const,
        agentVersionId: "agent-a",
        status: "running" as const,
        claimId: "claim-1",
        claimOperationId: "schedule-1",
        claimEpoch: 1,
        leaseExpiresAt: null,
        gateRequestId: null,
        inputDigest: digest("input"),
        resultDigest: null,
        failureCode: null,
      },
    ],
    updatedAt: "2026-08-12T00:00:00Z",
  });
  const fixture = {
    schedules: 0,
    settlements: 0,
    reconciliations: 0,
    nodeDisposition: "fresh" as "fresh" | "replay",
    failSettlement: false,
    store: null as unknown as WorkflowRunCompositionStore,
  };
  fixture.store = {
    async scheduleWorkflowNodes() {
      fixture.schedules += 1;
      return {
        disposition: "replay",
        execution: state(),
        nodeWorkItems: [],
        gatePublications: [],
        reconciliationClaims: [],
        handoff: {
          currentWorkItem: "completed",
          nextWorkItemId: null,
          kind: "none",
        },
        runDisposition: "nonTerminal",
      };
    },
    async admitWorkflowNodeWork(input) {
      if (fixture.nodeDisposition === "replay")
        return {
          disposition: "replay",
          execution: state(),
          admission: null,
          handoff: {
            currentWorkItem: "completed",
            nextWorkItemId: null,
            kind: "none",
          },
        };
      const claim = {
        node: workflow.nodes[0]!,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        gateRequestId: null,
        inputDigest: digest("input"),
      };
      return {
        disposition: "fresh",
        execution: {
          ...state(),
          nodes: [{ ...state().nodes[0]!, claimId: input.claimId }],
        },
        admission: {
          claim,
          step: { stepId: `step-${input.claimId}` } as never,
          attempt: { attemptId: `attempt-${input.claimId}` } as never,
        },
        handoff: {
          currentWorkItem: "retained",
          nextWorkItemId: null,
          kind: "none",
        },
      };
    },
    async settleWorkflowNode() {
      fixture.settlements += 1;
      if (fixture.failSettlement) throw new Error("commit unknown");
      return {
        disposition: "settled",
        execution: state("completed"),
        schedulerContinuationWorkItemId: null,
        handoff: {
          currentWorkItem: "completed",
          nextWorkItemId: null,
          kind: "none",
        },
        runDisposition: "terminalConverged",
      };
    },
    async recordWorkflowHumanGateDecision() {
      throw new Error("not used");
    },
    async settleWorkflowHumanGate() {
      throw new Error("not used");
    },
    async scheduleWorkflowReconciliation() {
      fixture.reconciliations += 1;
      return {
        disposition: "scheduled",
        reconciliationWorkItemId: "wf1:rec:hash",
        handoff: {
          currentWorkItem: "completed",
          nextWorkItemId: "wf1:rec:hash",
          kind: "reconcile",
        },
      };
    },
    async cancelWorkflowExecution() {
      throw new Error("not used");
    },
  };
  return fixture;
}

function create(
  store: WorkflowRunCompositionStore,
  execute: ConstructorParameters<
    typeof ProductionWorkflowRuntimeDispatcher
  >[0]["agent"]["execute"],
) {
  return new ProductionWorkflowRuntimeDispatcher({
    versions: {
      async loadWorkflowVersion() {
        return {
          schemaVersion: "crewon.workflow-version-asset.v0",
          tenantId: "t",
          workflowId: "wf",
          workflowVersionId: "v1",
          contentDigest: workflow.contentDigest,
          definitionJson: serializeCompiledWorkflowVersion(workflow),
          createdAt: "2026-08-12T00:00:00Z",
        };
      },
      async registerWorkflowVersion() {
        throw new Error();
      },
      async listWorkflowVersions() {
        throw new Error();
      },
    },
    composition: store,
    digester: { sha256: digest },
    agent: { execute },
    leaseDurationMs: 30_000,
  });
}
function input(kind: "scheduler" | "node", claimId = "claim-1") {
  const payload =
    kind === "scheduler"
      ? {
          schemaVersion: "crewon.workflow-scheduler-work-item.v0",
          trigger: "workflowScheduler",
          binding,
          schedulerOperationId: "schedule-1",
        }
      : {
          schemaVersion: "crewon.workflow-node-work-item.v0",
          trigger: "workflowNode",
          binding,
          nodeId: "a",
          claimId,
          claimEpoch: 1,
          schedulerOperationId: "schedule-1",
        };
  return {
    run: {
      purpose: "workflow",
      workflowVersionBinding: binding,
      tenantId: "t",
      runId: "r",
    } as never,
    claim: {
      workItem: {
        workItemId: `work-${claimId}`,
        tenantId: "t",
        runId: "r",
        payload,
      },
      lease: { ownerId: "o", leaseId: "l", epoch: 1 },
    } as never,
  };
}
function digest(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
