import type { JsonValue } from "@crewon/contracts";
import type {
  AutomationInvocationBinding,
  FrozenWorkflowVersionBinding,
} from "@crewon/domain";

/** Maximum UTF-8 bytes of the canonical JSON representation of any Workflow value. */
export { MAX_WORKFLOW_VALUE_BYTES } from "@crewon/domain";

export type WorkflowExecutionValue = Readonly<{
  schemaVersion: "crewon.workflow-execution-value.v0";
  valueId: string;
  value: JsonValue;
  valueDigest: string;
}>;

/** Root Workflow input authority persisted exactly once with start admission. */
export type WorkflowRunInputAuthority = WorkflowExecutionValue;

export type WorkflowRunInputRef = Readonly<{
  valueId: string;
  valueDigest: string;
}>;

export type WorkflowSchedulerWorkItemPayload = Readonly<{
  schemaVersion: "crewon.workflow-scheduler-work-item.v1";
  trigger: "workflowScheduler";
  binding: FrozenWorkflowVersionBinding;
  schedulerOperationId: string;
  workflowInput: WorkflowRunInputRef;
}>;

export type AutomationInvocationWorkItemPayload = Readonly<{
  schemaVersion: "crewon.automation-invocation-work-item.v0";
  trigger: "automationInvocation";
  throughSequence: 1;
  binding: AutomationInvocationBinding;
}>;

export type OutboxMessage = Readonly<{
  messageId: string;
  tenantId: string;
  runId: string;
  topic: string;
  payload: Readonly<Record<string, JsonValue>>;
  createdAt: string;
}>;

export type WorkItem = Readonly<{
  workItemId: string;
  tenantId: string;
  runId: string;
  kind: "run.execute";
  payload: Readonly<Record<string, JsonValue>>;
  createdAt: string;
}>;

export type QueueLease = Readonly<{
  ownerId: string;
  leaseId: string;
  epoch: number;
  expiresAt: string;
}>;

export type OutboxClaim = Readonly<{
  message: OutboxMessage;
  lease: QueueLease;
}>;

export type WorkItemClaim = Readonly<{
  workItem: WorkItem;
  lease: QueueLease;
}>;

export type QueueClaimInput = Readonly<{
  ownerId: string;
  leaseId: string;
  leaseDurationMs: number;
}>;

export type OutboxLeaseInput = Readonly<{
  messageId: string;
  ownerId: string;
  leaseId: string;
  leaseEpoch: number;
}>;

export type WorkItemLeaseInput = Readonly<{
  workItemId: string;
  ownerId: string;
  leaseId: string;
  leaseEpoch: number;
}>;

export type WorkItemRenewInput = WorkItemLeaseInput &
  Readonly<{
    leaseDurationMs: number;
  }>;

export type OutboxRetryInput = OutboxLeaseInput &
  Readonly<{
    retryAfterMs: number;
    reasonCode: string;
  }>;

export type WorkItemRetryInput = WorkItemLeaseInput &
  Readonly<{
    retryAfterMs: number;
    reasonCode: string;
  }>;

/**
 * Durable delivery and execution queues owned by the application layer.
 *
 * Implementations must claim atomically, fence settlement by lease epoch, and
 * make expired leases claimable again without relying on process-local state.
 * A Work Item lease is scheduling ownership, not permission to execute: a
 * Worker must reload the canonical Run and validate cancel/policy state before
 * performing any model, Tool, or Device side effect.
 */
export interface DurableQueueStore {
  listPendingOutbox(limit: number): Promise<readonly OutboxMessage[]>;
  claimNextOutbox(input: QueueClaimInput): Promise<OutboxClaim | null>;
  acknowledgeOutbox(input: OutboxLeaseInput): Promise<void>;
  retryOutbox(input: OutboxRetryInput): Promise<void>;
  listPendingWorkItems(limit: number): Promise<readonly WorkItem[]>;
  claimNextWorkItem(input: QueueClaimInput): Promise<WorkItemClaim | null>;
  renewWorkItemLease(input: WorkItemRenewInput): Promise<QueueLease>;
  completeWorkItem(input: WorkItemLeaseInput): Promise<void>;
  retryWorkItem(input: WorkItemRetryInput): Promise<void>;
}
