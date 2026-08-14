import {
  RunStoreError,
  type OutboxMessage,
  type QueueClaimInput,
  type QueueLease,
  type WorkItem,
} from "@crewon/application";

import {
  stableJson,
  validateOutbox,
  validateWorkItems,
} from "./store-invariants.ts";

export type PostgresQueueItemRow = Readonly<{
  tenant_id: string;
  run_id: string;
  topic?: string;
  kind?: string;
  item_json: unknown;
  created_at: Date | string;
  lease_epoch?: string | number;
  lease_expires_at?: Date | string;
}>;

export function decodePostgresOutbox(row: PostgresQueueItemRow): OutboxMessage {
  const value = exactRecord(
    row.item_json,
    ["createdAt", "messageId", "payload", "runId", "tenantId", "topic"],
    "stored_outbox_message_invalid",
  ) as OutboxMessage;
  stableJson(value);
  validateOutbox([value], row.run_id, row.tenant_id, () => false);
  if (
    value.topic !== row.topic ||
    !samePostgresTimestamp(value.createdAt, row.created_at)
  ) {
    throw new RunStoreError("stored_outbox_message_invalid");
  }
  return structuredClone(value);
}

export function decodePostgresWorkItem(row: PostgresQueueItemRow): WorkItem {
  const value = exactRecord(
    row.item_json,
    ["createdAt", "kind", "payload", "runId", "tenantId", "workItemId"],
    "stored_work_item_invalid",
  ) as WorkItem;
  stableJson(value);
  const throughSequence = value.payload.throughSequence;
  validateWorkItems(
    [value],
    row.run_id,
    row.tenant_id,
    typeof throughSequence === "number" ? throughSequence : Number.NaN,
    () => false,
    value.payload.trigger === "goalContinuation"
      ? "goalContinuation"
      : value.payload.trigger === "goalActivation"
        ? "goalActivation"
        : value.payload.trigger === "automationInvocation"
          ? "automationInvocation"
          : value.payload.trigger === "workflowScheduler"
            ? "workflowScheduler"
            : value.payload.trigger === "workflowCancel"
              ? "workflowCancel"
              : value.payload.trigger === "workflowNode"
                ? "workflowNode"
                : value.payload.trigger === "workflowReconcile"
                  ? "workflowReconcile"
                  : value.payload.trigger === "workflowToolApprovalResume"
                    ? "workflowToolApprovalResume"
                    : value.payload.trigger === "manualCompaction"
                      ? "manualCompaction"
                      : "default",
  );
  if (
    value.kind !== row.kind ||
    !samePostgresTimestamp(value.createdAt, row.created_at)
  ) {
    throw new RunStoreError("stored_work_item_invalid");
  }
  return structuredClone(value);
}

export function decodePostgresLease(
  row: PostgresQueueItemRow,
  input: QueueClaimInput,
): QueueLease {
  return {
    ownerId: input.ownerId,
    leaseId: input.leaseId,
    epoch: postgresLeaseEpoch(required(row.lease_epoch, "lease_epoch_invalid")),
    expiresAt: postgresDate(
      required(row.lease_expires_at, "lease_expiry_invalid"),
    ).toISOString(),
  };
}

export function postgresDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RunStoreError("postgres_timestamp_invalid");
  }
  return date;
}

export function postgresLeaseEpoch(value: string | number): number {
  const epoch = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new RunStoreError("lease_epoch_invalid");
  }
  return epoch;
}

function samePostgresTimestamp(value: string, stored: Date | string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && timestamp === postgresDate(stored).getTime()
  );
}

function exactRecord(
  value: unknown,
  keys: string[],
  code: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    throw new RunStoreError(code);
  }
  return value as Record<string, unknown>;
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new RunStoreError(code);
  return value;
}
