import type { ProviderCheckpoint } from "@crewon/contracts";
import type { ToolExecutionReceiptState } from "@crewon/domain";
import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { RunAttemptIdentity } from "./run-execution-store-port.ts";
import type { ToolCompletedAgentEvent } from "./run-execution-service.ts";

export const MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS = 256;
export const MAX_WORKFLOW_CONTINUATION_HISTORY_BYTES = 512 * 1024;

export type WorkflowContinuationHistoryItem =
  | Readonly<{
      type: "message";
      role: "user" | "assistant" | "developer" | "system";
      content: string;
    }>
  | Readonly<{
      type: "tool_call";
      kind: "function" | "custom";
      callId: string;
      name: string;
      input: string;
    }>
  | Readonly<{
      type: "tool_result";
      kind: "function" | "custom";
      callId: string;
      output: string;
    }>;

/** Exact authority of the Workflow node that owns a continuing Agent Attempt. */
export type WorkflowAgentAttemptAuthority = Readonly<{
  tenantId: string;
  runId: string;
  workItemId: string;
  leaseEpoch: number;
  nodeId: string;
  nodeKind: "agent" | "verification";
  claimId: string;
  claimEpoch: number;
  agentVersionId: string;
  attempt: RunAttemptIdentity;
}>;

/** Bounded crash-recovery state after an assistant or Tool boundary. */
export type WorkflowNodeContinuationCheckpoint = Readonly<{
  schemaVersion: "crewon.workflow-node-continuation.v0";
  authority: WorkflowAgentAttemptAuthority;
  segmentId: string;
  modelSampleIndex: number;
  toolRoundsConsumed: number;
  providerCheckpoint: ProviderCheckpoint | null;
  providerTurnState: string | null;
  history: readonly WorkflowContinuationHistoryItem[];
  revision: number;
  updatedAt: string;
}>;

export type CommitWorkflowToolContinuationInput = Readonly<{
  lease: WorkItemLeaseInput;
  authority: WorkflowAgentAttemptAuthority;
  receipt: ToolExecutionReceiptState;
  toolAttempt: RunAttemptIdentity;
  completedEvent: ToolCompletedAgentEvent;
  providerReceiptId: string;
  expectedContinuationRevision: number | null;
  next: Omit<WorkflowNodeContinuationCheckpoint, "revision" | "updatedAt">;
  committedAt: string;
}>;

export type CommitWorkflowAssistantContinuationInput = Readonly<{
  lease: WorkItemLeaseInput;
  authority: WorkflowAgentAttemptAuthority;
  expectedContinuationRevision: number | null;
  next: Omit<WorkflowNodeContinuationCheckpoint, "revision" | "updatedAt">;
  committedAt: string;
}>;

/**
 * Workflow-private continuation authority.
 *
 * Tool completion and the next continuation checkpoint must commit in one
 * transaction. Implementations fence the exact current node claim, Agent
 * Attempt, Work Item lease epoch, AgentVersion, segment and revision.
 */
export interface WorkflowNodeContinuationStore {
  loadWorkflowNodeContinuation(
    authority: WorkflowAgentAttemptAuthority,
  ): Promise<WorkflowNodeContinuationCheckpoint | null>;
  commitWorkflowToolContinuation(
    input: CommitWorkflowToolContinuationInput,
  ): Promise<Readonly<{
    receipt: ToolExecutionReceiptState;
    continuation: WorkflowNodeContinuationCheckpoint;
  }>>;
  commitWorkflowAssistantContinuation(
    input: CommitWorkflowAssistantContinuationInput,
  ): Promise<WorkflowNodeContinuationCheckpoint>;
}
