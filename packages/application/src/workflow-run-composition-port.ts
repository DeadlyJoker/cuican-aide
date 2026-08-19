import type {
  FrozenWorkflowVersionBinding,
  ModelDispatchReceipt,
  ModelDispatchTerminalOutcome,
  RunAttemptState,
  RunStepState,
  ToolExecutionReceiptState,
  WorkflowNodeTerminalEvidence,
  WorkflowSchemaValue,
} from "@crewon/domain";

import type {
  WorkflowExecutionValue,
  OutboxLeaseInput,
  OutboxMessage,
  WorkflowRunInputRef,
  WorkItemLeaseInput,
} from "./durable-queue-port.ts";
import type {
  WorkflowExecutionState,
  WorkflowNodeClaim,
} from "./workflow-execution-types.ts";
import type { WorkflowNodeContinuationCheckpoint } from "./workflow-node-continuation-store-port.ts";

export const MAX_WORKFLOW_PENDING_TOOL_RESUMES = 16;

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

/** Exact durable evidence that permits a read-only provider response recovery. */
export type WorkflowNodeResponseRecovery = Readonly<{
  claim: WorkflowNodeClaim;
  step: RunStepState;
  attempt: RunAttemptState &
    Readonly<{
      checkpointDigest: string;
      providerCheckpoint: NonNullable<RunAttemptState["providerCheckpoint"]>;
    }>;
  inputValue: WorkflowExecutionValue;
  dispatch: ModelDispatchReceipt & Readonly<{ status: "responseObserved" }>;
}>;

/** Store-adopted Tool authority that is still missing its durable continuation. */
export type WorkflowPendingToolResume = Readonly<{
  receipt: ToolExecutionReceiptState &
    Readonly<{ status: "prepared" | "dispatched" | "unknownOutcome" }>;
  step: RunStepState & Readonly<{ kind: "tool"; status: "running" }>;
  attempt: RunAttemptState & Readonly<{ status: "running" }>;
}>;

/**
 * Store-adopted authority for continuing a non-terminal Workflow Agent sample.
 *
 * The Store returns this only after atomically fencing the reconciliation Work
 * Item lease, adopting the same Attempt to that lease, terminating the consumed
 * model dispatch, and deep-validating the bounded continuation checkpoint.
 */
export type WorkflowNodeContinuationResume = Readonly<{
  claim: WorkflowNodeClaim;
  step: RunStepState;
  attempt: RunAttemptState & Readonly<{ status: "running" }>;
  reconciliationLease: WorkItemLeaseInput;
  continuation: WorkflowNodeContinuationCheckpoint;
  pendingTools: readonly WorkflowPendingToolResume[];
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

/** Public, durable authority exposed only after the gate Outbox is acknowledged. */
export type WorkflowHumanGatePublication = Readonly<{
  runId: string;
  nodeId: string;
  claimId: string;
  claimEpoch: number;
  gateRequestId: string;
  approvalPolicyId: string;
  status: "published";
  createdAt: string;
}>;

export type PublishWorkflowHumanGateInput = Readonly<{
  lease: OutboxLeaseInput;
  message: OutboxMessage;
}>;

export type WorkflowAtomicHandoff = Readonly<{
  currentWorkItem: "completed" | "retained";
  nextWorkItemId: string | null;
  kind: "none" | "scheduler" | "reconcile" | "node";
}>;

export type WorkflowRetainedHandoff = Readonly<{
  currentWorkItem: "retained";
  nextWorkItemId: null;
  kind: "none";
}>;

export type WorkflowRunDisposition = "nonTerminal" | "terminalConverged";

export type WorkflowDispatchEvidenceStatus =
  | "notDispatched"
  | "possiblySent"
  | "responseObserved"
  | "terminal";

/** Durable evidence committed by one Workflow cancellation transaction. */
export type WorkflowCancellationProof = Readonly<{
  /**
   * Exact node IDs transitioned to `canceled` by this transaction. IDs are
   * non-empty, unique, and ordered by ascending ECMAScript string comparison.
   */
  canceledNodeIds: readonly string[];
  /**
   * Exact canceled gate-request node IDs. This is an ordered subset of
   * `canceledNodeIds` with the same non-empty, unique ordering invariant.
   */
  canceledGateRequestNodeIds: readonly string[];
  /**
   * Exact reconciliation Work Item IDs created or durably verified by this
   * transaction. IDs are non-empty, unique, and use the same canonical order.
   * A reconciliation handoff points to the first ID.
   */
  reconciliationWorkItemIds: readonly string[];
}>;

export type WorkflowCancellationResult =
  | (Readonly<{
      disposition: "retryRequired";
      execution: WorkflowExecutionState;
      handoff: WorkflowRetainedHandoff;
      runDisposition: "nonTerminal";
    }> &
      WorkflowCancellationProof)
  | (Readonly<{
      disposition:
        | "canceled"
        | "cancellationPending"
        | "replay"
        | "reconciliationScheduled";
      execution: WorkflowExecutionState;
      handoff: WorkflowAtomicHandoff;
      runDisposition: WorkflowRunDisposition;
    }> &
      WorkflowCancellationProof);

export type WorkflowReconciliationResult =
  | Readonly<{
      disposition: "retryRequired";
      evidenceStatus: WorkflowDispatchEvidenceStatus;
      execution: WorkflowExecutionState;
      handoff: WorkflowRetainedHandoff;
      runDisposition: "nonTerminal";
    }>
  | Readonly<{
      /** Grants only provider GET/retrieve; it never authorizes a new dispatch. */
      disposition: "retrieveRequired";
      evidenceStatus: "responseObserved";
      recovery: WorkflowNodeResponseRecovery;
      execution: WorkflowExecutionState;
      handoff: WorkflowRetainedHandoff;
      runDisposition: "nonTerminal";
    }>
  | Readonly<{
      /** Grants exactly one continuation resume and never a fresh execution or GET. */
      disposition: "resumeRequired";
      evidenceStatus: "responseObserved";
      resume: WorkflowNodeContinuationResume;
      execution: WorkflowExecutionState;
      handoff: WorkflowRetainedHandoff;
      runDisposition: "nonTerminal";
    }>
  | Readonly<{
      disposition:
        | "retryScheduled"
        | "evidenceInsufficient"
        | "settled"
        | "replay";
      evidenceStatus: WorkflowDispatchEvidenceStatus;
      execution: WorkflowExecutionState;
      handoff: WorkflowAtomicHandoff;
      runDisposition: WorkflowRunDisposition;
    }>;

export type WorkflowRetrievedNodeSettlementResult = Readonly<{
  disposition: "settled" | "replay";
  evidenceStatus: "responseObserved";
  evidence: WorkflowNodeTerminalEvidence;
  dispatchTerminalOutcome: ModelDispatchTerminalOutcome;
  execution: WorkflowExecutionState;
  handoff: WorkflowAtomicHandoff;
  runDisposition: WorkflowRunDisposition;
}>;

/** Atomically publishes durable Human Gate authority through its exact Outbox lease. */
export interface WorkflowHumanGatePublicationStore {
  /** Atomically exposes one gate publication and acknowledges its exact Outbox lease. */
  publishWorkflowHumanGate(
    input: PublishWorkflowHumanGateInput,
  ): Promise<WorkflowHumanGatePublication>;

  /** Lists only publications whose durable Outbox delivery has completed. */
  listPublishedWorkflowHumanGates(input: {
    tenantId: string;
    runId: string;
  }): Promise<readonly WorkflowHumanGatePublication[]>;
}

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
  }): Promise<WorkflowReconciliationResult>;

  settleRetrievedWorkflowNode(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    nodeId: string;
    claimId: string;
    claimEpoch: number;
    reconciliationOperationId: string;
    agentVersionId: string;
    attempt: Readonly<{
      stepId: string;
      attemptId: string;
      workItemId: string;
      leaseEpoch: number;
    }>;
    dispatch: Readonly<{
      operationId: string;
      requestSequence: number;
      expectedRevision: number;
      status: "responseObserved";
    }>;
    evidence: WorkflowNodeTerminalEvidence;
    dispatchTerminalOutcome: ModelDispatchTerminalOutcome;
  }): Promise<WorkflowRetrievedNodeSettlementResult>;

  cancelWorkflowExecution(input: {
    tenantId: string;
    runId: string;
    lease: WorkItemLeaseInput;
    binding: FrozenWorkflowVersionBinding;
    operationId: string;
    reasonCode: string;
  }): Promise<WorkflowCancellationResult>;
}
