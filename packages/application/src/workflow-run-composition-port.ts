import type {
  FrozenWorkflowVersionBinding,
  RunAttemptState,
  RunStepState,
  WorkflowSchemaValue,
} from "@crewon/domain";

import type {
  WorkflowExecutionValue,
  WorkflowRunInputRef,
  WorkItemLeaseInput,
} from "./durable-queue-port.ts";
import type {
  WorkflowExecutionState,
  WorkflowNodeClaim,
} from "./workflow-execution-types.ts";

export type WorkflowAtomicNodeOutcome =
  | Readonly<{ status: "completed"; value: WorkflowSchemaValue }>
  | Readonly<{ status: "failed"; failureCode: string }>
  | Readonly<{ status: "canceled" }>
  | Readonly<{ status: "unknown" }>;

export type WorkflowNodeAttemptAdmission = Readonly<{
  claim: WorkflowNodeClaim;
  step: RunStepState;
  attempt: RunAttemptState;
  inputValue: WorkflowExecutionValue;
}>;

export type WorkflowNodeWorkAuthority = Readonly<{
  nodeId: string;
  claimId: string;
  claimEpoch: number;
  workItemId: string;
}>;

export type WorkflowGatePublicationAuthority = Readonly<{
  nodeId: string;
  claimId: string;
  claimEpoch: number;
  gateRequestId: string;
  publicationOutboxMessageId: string;
  approvalResumeWorkItemId: string;
}>;

export type WorkflowAtomicHandoff = Readonly<{
  currentWorkItem: "completed" | "retained";
  nextWorkItemId: string | null;
  kind: "none" | "scheduler" | "reconcile" | "node";
}>;

export type WorkflowRunDisposition = "nonTerminal" | "terminalConverged";

export type WorkflowDispatchEvidenceStatus =
  | "notDispatched"
  | "possiblySent"
  | "responseObserved"
  | "terminal";

export interface WorkflowRunCompositionStore {
  scheduleWorkflowNodes(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    schedulerOperationId: string;
    workflowInput: WorkflowRunInputRef;
  }): Promise<
    | Readonly<{
      disposition: "scheduled";
      execution: WorkflowExecutionState;
      nodeWorkItems: readonly WorkflowNodeWorkAuthority[];
      gatePublications: readonly WorkflowGatePublicationAuthority[];
      reconciliationClaims: readonly [];
      handoff: WorkflowAtomicHandoff;
      runDisposition: WorkflowRunDisposition;
    }>
    | Readonly<{
      /** Receipt replay is observation-only and never grants side-effect permission. */
      disposition: "replay";
      execution: WorkflowExecutionState;
      nodeWorkItems: readonly [];
      gatePublications: readonly [];
      reconciliationClaims: readonly [];
      handoff: WorkflowAtomicHandoff;
      runDisposition: WorkflowRunDisposition;
    }>
    | Readonly<{
      disposition: "reconcileRequired";
      execution: WorkflowExecutionState;
      nodeWorkItems: readonly [];
      gatePublications: readonly [];
      reconciliationClaims: readonly WorkflowNodeClaim[];
      handoff: WorkflowAtomicHandoff;
      runDisposition: WorkflowRunDisposition;
    }>
  >;

  admitWorkflowNodeWork(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    nodeId: string;
    claimId: string;
    claimEpoch: number;
    schedulerOperationId: string;
    admissionOperationId: string;
    attemptLeaseDurationMs: number;
  }): Promise<
    | Readonly<{
        disposition: "fresh";
        execution: WorkflowExecutionState;
        admission: WorkflowNodeAttemptAdmission;
        handoff: WorkflowAtomicHandoff;
      }>
    | Readonly<{
        /** Replay proves the old commit only; it cannot authorize model or Tool execution. */
        disposition: "replay";
        execution: WorkflowExecutionState;
        admission: null;
        handoff: WorkflowAtomicHandoff;
      }>
    | Readonly<{
        disposition: "reconcileRequired";
        execution: WorkflowExecutionState;
        admission: null;
        reconciliationClaim: WorkflowNodeClaim;
        handoff: WorkflowAtomicHandoff;
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
    attemptId: string;
    operationId: string;
    outcome: WorkflowAtomicNodeOutcome;
  }): Promise<
    Readonly<{
      disposition: "settled" | "replay" | "reconciliationScheduled";
      execution: WorkflowExecutionState;
      schedulerContinuationWorkItemId: string | null;
      handoff: WorkflowAtomicHandoff;
      runDisposition: WorkflowRunDisposition;
    }>
  >;

  recordWorkflowHumanGateDecision(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    nodeId: string;
    claimId: string;
    claimEpoch: number;
    gateRequestId: string;
    decisionReceiptId: string;
    outcome:
      | Readonly<{ status: "completed" }>
      | Readonly<{ status: "failed"; failureCode: string }>;
  }): Promise<
    Readonly<{
      disposition: "recorded" | "replay";
      approvalResumeWorkItemId: string;
    }>
  >;

  settleWorkflowHumanGate(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    nodeId: string;
    claimId: string;
    claimEpoch: number;
    gateRequestId: string;
    decisionReceiptId: string;
    operationId: string;
  }): Promise<
    Readonly<{
      disposition: "settled" | "replay" | "reconciliationScheduled";
      execution: WorkflowExecutionState;
      schedulerContinuationWorkItemId: string | null;
      handoff: WorkflowAtomicHandoff;
      runDisposition: WorkflowRunDisposition;
    }>
  >;

  scheduleWorkflowReconciliation(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    operationId: string;
    reasonCode: string;
    nodeId: string | null;
    claimId: string | null;
    claimEpoch: number | null;
  }): Promise<
    Readonly<{
      disposition: "scheduled" | "replay";
      reconciliationWorkItemId: string;
      handoff: WorkflowAtomicHandoff;
    }>
  >;

  reconcileWorkflowNode(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    nodeId: string;
    claimId: string;
    claimEpoch: number;
    reconciliationOperationId: string;
  }): Promise<
    Readonly<{
      disposition: "retryScheduled" | "retryRequired" | "evidenceInsufficient" | "settled" | "replay";
      evidenceStatus: WorkflowDispatchEvidenceStatus;
      execution: WorkflowExecutionState;
      handoff: WorkflowAtomicHandoff;
      runDisposition: WorkflowRunDisposition;
    }>
  >;

  cancelWorkflowExecution(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    operationId: string;
    reasonCode: string;
  }): Promise<
    Readonly<{
      disposition: "canceled" | "cancellationPending" | "retryRequired" |
        "replay" | "reconciliationScheduled";
      execution: WorkflowExecutionState;
      handoff: WorkflowAtomicHandoff;
      runDisposition: WorkflowRunDisposition;
    }>
  >;
}
