import type { WorkflowNodeDefinition } from "@crewon/domain";

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

export type WorkflowNodeClaim = Readonly<{
  node: WorkflowNodeDefinition;
  claimId: string;
  claimEpoch: number;
  gateRequestId: string | null;
  inputDigest: string;
}>;
