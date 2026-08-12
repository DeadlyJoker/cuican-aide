import type {
  WorkItemClaim,
  WorkflowRunCompositionStore,
  WorkflowVersionStore,
} from "@crewon/application";
import type { RunState, WorkflowContentDigester } from "@crewon/domain";
import { loadFrozenWorkflowVersion } from "./workflow-version-runtime.ts";
import { parseWorkflowWorkItemPayload } from "./workflow-work-item-payload.ts";

export type WorkflowNodeOutcome =
  | Readonly<{ status: "completed"; resultDigest: string }>
  | Readonly<{ status: "failed"; failureCode: string }>
  | Readonly<{ status: "canceled" }>
  | Readonly<{ status: "unknown" }>;

export interface WorkflowAgentNodePort {
  execute(input: {
    tenantId: string;
    runId: string;
    nodeId: string;
    agentVersionId: string;
    inputDigest: string;
    claimId: string;
    claimEpoch: number;
    stepId: string;
    attemptId: string;
  }): Promise<WorkflowNodeOutcome>;
}

export type WorkflowRuntimeDispatchOutcome =
  | Readonly<{ kind: "completed"; runId: string }>
  | Readonly<{ kind: "waitingApproval"; runId: string; approvalId: string }>
  | Readonly<{ kind: "recovery"; runId: string; code: string }>;

export interface WorkflowRuntimeDispatcherPort {
  dispatch(input: {
    claim: WorkItemClaim;
    run: RunState;
  }): Promise<WorkflowRuntimeDispatchOutcome>;
}

/** Internal candidate; production composition remains disabled until every Store transaction exists. */
export class ProductionWorkflowRuntimeDispatcher
  implements WorkflowRuntimeDispatcherPort
{
  readonly #versions: WorkflowVersionStore;
  readonly #composition: WorkflowRunCompositionStore;
  readonly #digester: WorkflowContentDigester;
  readonly #agent: WorkflowAgentNodePort;
  readonly #leaseDurationMs: number;

  constructor(dependencies: {
    versions: WorkflowVersionStore;
    composition: WorkflowRunCompositionStore;
    digester: WorkflowContentDigester;
    agent: WorkflowAgentNodePort;
    leaseDurationMs: number;
  }) {
    this.#versions = dependencies.versions;
    this.#composition = dependencies.composition;
    this.#digester = dependencies.digester;
    this.#agent = dependencies.agent;
    this.#leaseDurationMs = dependencies.leaseDurationMs;
  }

  async dispatch(input: {
    claim: WorkItemClaim;
    run: RunState;
  }): Promise<WorkflowRuntimeDispatchOutcome> {
    const binding = input.run.workflowVersionBinding;
    if (input.run.purpose !== "workflow" || binding === undefined)
      throw new Error("workflow_runtime_dispatch_invalid");
    const payload = parseWorkflowWorkItemPayload(input.claim.workItem.payload);
    if (JSON.stringify(payload.binding) !== JSON.stringify(binding))
      throw new Error("workflow_work_item_binding_mismatch");
    const workflow = await loadFrozenWorkflowVersion({
      tenantId: input.run.tenantId,
      binding,
      store: this.#versions,
      digester: this.#digester,
    });
    if (payload.trigger === "workflowScheduler") {
      const scheduled = await this.#composition.scheduleWorkflowNodes({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        lease: leaseInput(input.claim),
        binding,
        schedulerOperationId: payload.schedulerOperationId,
      });
      assertCompletedHandoff(scheduled.handoff);
      return scheduled.runDisposition === "terminalConverged"
        ? { kind: "completed", runId: input.run.runId }
        : {
            kind: "recovery",
            runId: input.run.runId,
            code:
              scheduled.disposition === "reconcileRequired"
                ? "workflow_scheduler_reconcile_required"
                : "workflow_fanout_committed",
          };
    }
    if (payload.trigger === "workflowNode")
      return this.#executeNode(input, payload, workflow);
    if (payload.trigger === "workflowGateResume") {
      const settled = await this.#composition.settleWorkflowHumanGate({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        lease: leaseInput(input.claim),
        binding,
        nodeId: payload.nodeId,
        claimId: payload.claimId,
        claimEpoch: payload.claimEpoch,
        gateRequestId: payload.gateRequestId,
        decisionReceiptId: payload.decisionReceiptId,
        operationId: `gate-settle:${payload.decisionReceiptId}`,
      });
      assertCompletedHandoff(settled.handoff);
      return settled.runDisposition === "terminalConverged"
        ? { kind: "completed", runId: input.run.runId }
        : {
            kind: "recovery",
            runId: input.run.runId,
            code:
              settled.disposition === "reconciliationScheduled"
                ? "workflow_gate_reconcile_required"
                : "workflow_gate_settled",
          };
    }
    const reconciliation =
      await this.#composition.scheduleWorkflowReconciliation({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        lease: leaseInput(input.claim),
        binding,
        operationId: payload.reconciliationOperationId,
        reasonCode: "workflow_reconciliation_claimed",
        nodeId: payload.nodeId,
        claimId: payload.claimId,
        claimEpoch: payload.claimEpoch,
      });
    assertCompletedHandoff(reconciliation.handoff, "reconcile");
    return {
      kind: "recovery",
      runId: input.run.runId,
      code: "workflow_reconciliation_rescheduled",
    };
  }

  async #executeNode(
    input: { claim: WorkItemClaim; run: RunState },
    payload: Extract<
      ReturnType<typeof parseWorkflowWorkItemPayload>,
      { trigger: "workflowNode" }
    >,
    workflow: Awaited<ReturnType<typeof loadFrozenWorkflowVersion>>,
  ): Promise<WorkflowRuntimeDispatchOutcome> {
    const binding = input.run.workflowVersionBinding!;
    const admitted = await this.#composition.admitWorkflowNodeWork({
      tenantId: input.run.tenantId,
      runId: input.run.runId,
      lease: leaseInput(input.claim),
      binding,
      nodeId: payload.nodeId,
      claimId: payload.claimId,
      claimEpoch: payload.claimEpoch,
      schedulerOperationId: payload.schedulerOperationId,
      admissionOperationId: `node-admit:${payload.claimId}:${input.claim.lease.epoch}`,
      attemptLeaseDurationMs: this.#leaseDurationMs,
    });
    if (admitted.disposition !== "fresh") {
      assertNonFreshAdmissionHandoff(admitted.handoff, admitted.disposition);
      return {
        kind: "recovery",
        runId: input.run.runId,
        code:
          admitted.disposition === "replay"
            ? "workflow_node_admission_replayed"
            : "workflow_node_reconcile_required",
      };
    }
    if (
      admitted.handoff.currentWorkItem !== "retained" ||
      admitted.handoff.kind !== "none" ||
      admitted.handoff.nextWorkItemId !== null
    )
      throw new Error("workflow_fresh_admission_handoff_invalid");
    const node = workflow.nodes.find(
      (candidate) => candidate.nodeId === payload.nodeId,
    );
    const agentVersionId =
      node?.kind === "agent"
        ? node.agentVersionId
        : node?.kind === "verification"
          ? node.verifierAgentVersionId
          : null;
    const state = admitted.execution.nodes.find(
      (candidate) => candidate.nodeId === payload.nodeId,
    );
    if (
      agentVersionId === null ||
      state?.agentVersionId !== agentVersionId ||
      admitted.admission.claim.claimId !== payload.claimId
    )
      throw new Error("workflow_node_execution_identity_mismatch");
    let outcome: WorkflowNodeOutcome;
    try {
      outcome = await this.#agent.execute({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        nodeId: payload.nodeId,
        agentVersionId,
        inputDigest: admitted.admission.claim.inputDigest,
        claimId: payload.claimId,
        claimEpoch: payload.claimEpoch,
        stepId: admitted.admission.step.stepId,
        attemptId: admitted.admission.attempt.attemptId,
      });
    } catch {
      outcome = { status: "unknown" };
    }
    try {
      const settled = await this.#composition.settleWorkflowNode({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        lease: leaseInput(input.claim),
        binding,
        nodeId: payload.nodeId,
        claimId: payload.claimId,
        claimEpoch: payload.claimEpoch,
        stepId: admitted.admission.step.stepId,
        attemptId: admitted.admission.attempt.attemptId,
        operationId: `node-settle:${payload.claimId}`,
        outcome,
      });
      assertCompletedHandoff(settled.handoff);
      return settled.runDisposition === "terminalConverged"
        ? { kind: "completed", runId: input.run.runId }
        : {
            kind: "recovery",
            runId: input.run.runId,
            code: "workflow_node_settled",
          };
    } catch {
      return {
        kind: "recovery",
        runId: input.run.runId,
        code: "workflow_settlement_result_unknown",
      };
    }
  }
}

function assertCompletedHandoff(
  handoff: import("@crewon/application").WorkflowAtomicHandoff,
  expectedKind?: "reconcile",
): void {
  if (
    handoff.currentWorkItem !== "completed" ||
    (expectedKind !== undefined && handoff.kind !== expectedKind) ||
    (handoff.kind === "none"
      ? handoff.nextWorkItemId !== null
      : handoff.nextWorkItemId === null)
  )
    throw new Error("workflow_atomic_handoff_invalid");
}

function assertNonFreshAdmissionHandoff(
  handoff: import("@crewon/application").WorkflowAtomicHandoff,
  disposition: "replay" | "reconcileRequired",
): void {
  if (disposition === "reconcileRequired")
    assertCompletedHandoff(handoff, "reconcile");
  else if (handoff.currentWorkItem === "retained")
    throw new Error("workflow_replay_handoff_ambiguous");
}

function leaseInput(claim: WorkItemClaim) {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
}
