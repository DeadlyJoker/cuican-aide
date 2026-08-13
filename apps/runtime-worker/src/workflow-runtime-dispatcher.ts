import type {
  WorkItemClaim,
  WorkflowCancellationResult,
  WorkflowRuntimeStore,
  WorkflowVersionStore,
} from "@crewon/application";
import { canonicalJson, MAX_WORKFLOW_VALUE_BYTES } from "@crewon/application";
import type {
  RunState,
  WorkflowNodeDefinition,
  WorkflowContentDigester,
  WorkflowSchemaValue,
} from "@crewon/domain";
import { loadFrozenWorkflowVersion } from "./workflow-version-runtime.ts";
import {
  parseWorkflowWorkItemPayload,
  type WorkflowWorkItemPayload,
} from "./workflow-work-item-payload.ts";

export type WorkflowNodeOutcome =
  | Readonly<{
      status: "completed";
      value: WorkflowSchemaValue;
      modelTerminal?: WorkflowModelTerminalAuthority;
    }>
  | Readonly<{
      status: "failed";
      failureCode: string;
      modelTerminal?: WorkflowModelTerminalAuthority;
    }>
  | Readonly<{
      status: "canceled";
      modelTerminal?: WorkflowModelTerminalAuthority;
    }>
  | Readonly<{ status: "unknown" }>
  | Readonly<{
      status: "terminalCandidate";
      terminalStatus: "completed" | "failed" | "canceled";
      modelTerminal: WorkflowModelTerminalAuthority;
    }>
  | Readonly<{ status: "waitingApproval"; approvalId: string }>;

export type WorkflowModelTerminalAuthority = Readonly<{
  candidateId: string;
}>;

export interface WorkflowAgentNodePort {
  readonly workflowStore: WorkflowRuntimeStore;
  execute(input: {
    tenantId: string;
    runId: string;
    nodeId: string;
    agentVersionId: string;
    node: WorkflowNodeDefinition;
    inputValue: import("@crewon/application").WorkflowExecutionValue;
    claimId: string;
    claimEpoch: number;
    stepId: string;
    attemptId: string;
    workItemClaim: WorkItemClaim;
    binding: import("@crewon/domain").FrozenWorkflowVersionBinding;
  }): Promise<WorkflowNodeOutcome>;
  resumeToolApproval(input: {
    claim: WorkItemClaim;
    binding: import("@crewon/domain").FrozenWorkflowVersionBinding;
    node: WorkflowNodeDefinition;
    payload: Extract<
      WorkflowWorkItemPayload,
      { trigger: "workflowToolApprovalResume" }
    >;
  }): Promise<WorkflowNodeOutcome>;
}

export type WorkflowRuntimeDispatchOutcome =
  | Readonly<{ kind: "completed"; runId: string }>
  | Readonly<{ kind: "waitingApproval"; runId: string; approvalId: string }>
  | Readonly<{ kind: "retry"; runId: string; code: string }>
  | Readonly<{ kind: "recovery"; runId: string; code: string }>;

export interface WorkflowRuntimeDispatcherPort {
  dispatch(input: {
    claim: WorkItemClaim;
    run: RunState;
  }): Promise<WorkflowRuntimeDispatchOutcome>;
  cancel(input: {
    claim: WorkItemClaim;
    run: RunState;
  }): Promise<WorkflowRuntimeDispatchOutcome>;
}

/** Marks only an execution whose external side effect may already have occurred. */
export class WorkflowNodeSideEffectUncertainError extends Error {
  constructor() {
    super("workflow_node_side_effect_uncertain");
  }
}

/** Production dispatcher backed by one fail-closed Workflow transaction authority. */
export class ProductionWorkflowRuntimeDispatcher
  implements WorkflowRuntimeDispatcherPort
{
  readonly #versions: WorkflowVersionStore;
  readonly #store: WorkflowRuntimeStore;
  readonly #digester: WorkflowContentDigester;
  readonly #agent: WorkflowAgentNodePort;
  readonly #leaseDurationMs: number;

  constructor(dependencies: {
    versions: WorkflowVersionStore;
    store: WorkflowRuntimeStore;
    digester: WorkflowContentDigester;
    agent: WorkflowAgentNodePort;
    leaseDurationMs: number;
  }) {
    this.#versions = dependencies.versions;
    if (dependencies.agent.workflowStore !== dependencies.store)
      throw new Error("workflow_runtime_store_identity_mismatch");
    this.#store = dependencies.store;
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
    if (canonicalJson(payload.binding) !== canonicalJson(binding))
      throw new Error("workflow_work_item_binding_mismatch");
    const workflow = await loadFrozenWorkflowVersion({
      tenantId: input.run.tenantId,
      binding,
      store: this.#versions,
      digester: this.#digester,
    });
    if (payload.trigger === "workflowCancel")
      return this.cancel(input, payload.cancellationOperationId);
    if (payload.trigger === "workflowScheduler") {
      const scheduled = await this.#store.scheduleWorkflowNodes({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        lease: leaseInput(input.claim),
        binding,
        schedulerOperationId: payload.schedulerOperationId,
        workflowInput: payload.workflowInput,
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
    if (payload.trigger === "workflowToolApprovalResume")
      return this.#resumeToolApproval(input, payload, workflow);
    if (payload.trigger === "workflowNode")
      return this.#executeNode(input, payload, workflow);
    if (payload.trigger === "workflowGateResume") {
      const settled = await this.#store.settleWorkflowHumanGate({
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
    if (payload.trigger === "workflowReconcile") {
      if (
        payload.nodeId === null ||
        payload.claimId === null ||
        payload.claimEpoch === null
      )
        throw new Error("workflow_reconciliation_scope_incomplete");
      const reconciled = await this.#store.reconcileWorkflowNode({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        lease: leaseInput(input.claim),
        binding,
        nodeId: payload.nodeId,
        claimId: payload.claimId,
        claimEpoch: payload.claimEpoch,
        reconciliationOperationId: payload.reconciliationOperationId,
      });
      switch (reconciled.disposition) {
        case "retryScheduled":
          if (
            reconciled.handoff.currentWorkItem !== "completed" ||
            reconciled.handoff.kind !== "node" ||
            reconciled.handoff.nextWorkItemId === null
          )
            throw new Error("workflow_reconciliation_retry_handoff_invalid");
          return {
            kind: "recovery",
            runId: input.run.runId,
            code: "workflow_reconciliation_retry_scheduled",
          };
        case "evidenceInsufficient":
          assertCompletedHandoff(reconciled.handoff);
          return {
            kind: "recovery",
            runId: input.run.runId,
            code: "workflow_reconciliation_evidence_insufficient",
          };
        case "retryRequired":
          return {
            kind: "retry",
            runId: input.run.runId,
            code: "workflow_reconciliation_retry_required",
          };
        case "settled":
        case "replay":
          assertCompletedHandoff(reconciled.handoff);
          return reconciled.runDisposition === "terminalConverged"
            ? { kind: "completed", runId: input.run.runId }
            : {
                kind: "recovery",
                runId: input.run.runId,
                code: "workflow_reconciliation_settled",
              };
      }
    }
    throw new Error("workflow_reconciliation_contract_incomplete");
  }

  async cancel(
    input: {
      claim: WorkItemClaim;
      run: RunState;
    },
    operationId?: string,
  ): Promise<WorkflowRuntimeDispatchOutcome> {
    const binding = input.run.workflowVersionBinding;
    if (input.run.purpose !== "workflow" || binding === undefined)
      throw new Error("workflow_runtime_cancel_invalid");
    const payload = parseWorkflowWorkItemPayload(input.claim.workItem.payload);
    if (canonicalJson(payload.binding) !== canonicalJson(binding))
      throw new Error("workflow_work_item_binding_mismatch");
    if (payload.trigger === "workflowReconcile") return this.dispatch(input);
    const cancelOperationId =
      payload.trigger === "workflowCancel"
        ? payload.cancellationOperationId
        : (operationId ?? `workflow-cancel:${input.claim.workItem.workItemId}`);
    const canceled = await this.#store.cancelWorkflowExecution({
      tenantId: input.run.tenantId,
      runId: input.run.runId,
      lease: leaseInput(input.claim),
      binding,
      operationId: cancelOperationId,
      reasonCode: "user_requested",
    });
    assertCancellationProof(canceled);
    if (canceled.disposition === "retryRequired") {
      return {
        kind: "retry",
        runId: input.run.runId,
        code: "workflow_cancellation_retry_required",
      };
    }
    assertCompletedHandoff(canceled.handoff);
    return canceled.runDisposition === "terminalConverged"
      ? { kind: "completed", runId: input.run.runId }
      : {
          kind: "recovery",
          runId: input.run.runId,
          code: "workflow_cancellation_reconcile_required",
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
    const admitted = await this.#store.admitWorkflowNodeWork({
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
      node === undefined ||
      agentVersionId === null ||
      state?.agentVersionId !== agentVersionId ||
      admitted.admission.claim.claimId !== payload.claimId ||
      admitted.admission.inputValue.valueDigest !==
        admitted.admission.claim.inputDigest
    )
      throw new Error("workflow_node_execution_identity_mismatch");
    let outcome: WorkflowNodeOutcome;
    try {
      outcome = await this.#agent.execute({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        nodeId: payload.nodeId,
        agentVersionId,
        node,
        inputValue: admitted.admission.inputValue,
        claimId: payload.claimId,
        claimEpoch: payload.claimEpoch,
        stepId: admitted.admission.step.stepId,
        attemptId: admitted.admission.attempt.attemptId,
        workItemClaim: input.claim,
        binding,
      });
      if (outcome.status === "waitingApproval")
        return {
          kind: "waitingApproval",
          runId: input.run.runId,
          approvalId: outcome.approvalId,
        };
      if (
        outcome.status === "completed" &&
        new TextEncoder().encode(canonicalJson(outcome.value)).length >
          MAX_WORKFLOW_VALUE_BYTES
      )
        throw new Error("workflow_node_output_too_large");
    } catch (error) {
      outcome =
        error instanceof WorkflowNodeSideEffectUncertainError
          ? { status: "unknown" }
          : {
              status: "failed",
              failureCode: deterministicNodeFailureCode(error),
            };
    }
    try {
      const settled =
        outcome.status === "terminalCandidate"
          ? await this.#store.settlePreparedWorkflowNodeTerminal({
              binding,
              operationId: `node-model-terminal:${payload.claimId}`,
              candidateId: outcome.modelTerminal.candidateId,
              lease: leaseInput(input.claim),
              authority: {
                tenantId: input.run.tenantId,
                runId: input.run.runId,
                workItemId: input.claim.workItem.workItemId,
                leaseEpoch: input.claim.lease.epoch,
                nodeId: payload.nodeId,
                nodeKind: node.kind === "agent" ? "agent" : "verification",
                claimId: payload.claimId,
                claimEpoch: payload.claimEpoch,
                agentVersionId,
                attempt: {
                  stepId: admitted.admission.step.stepId,
                  attemptId: admitted.admission.attempt.attemptId,
                },
              },
            })
          : await this.#store.settleWorkflowNode({
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

  async #resumeToolApproval(
    input: { claim: WorkItemClaim; run: RunState },
    payload: Extract<
      WorkflowWorkItemPayload,
      { trigger: "workflowToolApprovalResume" }
    >,
    workflow: Awaited<ReturnType<typeof loadFrozenWorkflowVersion>>,
  ): Promise<WorkflowRuntimeDispatchOutcome> {
    const node = workflow.nodes.find(
      (candidate) => candidate.nodeId === payload.nodeId,
    );
    if (
      node === undefined ||
      (node.kind !== "agent" && node.kind !== "verification")
    )
      throw new Error("workflow_tool_approval_node_invalid");
    const outcome = await this.#agent.resumeToolApproval({
      claim: input.claim,
      binding: payload.binding,
      node,
      payload,
    });
    if (outcome.status === "waitingApproval")
      return {
        kind: "waitingApproval",
        runId: input.run.runId,
        approvalId: outcome.approvalId,
      };
    if (outcome.status === "unknown")
      return {
        kind: "retry",
        runId: input.run.runId,
        code: "workflow_tool_reconciliation_required",
      };
    const settled =
      outcome.status === "terminalCandidate"
        ? await this.#store.settlePreparedWorkflowNodeTerminal({
            binding: payload.binding,
            operationId: `node-model-terminal:${payload.claimId}`,
            candidateId: outcome.modelTerminal.candidateId,
            lease: leaseInput(input.claim),
            authority: {
              tenantId: input.run.tenantId,
              runId: input.run.runId,
              workItemId: input.claim.workItem.workItemId,
              leaseEpoch: input.claim.lease.epoch,
              nodeId: payload.nodeId,
              nodeKind: node.kind,
              claimId: payload.claimId,
              claimEpoch: payload.claimEpoch,
              agentVersionId: payload.agentVersionId,
              attempt: { stepId: payload.stepId, attemptId: payload.attemptId },
            },
          })
        : await this.#store.settleWorkflowNode({
            tenantId: input.run.tenantId,
            runId: input.run.runId,
            lease: leaseInput(input.claim),
            binding: payload.binding,
            nodeId: payload.nodeId,
            claimId: payload.claimId,
            claimEpoch: payload.claimEpoch,
            stepId: payload.stepId,
            attemptId: payload.attemptId,
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
  }
}

function deterministicNodeFailureCode(error: unknown): string {
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,127}$/.test(error.message))
    return error.message;
  return "workflow_node_execution_failed";
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

function assertCancellationProof(result: WorkflowCancellationResult): void {
  const proofLists = [
    result.canceledNodeIds,
    result.canceledGateRequestNodeIds,
    result.reconciliationWorkItemIds,
  ];
  if (
    proofLists.some((ids) => !canonicalProofIds(ids)) ||
    result.canceledGateRequestNodeIds.some(
      (nodeId) => !result.canceledNodeIds.includes(nodeId),
    ) ||
    result.canceledNodeIds.some(
      (nodeId) =>
        result.execution.nodes.find((node) => node.nodeId === nodeId)
          ?.status !== "canceled",
    ) ||
    (result.handoff.kind === "reconcile"
      ? result.reconciliationWorkItemIds[0] !== result.handoff.nextWorkItemId
      : result.handoff.currentWorkItem === "completed" &&
        result.reconciliationWorkItemIds.length !== 0)
  )
    throw new Error("workflow_cancellation_proof_invalid");
}

function canonicalProofIds(ids: readonly string[]): boolean {
  return ids.every(
    (id, index) => id.length > 0 && (index === 0 || ids[index - 1]! < id),
  );
}

function leaseInput(claim: WorkItemClaim) {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
}
