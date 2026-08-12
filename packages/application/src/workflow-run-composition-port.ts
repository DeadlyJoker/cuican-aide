import type {
  FrozenWorkflowVersionBinding,
  RunAttemptState,
  RunStepState,
} from "@crewon/domain";

import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { WorkflowExecutionState } from "./workflow-execution-store-port.ts";
import type { WorkflowNodeClaim } from "./workflow-execution-service.ts";

export type WorkflowAtomicNodeOutcome =
  | Readonly<{ status: "completed"; resultDigest: string }>
  | Readonly<{ status: "failed"; failureCode: string }>
  | Readonly<{ status: "canceled" }>
  | Readonly<{ status: "unknown" }>;

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
    Readonly<{
      disposition: "fresh" | "replay" | "reconcileRequired";
      execution: WorkflowExecutionState;
      /** Non-empty execution authority is legal only for `fresh`. */
      admissions: readonly WorkflowNodeAttemptAdmission[];
      /** Stable identities are legal only for `reconcileRequired`. */
      reconciliationClaims: readonly WorkflowNodeClaim[];
    }>
  >;

  /** Atomically settles DAG claim plus exact RunAttempt/RunStep authority. */
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

  /** Atomically publishes durable gate authority and releases current WorkItem. */
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

  /** Settles approved/rejected gate state under its durable resume WorkItem. */
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

  /** Durably creates reconciliation work before completing unsafe old work. */
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
