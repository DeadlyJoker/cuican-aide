import type {
  FrozenWorkflowVersionBinding,
  RunAttemptState,
  RunStepState,
} from "@crewon/domain";

import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { WorkflowExecutionState } from "./workflow-execution-store-port.ts";
import type { WorkflowNodeClaim } from "./workflow-execution-service.ts";

export type WorkflowNodeAttemptAdmission = Readonly<{
  claim: WorkflowNodeClaim;
  step: RunStepState;
  attempt: RunAttemptState | null;
}>;

export type WorkflowAtomicNodeOutcome =
  | Readonly<{ status: "completed"; resultDigest: string }>
  | Readonly<{ status: "failed"; failureCode: string }>
  | Readonly<{ status: "canceled" }>
  | Readonly<{ status: "unknown" }>;

/**
 * Atomic composition boundary required before Workflow execution is routable.
 *
 * Implementations must validate the WorkItem lease and the Run's frozen
 * WorkflowVersion binding in the same transaction that claims DAG nodes and
 * creates their RunStep/RunAttempt authority. No current Store implements this
 * port yet, so Runtime Worker production routing must remain disabled.
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
    | Readonly<{
        disposition: "fresh";
        execution: WorkflowExecutionState;
        admissions: readonly WorkflowNodeAttemptAdmission[];
        reconciliationClaims: readonly [];
      }>
    | Readonly<{
        disposition: "replay";
        execution: WorkflowExecutionState;
        admissions: readonly [];
        reconciliationClaims: readonly [];
      }>
    | Readonly<{
        disposition: "reconcileRequired";
        execution: WorkflowExecutionState;
        admissions: readonly [];
        reconciliationClaims: readonly WorkflowNodeClaim[];
      }>
  >;

  settleWorkflowNode(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    nodeId: string;
    claimId: string;
    claimEpoch: number;
    stepId: string;
    attemptId: string | null;
    operationId: string;
    continuationWorkItemId: string;
    outcome: WorkflowAtomicNodeOutcome;
  }): Promise<
    Readonly<{
      disposition: "settled" | "replay" | "reconcileRequired";
      execution: WorkflowExecutionState;
    }>
  >;

  publishWorkflowHumanGate(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    nodeId: string;
    claimId: string;
    claimEpoch: number;
    stepId: string;
    approvalPolicyId: string;
    gateRequestId: string;
    inputDigest: string;
    publicationOutboxMessageId: string;
    approvalResumeWorkItemId: string;
    operationId: string;
  }): Promise<Readonly<{ disposition: "published" | "replay" }>>;

  settleWorkflowHumanGate(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    nodeId: string;
    claimId: string;
    claimEpoch: number;
    stepId: string;
    gateRequestId: string;
    operationId: string;
    continuationWorkItemId: string;
    outcome:
      | Readonly<{ status: "completed"; resultDigest: string }>
      | Readonly<{ status: "failed"; failureCode: string }>;
  }): Promise<
    Readonly<{
      disposition: "settled" | "replay" | "reconcileRequired";
      execution: WorkflowExecutionState;
    }>
  >;

  scheduleWorkflowReconciliation(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    operationId: string;
    reasonCode: string;
    reconciliationWorkItemId: string;
  }): Promise<Readonly<{ disposition: "scheduled" | "replay" }>>;
}
