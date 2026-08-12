export type WorkflowExecutionNodeKind = "agent" | "humanGate" | "verification";

export type WorkflowExecutionNodeState = Readonly<{
  nodeId: string;
  kind: WorkflowExecutionNodeKind;
  agentVersionId: string | null;
  status:
    | "pending"
    | "queued"
    | "running"
    | "waitingHuman"
    | "completed"
    | "failed"
    | "canceled"
    | "unknown";
  claimId: string | null;
  claimOperationId: string | null;
  claimEpoch: number;
  leaseExpiresAt: string | null;
  gateRequestId: string | null;
  inputDigest: string | null;
  resultDigest: string | null;
  failureCode: string | null;
}>;

export type WorkflowExecutionState = Readonly<{
  schemaVersion: "crewon.workflow-execution.v0";
  tenantId: string;
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  contentDigest: string;
  revision: number;
  status: "running" | "waitingHuman" | "completed" | "failed" | "canceled";
  cancelRequested: boolean;
  nodes: readonly WorkflowExecutionNodeState[];
  updatedAt: string;
}>;

export type WorkflowExecutionReceipt = Readonly<{
  operationId: string;
  fingerprint: string;
  state: WorkflowExecutionState;
}>;

/** Durable authority for Workflow DAG state and idempotent CAS transitions. */
export interface WorkflowExecutionStore {
  createWorkflowExecution(state: WorkflowExecutionState): Promise<{
    disposition: "created" | "existing";
    state: WorkflowExecutionState;
  }>;
  loadWorkflowExecution(input: {
    tenantId: string;
    runId: string;
  }): Promise<WorkflowExecutionState | null>;
  loadWorkflowExecutionReceipt(input: {
    tenantId: string;
    runId: string;
    operationId: string;
  }): Promise<WorkflowExecutionReceipt | null>;
  compareAndSwapWorkflowExecution(input: {
    tenantId: string;
    runId: string;
    expectedRevision: number;
    next: WorkflowExecutionState;
    receipt: Readonly<{ operationId: string; fingerprint: string }>;
  }): Promise<
    | Readonly<{
        disposition: "committed" | "replayed";
        state: WorkflowExecutionState;
      }>
    | Readonly<{ disposition: "conflict"; state: WorkflowExecutionState }>
  >;
}
