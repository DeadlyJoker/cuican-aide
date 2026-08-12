import type {
  WorkItemClaim,
  WorkflowRunCompositionStore,
  WorkflowVersionStore,
} from "@crewon/application";
import type { RunState, WorkflowContentDigester } from "@crewon/domain";

import {
  WorkflowDagExecutor,
  WorkflowNodeRecoveryRequiredError,
  type WorkflowHumanGatePort,
  type WorkflowAgentNodePort,
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

/** Production Workflow routing, enabled only with durable version and atomic composition Stores. */
export class ProductionWorkflowRuntimeDispatcher
  implements WorkflowRuntimeDispatcherPort
{
  readonly #versions: WorkflowVersionStore;
  readonly #digester: WorkflowContentDigester;
  readonly #composition: ExperimentalWorkflowRunCompositionAdapter;
  readonly #executor: Pick<WorkflowDagExecutor, "executeAdmissions">;
  readonly #leaseDurationMs: number;

  constructor(dependencies: {
    versions: WorkflowVersionStore;
    composition: WorkflowRunCompositionStore;
    digester: WorkflowContentDigester;
    executor: Pick<WorkflowDagExecutor, "executeAdmissions">;
    leaseDurationMs: number;
  }) {
    this.#versions = dependencies.versions;
    this.#digester = dependencies.digester;
    this.#composition = new ExperimentalWorkflowRunCompositionAdapter(
      dependencies.composition,
    );
    this.#executor = dependencies.executor;
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
    const schedulerOperationId = `workflow:${input.claim.workItem.workItemId}:${input.claim.lease.epoch}`;
    const admitted = await this.#composition.admit({
      tenantId: input.run.tenantId,
      runId: input.run.runId,
      lease: leaseInput(input.claim),
      binding,
      schedulerOperationId,
      leaseDurationMs: this.#leaseDurationMs,
    });
    const admissions = admitted.admissions.map((admission) => {
      const nodeState = admitted.execution.nodes.find(
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
      return {
        ...admission,
        agentVersionId: nodeState.agentVersionId,
      };
    });
    let state;
    try {
      state = await this.#executor.executeAdmissions({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        binding,
        workflow,
        admissions,
      });
    } catch (error) {
      if (error instanceof WorkflowNodeRecoveryRequiredError) {
        return {
          kind: "recovery",
          runId: input.run.runId,
          code: "workflow_settlement_recovery_required",
        };
      }
      throw error;
    }
    if (state.status === "completed") {
      return { kind: "completed", runId: input.run.runId };
    }
    if (state.status === "waitingHuman") {
      const gate = state.nodes.find((node) => node.status === "waitingHuman");
      if (gate?.gateRequestId === null || gate?.gateRequestId === undefined) {
        throw new Error("workflow_human_gate_receipt_missing");
      }
      return {
        kind: "waitingApproval",
        runId: input.run.runId,
        approvalId: gate.gateRequestId,
      };
    }
    return {
      kind: "recovery",
      runId: input.run.runId,
      code:
        state.status === "failed"
          ? "workflow_failed"
          : "workflow_recovery_required",
    };
  }
}

export type { WorkflowAgentNodePort, WorkflowHumanGatePort };

function leaseInput(claim: WorkItemClaim) {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
}
