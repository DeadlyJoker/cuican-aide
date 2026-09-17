import type {
  FrozenWorkflowVersionBinding,
  RunAttemptState,
  RunStepState,
  RunState,
} from "@crewon/domain";

import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { WorkflowExecutionState } from "./workflow-execution-store-port.ts";
import type { WorkflowNodeClaim } from "./workflow-execution-service.ts";

export type WorkflowNodeAttemptAdmission = Readonly<{
  claim: WorkflowNodeClaim;
  step: RunStepState;
  attempt: RunAttemptState | null;
}>;

/**
 * Atomic composition boundary required before Workflow execution is routable.
 *
 * Implementations must validate the WorkItem lease and the Run's frozen
 * WorkflowVersion binding in the same transaction that claims DAG nodes and
 * creates their RunStep/RunAttempt authority. The SQLite implementation is
 * experimental: child handoff, human decisions, cancellation propagation and quiescent root finalization
 * exist, with an explicitly injected experimental Worker scheduler. Full production
 * routing, recovery coverage and policy resolution are still required.
 * Runtime Worker production routing must remain disabled.
 */
export interface WorkflowRunCompositionStore {
  admitWorkflowNodes(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    schedulerOperationId: string;
    leaseDurationMs: number;
  }): Promise<
    Readonly<{
      execution: WorkflowExecutionState;
      admissions: readonly WorkflowNodeAttemptAdmission[];
    }>
  >;
}

/** Final output, terminal Run events and the scheduler acknowledgement share one transaction. */
export interface WorkflowRunFinalizationStore {
  finalizeWorkflowRun(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    lease: WorkItemLeaseInput;
    schedulerOperationId: string;
  }): Promise<
    Readonly<{ disposition: "committed" | "replayed"; run: RunState }>
  >;
}

/** Propagates an already-authorized canonical root cancellation under a scheduler lease. */
export interface WorkflowRunCancellationStore {
  propagateWorkflowCancellation(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    lease: WorkItemLeaseInput;
    schedulerOperationId: string;
  }): Promise<WorkflowExecutionState>;
}

/** Terminal node settlement and the next scheduler wake must commit atomically. */
export interface WorkflowNodeSettlementStore {
  settleWorkflowNode(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    nodeId: string;
    claimId: string;
    outcome:
      | Readonly<{
          status: "completed";
          value: import("@crewon/contracts").JsonValue;
        }>
      | Readonly<{ status: "failed"; failureCode: string }>
      | Readonly<{ status: "canceled" }>;
  }): Promise<WorkflowExecutionState>;
}
