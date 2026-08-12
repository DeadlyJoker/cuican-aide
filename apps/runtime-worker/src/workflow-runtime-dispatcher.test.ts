import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  WorkflowExecutionState,
  WorkflowNodeAttemptAdmission,
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
    entryNodeIds: ["agent"],
    outputNodeIds: ["verify"],
    nodes: [
      {
        nodeId: "agent",
        title: "agent",
        instruction: "execute",
        kind: "agent",
        agentVersionId: "frozen-agent",
        dependsOn: [],
        inputSchema: schema,
        outputSchema: schema,
      },
      {
        nodeId: "gate",
        title: "gate",
        instruction: "approve",
        kind: "humanGate",
        approvalPolicyId: "policy-1",
        dependsOn: ["agent"],
        inputSchema: schema,
        outputSchema: schema,
      },
      {
        nodeId: "verify",
        title: "verify",
        instruction: "verify",
        kind: "verification",
        verifierAgentVersionId: "frozen-verifier",
        dependsOn: ["gate"],
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

test("receipt replay schedules reconciliation with zero duplicate side effects", async () => {
  const store = new CompositionFixture();
  store.admissionDisposition = "replay";
  let executions = 0;
  const dispatcher = createDispatcher(store, {
    async execute() {
      executions += 1;
      return { status: "completed", resultDigest: digest("result") };
    },
  });

  assert.deepEqual(await dispatcher.dispatch(dispatchInput()), {
    kind: "recovery",
    runId: "run-1",
    code: "workflow_reconciliation_scheduled",
  });
  assert.equal(executions, 0);
  assert.equal(store.settlements.length, 0);
  assert.equal(store.reconciliations.length, 1);
});

test("fresh admission executes once and atomically converges Attempt, Step and DAG", async () => {
  const store = new CompositionFixture();
  store.admissions = [agentAdmission()];
  let executions = 0;
  const dispatcher = createDispatcher(store, {
    async execute(input) {
      executions += 1;
      assert.equal(input.agentVersionId, "frozen-agent");
      assert.equal(input.stepId, "step-agent");
      assert.equal(input.attemptId, "attempt-agent");
      return { status: "completed", resultDigest: digest("result") };
    },
  });

  assert.equal((await dispatcher.dispatch(dispatchInput())).kind, "completed");
  assert.equal(executions, 1);
  assert.deepEqual(
    store.settlements.map((settlement) => ({
      nodeId: settlement.nodeId,
      stepId: settlement.stepId,
      attemptId: settlement.attemptId,
      outcome: settlement.outcome,
    })),
    [
      {
        nodeId: "agent",
        stepId: "step-agent",
        attemptId: "attempt-agent",
        outcome: { status: "completed", resultDigest: digest("result") },
      },
    ],
  );

  store.admissionDisposition = "replay";
  store.admissions = [];
  await dispatcher.dispatch(dispatchInput());
  assert.equal(executions, 1);
});

test("durable Human Gate publication atomically releases the current WorkItem", async () => {
  const store = new CompositionFixture();
  store.admissions = [gateAdmission()];
  const dispatcher = createDispatcher(store);

  assert.deepEqual(await dispatcher.dispatch(dispatchInput()), {
    kind: "waitingApproval",
    runId: "run-1",
    approvalId: "gate-request-1",
  });
  assert.equal(store.gateReleases.length, 1);
  assert.equal(
    store.gateReleases[0]?.publicationOutboxMessageId,
    "workflow:run-1:gate-outbox:gate-request-1",
  );
  assert.equal(
    store.gateReleases[0]?.approvalResumeWorkItemId,
    "workflow:run-1:gate-resume:gate-request-1",
  );
  assert.equal(store.reconciliations.length, 0);
});

test("settlement uncertainty schedules durable reconciliation instead of re-execution", async () => {
  const store = new CompositionFixture();
  store.admissions = [agentAdmission()];
  store.failSettlement = true;
  let executions = 0;
  const dispatcher = createDispatcher(store, {
    async execute() {
      executions += 1;
      return { status: "completed", resultDigest: digest("result") };
    },
  });

  assert.deepEqual(await dispatcher.dispatch(dispatchInput()), {
    kind: "recovery",
    runId: "run-1",
    code: "workflow_settlement_recovery_required",
  });
  assert.equal(executions, 1);
  assert.equal(store.reconciliations.length, 1);

  store.admissionDisposition = "replay";
  store.admissions = [];
  await dispatcher.dispatch(dispatchInput());
  assert.equal(executions, 1);
});

test("approval resume atomically settles the gate Step and DAG under its WorkItem lease", async () => {
  const store = new CompositionFixture();
  const dispatcher = createDispatcher(store);

  const outcome = await dispatcher.settleHumanGate({
    ...dispatchInput(),
    nodeId: "gate",
    nodeClaimId: "claim-gate",
    nodeClaimEpoch: 1,
    stepId: "step-gate",
    gateRequestId: "gate-request-1",
    operationId: "approval-receipt-1",
    outcome: { status: "completed", resultDigest: digest("approved") },
  });

  assert.equal(outcome.kind, "completed");
  assert.deepEqual(
    store.gateSettlements.map((settlement) => ({
      workItemId: settlement.lease.workItemId,
      stepId: settlement.stepId,
      gateRequestId: settlement.gateRequestId,
      continuationWorkItemId: settlement.continuationWorkItemId,
    })),
    [
      {
        workItemId: "work-1",
        stepId: "step-gate",
        gateRequestId: "gate-request-1",
        continuationWorkItemId: "workflow:run-1:gate-continue:gate-request-1",
      },
    ],
  );
});

class CompositionFixture implements WorkflowRunCompositionStore {
  admissionDisposition: "fresh" | "replay" | "reconcileRequired" = "fresh";
  admissions: readonly WorkflowNodeAttemptAdmission[] = [];
  failSettlement = false;
  readonly settlements: Parameters<
    WorkflowRunCompositionStore["settleWorkflowNode"]
  >[0][] = [];
  readonly gateReleases: Parameters<
    WorkflowRunCompositionStore["publishWorkflowHumanGate"]
  >[0][] = [];
  readonly reconciliations: Parameters<
    WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]
  >[0][] = [];
  readonly gateSettlements: Parameters<
    WorkflowRunCompositionStore["settleWorkflowHumanGate"]
  >[0][] = [];

  admitWorkflowNodes(): ReturnType<
    WorkflowRunCompositionStore["admitWorkflowNodes"]
  > {
    const execution = executionState("running", this.admissions);
    if (this.admissionDisposition === "fresh") {
      return Promise.resolve({
        disposition: "fresh",
        execution,
        admissions: this.admissions,
        reconciliationClaims: [],
      });
    }
    if (this.admissionDisposition === "replay") {
      return Promise.resolve({
        disposition: "replay",
        execution,
        admissions: [],
        reconciliationClaims: [],
      });
    }
    return Promise.resolve({
      disposition: "reconcileRequired",
      execution,
      admissions: [],
      reconciliationClaims: this.admissions.map(({ claim }) => claim),
    });
  }

  async settleWorkflowNode(
    input: Parameters<WorkflowRunCompositionStore["settleWorkflowNode"]>[0],
  ) {
    this.settlements.push(input);
    if (this.failSettlement) throw new Error("commit_result_unknown");
    return {
      disposition: "settled" as const,
      execution: executionState("completed", []),
    };
  }

  async publishWorkflowHumanGate(
    input: Parameters<
      WorkflowRunCompositionStore["publishWorkflowHumanGate"]
    >[0],
  ) {
    this.gateReleases.push(input);
    return { disposition: "published" as const };
  }

  async settleWorkflowHumanGate(
    input: Parameters<
      WorkflowRunCompositionStore["settleWorkflowHumanGate"]
    >[0],
  ) {
    this.gateSettlements.push(input);
    return {
      disposition: "settled" as const,
      execution: executionState("completed", []),
    };
  }

  async scheduleWorkflowReconciliation(
    input: Parameters<
      WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]
    >[0],
  ) {
    this.reconciliations.push(input);
    return { disposition: "scheduled" as const };
  }
}

function createDispatcher(
  store: WorkflowRunCompositionStore,
  agent: ConstructorParameters<
    typeof ProductionWorkflowRuntimeDispatcher
  >[0]["agent"] = {
    async execute() {
      throw new Error("agent must not execute");
    },
  },
) {
  return new ProductionWorkflowRuntimeDispatcher({
    versions: {
      async loadWorkflowVersion() {
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
    composition: store,
    digester: { sha256: digest },
    agent,
    leaseDurationMs: 30_000,
  });
}

function dispatchInput() {
  return { claim: claim() as never, run: run() as never };
}

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

function agentAdmission() {
  return {
    claim: {
      node: workflow.nodes.find((node) => node.nodeId === "agent")!,
      claimId: "claim-agent",
      claimEpoch: 1,
      gateRequestId: null,
      inputDigest: digest("agent-input"),
    },
    step: { stepId: "step-agent" } as never,
    attempt: { attemptId: "attempt-agent" } as never,
  };
}

function gateAdmission(): WorkflowNodeAttemptAdmission {
  return {
    claim: {
      node: workflow.nodes.find((node) => node.nodeId === "gate")!,
      claimId: "claim-gate",
      claimEpoch: 1,
      gateRequestId: "gate-request-1",
      inputDigest: digest("gate-input"),
    },
    step: { stepId: "step-gate" } as never,
    attempt: null,
  };
}

function executionState(
  status: WorkflowExecutionState["status"],
  admissions: readonly WorkflowNodeAttemptAdmission[],
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
    nodes: admissions.map(({ claim }) => ({
      nodeId: claim.node.nodeId,
      kind: claim.node.kind,
      agentVersionId:
        claim.node.kind === "agent"
          ? claim.node.agentVersionId
          : claim.node.kind === "verification"
            ? claim.node.verifierAgentVersionId
            : null,
      status: claim.node.kind === "humanGate" ? "waitingHuman" : "running",
      claimId: claim.claimId,
      claimOperationId: "operation-1",
      claimEpoch: claim.claimEpoch,
      leaseExpiresAt: null,
      gateRequestId: claim.gateRequestId,
      inputDigest: claim.inputDigest,
      resultDigest: null,
      failureCode: null,
    })),
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
