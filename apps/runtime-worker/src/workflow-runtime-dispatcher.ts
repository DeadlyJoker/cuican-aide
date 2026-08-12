import type {
  WorkItemClaim,
  WorkflowRunCompositionStore,
  WorkflowVersionStore,
} from "@crewon/application";
import type { RunState, WorkflowContentDigester } from "@crewon/domain";

import type {
  WorkflowAgentNodePort,
  WorkflowNodeOutcome,
} from "./workflow-dag-executor.ts";
import { ExperimentalWorkflowRunCompositionAdapter } from "./workflow-run-composition-adapter.ts";
import { loadFrozenWorkflowVersion } from "./workflow-version-runtime.ts";

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

/** Internal production candidate; no public composition enables it without a Store implementation. */
export class ProductionWorkflowRuntimeDispatcher
  implements WorkflowRuntimeDispatcherPort
{
  readonly #versions: WorkflowVersionStore;
  readonly #digester: WorkflowContentDigester;
  readonly #composition: ExperimentalWorkflowRunCompositionAdapter;
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
    this.#digester = dependencies.digester;
    this.#composition = new ExperimentalWorkflowRunCompositionAdapter(
      dependencies.composition,
    );
    this.#agent = dependencies.agent;
    this.#leaseDurationMs = dependencies.leaseDurationMs;
  }

  async dispatch(input: {
    claim: WorkItemClaim;
    run: RunState;
  }): Promise<WorkflowRuntimeDispatchOutcome> {
    const binding = input.run.workflowVersionBinding;
    if (input.run.purpose !== "workflow" || binding === undefined) {
      throw new Error("workflow_runtime_dispatch_invalid");
    }
    const workflow = await loadFrozenWorkflowVersion({
      tenantId: input.run.tenantId,
      binding,
      store: this.#versions,
      digester: this.#digester,
    });
    const lease = leaseInput(input.claim);
    const schedulerOperationId = `workflow:${input.claim.workItem.workItemId}:${input.claim.lease.epoch}`;
    const admitted = await this.#composition.admit({
      tenantId: input.run.tenantId,
      runId: input.run.runId,
      lease,
      binding,
      schedulerOperationId,
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (admitted.disposition !== "fresh") {
      if (admitted.admissions.length !== 0) {
        throw new Error("workflow_replayed_admissions_must_be_empty");
      }
      await this.#composition.scheduleReconciliation({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        lease,
        binding,
        operationId: `${schedulerOperationId}:reconcile`,
        reasonCode:
          admitted.disposition === "replay"
            ? "workflow_admission_replayed"
            : "workflow_admission_reconcile_required",
        reconciliationWorkItemId: durableId(
          input.run.runId,
          `${schedulerOperationId}:reconcile`,
        ),
      });
      return {
        kind: "recovery",
        runId: input.run.runId,
        code: "workflow_reconciliation_scheduled",
      };
    }
    if (admitted.admissions.length > 1) {
      throw new Error("workflow_multiple_admissions_per_lease_forbidden");
    }

    let execution = admitted.execution;
    for (const admission of admitted.admissions) {
      const nodeState = execution.nodes.find(
        (node) => node.nodeId === admission.claim.node.nodeId,
      );
      const immutableAgentVersionId =
        admission.claim.node.kind === "agent"
          ? admission.claim.node.agentVersionId
          : admission.claim.node.kind === "verification"
            ? admission.claim.node.verifierAgentVersionId
            : null;
      if (
        nodeState === undefined ||
        nodeState.kind !== admission.claim.node.kind ||
        nodeState.agentVersionId !== immutableAgentVersionId
      ) {
        throw new Error("workflow_node_execution_identity_mismatch");
      }
      if (admission.claim.node.kind === "humanGate") {
        const gateRequestId = admission.claim.gateRequestId;
        if (gateRequestId === null) {
          throw new Error("workflow_human_gate_receipt_missing");
        }
        await this.#composition.publishHumanGate({
          tenantId: input.run.tenantId,
          runId: input.run.runId,
          lease,
          binding,
          nodeId: admission.claim.node.nodeId,
          claimId: admission.claim.claimId,
          claimEpoch: admission.claim.claimEpoch,
          stepId: admission.step.stepId,
          approvalPolicyId: admission.claim.node.approvalPolicyId,
          gateRequestId,
          inputDigest: admission.claim.inputDigest,
          publicationOutboxMessageId: durableId(
            input.run.runId,
            `gate-outbox:${gateRequestId}`,
          ),
          approvalResumeWorkItemId: durableId(
            input.run.runId,
            `gate-resume:${gateRequestId}`,
          ),
          operationId: `${schedulerOperationId}:gate-release:${admission.claim.claimId}`,
        });
        return {
          kind: "waitingApproval",
          runId: input.run.runId,
          approvalId: gateRequestId,
        };
      }
      const attempt = admission.attempt;
      if (attempt === null) {
        throw new Error("workflow_node_attempt_admission_missing");
      }
      let outcome: WorkflowNodeOutcome;
      try {
        outcome = await this.#agent.execute({
          tenantId: input.run.tenantId,
          runId: input.run.runId,
          nodeId: admission.claim.node.nodeId,
          agentVersionId: nodeState.agentVersionId!,
          inputDigest: admission.claim.inputDigest,
          claimId: admission.claim.claimId,
          claimEpoch: admission.claim.claimEpoch,
          stepId: admission.step.stepId,
          attemptId: attempt.attemptId,
        });
      } catch {
        outcome = { status: "unknown" };
      }
      try {
        const settled = await this.#composition.settleNode({
          tenantId: input.run.tenantId,
          runId: input.run.runId,
          lease,
          binding,
          nodeId: admission.claim.node.nodeId,
          claimId: admission.claim.claimId,
          claimEpoch: admission.claim.claimEpoch,
          stepId: admission.step.stepId,
          attemptId: attempt.attemptId,
          operationId: `node:${admission.claim.claimId}:settle`,
          continuationWorkItemId: durableId(
            input.run.runId,
            `continue:${admission.claim.claimId}`,
          ),
          outcome,
        });
        execution = settled.execution;
      } catch {
        await this.#scheduleRecovery(
          input,
          `${schedulerOperationId}:settlement:${admission.claim.claimId}`,
          "workflow_settlement_recovery_required",
        );
        return {
          kind: "recovery",
          runId: input.run.runId,
          code: "workflow_settlement_recovery_required",
        };
      }
    }
    return execution.status === "completed"
      ? { kind: "completed", runId: input.run.runId }
      : {
          kind: "recovery",
          runId: input.run.runId,
          code: "workflow_scheduler_continuation_committed",
        };
  }

  async settleHumanGate(input: {
    claim: WorkItemClaim;
    run: RunState;
    nodeId: string;
    nodeClaimId: string;
    nodeClaimEpoch: number;
    stepId: string;
    gateRequestId: string;
    operationId: string;
    outcome:
      | Readonly<{ status: "completed"; resultDigest: string }>
      | Readonly<{ status: "failed"; failureCode: string }>;
  }): Promise<WorkflowRuntimeDispatchOutcome> {
    const binding = input.run.workflowVersionBinding;
    if (input.run.purpose !== "workflow" || binding === undefined) {
      throw new Error("workflow_runtime_dispatch_invalid");
    }
    await loadFrozenWorkflowVersion({
      tenantId: input.run.tenantId,
      binding,
      store: this.#versions,
      digester: this.#digester,
    });
    const settled = await this.#composition.settleHumanGate({
      tenantId: input.run.tenantId,
      runId: input.run.runId,
      lease: leaseInput(input.claim),
      binding,
      nodeId: input.nodeId,
      claimId: input.nodeClaimId,
      claimEpoch: input.nodeClaimEpoch,
      stepId: input.stepId,
      gateRequestId: input.gateRequestId,
      operationId: input.operationId,
      continuationWorkItemId: durableId(
        input.run.runId,
        `gate-continue:${input.gateRequestId}`,
      ),
      outcome: input.outcome,
    });
    if (settled.disposition === "reconcileRequired") {
      return {
        kind: "recovery",
        runId: input.run.runId,
        code: "workflow_gate_settlement_reconcile_required",
      };
    }
    return settled.execution.status === "completed"
      ? { kind: "completed", runId: input.run.runId }
      : {
          kind: "recovery",
          runId: input.run.runId,
          code:
            settled.execution.status === "failed"
              ? "workflow_human_gate_rejected"
              : "workflow_scheduler_continuation_committed",
        };
  }

  async #scheduleRecovery(
    input: { claim: WorkItemClaim; run: RunState },
    operationId: string,
    reasonCode: string,
  ): Promise<void> {
    await this.#composition.scheduleReconciliation({
      tenantId: input.run.tenantId,
      runId: input.run.runId,
      lease: leaseInput(input.claim),
      binding: input.run.workflowVersionBinding!,
      operationId,
      reasonCode,
      reconciliationWorkItemId: durableId(input.run.runId, operationId),
    });
  }
}

function durableId(runId: string, operationId: string): string {
  return `workflow:${runId}:${operationId}`;
}

function leaseInput(claim: WorkItemClaim) {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
}
