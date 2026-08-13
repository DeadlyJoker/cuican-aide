import type {
  FrozenWorkflowVersionBinding,
  RunLifecycleEvent,
  ToolApprovalState,
  ToolExecutionReceiptState,
} from "@crewon/domain";

import type {
  OutboxMessage,
  WorkItemLeaseInput,
} from "./durable-queue-port.ts";
import type { WorkflowAgentAttemptAuthority } from "./workflow-node-continuation-store-port.ts";

export type WorkflowToolApprovalOutcome =
  | Readonly<{
      kind: "approved";
      approval: ToolApprovalState;
      receipt: ToolExecutionReceiptState;
      authority: WorkflowAgentAttemptAuthority;
    }>
  | Readonly<{
      kind: "failed";
      failureCode: "tool_approval_rejected" | "tool_approval_expired";
      approval: ToolApprovalState;
      receipt: ToolExecutionReceiptState;
      authority: WorkflowAgentAttemptAuthority;
    }>
  | Readonly<{
      kind: "canceled";
      approval: ToolApprovalState;
      receipt: ToolExecutionReceiptState;
      authority: WorkflowAgentAttemptAuthority;
    }>;

export type PublishWorkflowToolApprovalInput = Readonly<{
  lease: WorkItemLeaseInput;
  binding: FrozenWorkflowVersionBinding;
  authority: WorkflowAgentAttemptAuthority;
  operationId: string;
  expectedContinuationRevision: number;
  receipt: ToolExecutionReceiptState;
  approval: ToolApprovalState;
  requiredEvent: RunLifecycleEvent;
  publicationOutbox: OutboxMessage;
  approvalRecheckMs: number;
}>;

export type ConsumeWorkflowToolApprovalInput = Readonly<{
  lease: WorkItemLeaseInput;
  binding: FrozenWorkflowVersionBinding;
  authority: WorkflowAgentAttemptAuthority;
  operationId: string;
  approvalId: string;
  actionDigest: string;
}>;

export type WorkflowToolApprovalPublicationResult = Readonly<{
  disposition: "published" | "replay";
  approval: ToolApprovalState;
  resumeWorkItemId: string;
}>;

export type WorkflowToolApprovalConsumptionResult = Readonly<{
  /** Exact replay returns the same dispatched receipt for crash recovery. */
  disposition: "consumed" | "replay";
  outcome: WorkflowToolApprovalOutcome | null;
}>;

/**
 * Workflow-private bridge to the ordinary ToolApproval authority.
 *
 * Publication atomically fences the admitted node Attempt and current lease,
 * stores the ordinary approval, publishes the Run waiting event, completes the
 * current Work Item, and creates a distinct approval-resume Work Item. Outcome
 * consumption fences that exact resume item and is the only operation that can
 * grant the approved receipt to a Worker. Receipt replays are observation-only.
 */
export interface WorkflowToolApprovalStore {
  publishWorkflowToolApproval(
    input: PublishWorkflowToolApprovalInput,
  ): Promise<WorkflowToolApprovalPublicationResult>;
  consumeWorkflowToolApproval(
    input: ConsumeWorkflowToolApprovalInput,
  ): Promise<WorkflowToolApprovalConsumptionResult>;
}
