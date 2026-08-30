import {
  RunStoreError,
  type QueueClaimInput,
  type QueueLease,
  type WorkItem,
} from "@crewon/application";

import { leaseExpiry } from "./lease-clock.ts";
import {
  parseQueueTimestamp,
  validateClaimedLease,
} from "./store-invariants.ts";

export type QueueRecord<T> = {
  item: T;
  status: "pending" | "leased" | "settled";
  availableAtMs: number;
  leaseOwnerId: string | null;
  leaseId: string | null;
  leaseEpoch: number;
  leaseExpiresAtMs: number | null;
};

export function queueRecord<T>(item: T, createdAt: string): QueueRecord<T> {
  return {
    item: clone(item),
    status: "pending",
    availableAtMs: parseQueueTimestamp(createdAt, "queue_created_at_invalid"),
    leaseOwnerId: null,
    leaseId: null,
    leaseEpoch: 0,
    leaseExpiresAtMs: null,
  };
}

export function pendingItems<T>(
  records: ReadonlyMap<string, QueueRecord<T>>,
  now: number,
  limit: number,
): readonly T[] {
  const items: T[] = [];
  for (const record of records.values()) {
    if (!isClaimable(record, now)) {
      continue;
    }
    items.push(clone(record.item));
    if (items.length === limit) {
      break;
    }
  }
  return items;
}

export function claimNext<T>(
  records: ReadonlyMap<string, QueueRecord<T>>,
  input: QueueClaimInput,
  now: number,
): { item: T; lease: QueueLease } | null {
  for (const record of records.values()) {
    if (!isClaimable(record, now)) {
      continue;
    }
    const expiry = leaseExpiry(now, input.leaseDurationMs);
    record.status = "leased";
    record.leaseOwnerId = input.ownerId;
    record.leaseId = input.leaseId;
    record.leaseEpoch += 1;
    record.leaseExpiresAtMs = expiry.expiresAtMs;
    return {
      item: clone(record.item),
      lease: {
        ownerId: input.ownerId,
        leaseId: input.leaseId,
        epoch: record.leaseEpoch,
        expiresAt: expiry.expiresAt,
      },
    };
  }
  return null;
}

export function settle(
  records: ReadonlyMap<string, QueueRecord<unknown>>,
  itemId: string,
  input: { ownerId: string; leaseId: string; leaseEpoch: number },
  now: number,
): void {
  const record = requiredQueueRecord(records, itemId);
  validateRecordLease(record, input, now);
  record.status = "settled";
  clearLease(record);
}

export function forceSettle(
  records: ReadonlyMap<string, QueueRecord<unknown>>,
  itemId: string,
): void {
  const record = requiredQueueRecord(records, itemId);
  if (record.status === "settled") {
    throw new RunStoreError("queue_item_already_settled");
  }
  record.status = "settled";
  clearLease(record);
}

export function retry(
  records: ReadonlyMap<string, QueueRecord<unknown>>,
  itemId: string,
  input: {
    ownerId: string;
    leaseId: string;
    leaseEpoch: number;
    retryAfterMs: number;
  },
  now: number,
): void {
  const record = requiredQueueRecord(records, itemId);
  validateRecordLease(record, input, now);
  const availableAtMs = now + input.retryAfterMs;
  if (!Number.isSafeInteger(availableAtMs)) {
    throw new RunStoreError("queue_retry_delay_invalid");
  }
  record.status = "pending";
  record.availableAtMs = availableAtMs;
  clearLease(record);
}

export function requiredQueueRecord(
  records: ReadonlyMap<string, QueueRecord<unknown>>,
  itemId: string,
): QueueRecord<unknown> {
  const record = records.get(itemId);
  if (record === undefined) {
    throw new RunStoreError("queue_item_not_found");
  }
  return record;
}

export function validateRecordLease(
  record: QueueRecord<unknown>,
  input: { ownerId: string; leaseId: string; leaseEpoch: number },
  now: number,
): void {
  const expiresAtMs = record.leaseExpiresAtMs ?? 0;
  validateClaimedLease(
    {
      ownerId: record.leaseOwnerId ?? "",
      leaseId: record.leaseId ?? "",
      epoch: record.leaseEpoch,
    },
    input,
    expiresAtMs,
    now,
    record.status,
    "settled",
  );
}

export function isWorkItem(value: unknown): value is WorkItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "run.execute"
  );
}

function clearLease(record: QueueRecord<unknown>): void {
  record.leaseOwnerId = null;
  record.leaseId = null;
  record.leaseExpiresAtMs = null;
}

function isClaimable(record: QueueRecord<unknown>, now: number): boolean {
  return (
    (record.status === "pending" && record.availableAtMs <= now) ||
    (record.status === "leased" &&
      record.leaseExpiresAtMs !== null &&
      record.leaseExpiresAtMs <= now)
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
