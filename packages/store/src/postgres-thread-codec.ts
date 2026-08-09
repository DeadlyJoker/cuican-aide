import {
  RunStoreError,
  type CommitThreadResult,
  type CommitThreadRollbackResult,
  type MessageRecord,
  type MessageView,
  type ThreadLocator,
} from "@crewon/application";
import {
  validateModelHistoryItem,
  validateThreadState,
  type ModelHistoryItem,
  type ThreadState,
} from "@crewon/domain";

import { stableJson, validateMessageProposedPlan } from "./store-invariants.ts";

export type PostgresThreadRow = Readonly<{
  tenant_id: string;
  space_id: string;
  thread_id: string;
  created_by_actor_id: string;
  title: string | null;
  status: string;
  revision: string | number;
  last_event_sequence: string | number;
  last_message_sequence: string | number;
  state_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  deleted_at: Date | string | null;
  deleted_by_actor_id: string | null;
}>;

export type PostgresMessageRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  sequence: string | number;
  message_id: string;
  role: string;
  content: string;
  content_digest: string;
  created_at: Date | string;
  message_json: unknown;
  rollback_id?: string | null;
  marker_item_id?: string | null;
  history_sequence?: string | number | null;
  invalidated_at?: Date | string | null;
}>;

export type PostgresModelHistoryRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  sequence: string | number;
  item_id: string;
  run_id: string | null;
  segment_id: string | null;
  call_id: string | null;
  tool_kind: string | null;
  item_type: string;
  item_json: unknown;
  created_at: Date | string;
}>;

export type PostgresThreadReceiptRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  fingerprint: string;
  result_json: unknown;
}>;

export function decodePostgresThreadState(
  row: PostgresThreadRow,
  locator: ThreadLocator,
): ThreadState {
  const state = storedObject<ThreadState>(
    row.state_json,
    "stored_thread_state_invalid",
  );
  try {
    validateThreadState(state);
  } catch (error) {
    throw new RunStoreError("stored_thread_state_invalid", { cause: error });
  }
  if (
    state.tenantId !== row.tenant_id ||
    state.tenantId !== locator.tenantId ||
    state.spaceId !== row.space_id ||
    state.threadId !== row.thread_id ||
    state.threadId !== locator.threadId ||
    state.createdByActorId !== row.created_by_actor_id ||
    state.title !== row.title ||
    state.status !== row.status ||
    state.revision !== safeInteger(row.revision) ||
    state.lastEventSequence !== safeInteger(row.last_event_sequence) ||
    state.lastMessageSequence !== safeInteger(row.last_message_sequence) ||
    !sameTimestamp(state.createdAt, row.created_at) ||
    !sameTimestamp(state.updatedAt, row.updated_at) ||
    !sameNullableTimestamp(state.archivedAt, row.archived_at) ||
    !sameNullableTimestamp(state.deletedAt, row.deleted_at) ||
    state.deletedByActorId !== row.deleted_by_actor_id ||
    !validForkLineage(state)
  ) {
    throw new RunStoreError("stored_thread_state_invalid");
  }
  return structuredClone(state);
}

export function decodePostgresMessage(
  row: PostgresMessageRow,
  locator: ThreadLocator,
  view: MessageView = "standard",
): MessageRecord {
  const message = storedObject<MessageRecord>(
    row.message_json,
    "stored_message_invalid",
  );
  if (
    row.tenant_id !== locator.tenantId ||
    row.thread_id !== locator.threadId ||
    message.tenantId !== row.tenant_id ||
    message.threadId !== row.thread_id ||
    message.sequence !== safeInteger(row.sequence) ||
    message.messageId !== row.message_id ||
    message.role !== row.role ||
    message.content !== row.content ||
    message.contentDigest !== row.content_digest ||
    !sameTimestamp(message.createdAt, row.created_at) ||
    message.invalidation !== undefined
  ) {
    throw new RunStoreError("stored_message_invalid");
  }
  validateMessageProposedPlan(message);
  const historySequence =
    row.history_sequence === undefined || row.history_sequence === null
      ? null
      : safeInteger(row.history_sequence);
  const invalidationValues = [
    row.rollback_id ?? null,
    row.marker_item_id ?? null,
    historySequence,
    row.invalidated_at ?? null,
  ];
  const hasInvalidation = invalidationValues.every((value) => value !== null);
  if (invalidationValues.some((value) => value !== null) !== hasInvalidation) {
    throw new RunStoreError("stored_message_invalidation_invalid");
  }
  if (view !== "audit") {
    if (hasInvalidation) {
      throw new RunStoreError("stored_message_invalidation_invalid");
    }
    return structuredClone(message);
  }
  return structuredClone({
    ...message,
    invalidation: hasInvalidation
      ? {
          rollbackId: row.rollback_id!,
          markerItemId: row.marker_item_id!,
          historySequence: historySequence!,
          invalidatedAt: postgresTimestampString(row.invalidated_at!),
        }
      : null,
  });
}

export function decodePostgresModelHistoryItem(
  row: PostgresModelHistoryRow,
  locator: ThreadLocator,
): ModelHistoryItem {
  const item = storedObject<ModelHistoryItem>(
    row.item_json,
    "stored_model_history_item_invalid",
  );
  try {
    validateModelHistoryItem(item);
  } catch (error) {
    throw new RunStoreError("stored_model_history_item_invalid", {
      cause: error,
    });
  }
  if (
    row.tenant_id !== locator.tenantId ||
    row.thread_id !== locator.threadId ||
    item.tenantId !== row.tenant_id ||
    item.threadId !== row.thread_id ||
    item.sequence !== safeInteger(row.sequence) ||
    item.itemId !== row.item_id ||
    item.runId !== row.run_id ||
    item.segmentId !== row.segment_id ||
    (item.type === "tool_call" || item.type === "tool_result"
      ? item.callId !== row.call_id || item.kind !== row.tool_kind
      : row.call_id !== null || row.tool_kind !== null) ||
    item.type !== row.item_type ||
    !sameTimestamp(item.createdAt, row.created_at)
  ) {
    throw new RunStoreError("stored_model_history_item_invalid");
  }
  return structuredClone(item);
}

export function decodePostgresThreadReceipt(
  row: PostgresThreadReceiptRow,
): CommitThreadResult {
  const result = storedObject<CommitThreadResult>(
    row.result_json,
    "thread_idempotency_receipt_invalid",
  );
  if (
    result.disposition !== "committed" ||
    !isPlainObject(result.state) ||
    result.state.tenantId !== row.tenant_id ||
    result.state.threadId !== row.thread_id ||
    !Array.isArray(result.events) ||
    !Array.isArray(result.messages) ||
    !Array.isArray(result.historyItems)
  ) {
    throw new RunStoreError("thread_idempotency_receipt_invalid");
  }
  return structuredClone(result);
}

export function decodePostgresThreadRollbackReceipt(
  row: PostgresThreadReceiptRow,
): CommitThreadRollbackResult {
  return structuredClone(
    storedObject<CommitThreadRollbackResult>(
      row.result_json,
      "thread_rollback_receipt_invalid",
    ),
  );
}

export function safeInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RunStoreError("stored_integer_invalid");
  }
  return parsed;
}

function storedObject<T>(value: unknown, code: string): T {
  try {
    stableJson(value);
  } catch (error) {
    throw new RunStoreError(code, { cause: error });
  }
  if (!isPlainObject(value)) throw new RunStoreError(code);
  return value as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameTimestamp(value: string, stored: Date | string): boolean {
  return Date.parse(value) === postgresTimestamp(stored);
}

function sameNullableTimestamp(
  value: string | null,
  stored: Date | string | null,
): boolean {
  return value === null
    ? stored === null
    : stored !== null && sameTimestamp(value, stored);
}

function postgresTimestamp(value: Date | string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new RunStoreError("postgres_timestamp_invalid");
  }
  return timestamp;
}

function postgresTimestampString(value: Date | string): string {
  return typeof value === "string"
    ? new Date(value).toISOString()
    : value.toISOString();
}

function validForkLineage(state: ThreadState): boolean {
  if (
    state.forkedFromThreadId === null &&
    state.forkedThroughHistorySequence === null
  ) {
    return true;
  }
  return (
    typeof state.forkedFromThreadId === "string" &&
    state.forkedFromThreadId.trim().length > 0 &&
    state.forkedFromThreadId !== state.threadId &&
    Number.isSafeInteger(state.forkedThroughHistorySequence) &&
    (state.forkedThroughHistorySequence ?? -1) >= 0
  );
}
