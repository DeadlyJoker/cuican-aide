import {
  RunStoreError,
  type CommitRunResult,
  type RunLocator,
} from "@crewon/application";
import { type RunLifecycleEvent, type RunState } from "@crewon/domain";

import { stableJson } from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";

export type PostgresRunRow = Readonly<{
  tenant_id: string;
  space_id: string;
  run_id: string;
  revision: string | number;
  last_sequence: string | number;
  state_json: unknown;
  updated_at: Date | string;
  thread_id: string | null;
}>;

export type PostgresRunEventRow = Readonly<{
  tenant_id: string;
  run_id: string;
  sequence: string | number;
  event_id: string;
  event_json: unknown;
}>;

export type PostgresRunReceiptRow = Readonly<{
  tenant_id: string;
  run_id: string;
  fingerprint: string;
  result_json: unknown;
}>;

export function decodePostgresRunState(
  row: PostgresRunRow,
  locator: RunLocator,
): RunState {
  const state = normalizeStoredRunState(
    storedObject<RunState>(row.state_json, "stored_run_state_invalid"),
    "stored_run_state_invalid",
  );
  if (
    state.tenantId !== row.tenant_id ||
    state.tenantId !== locator.tenantId ||
    state.spaceId !== row.space_id ||
    state.runId !== row.run_id ||
    state.runId !== locator.runId ||
    state.revision !== safeInteger(row.revision) ||
    state.lastSequence !== safeInteger(row.last_sequence) ||
    row.thread_id === null ||
    state.threadId !== row.thread_id ||
    Date.parse(state.updatedAt) !== postgresTimestamp(row.updated_at)
  ) {
    throw new RunStoreError("stored_run_state_invalid");
  }
  return structuredClone(state);
}

export function decodePostgresRunEvent(
  row: PostgresRunEventRow,
  locator: RunLocator,
): RunLifecycleEvent {
  const event = storedObject<RunLifecycleEvent>(
    row.event_json,
    "stored_event_invalid",
  );
  if (
    !isPlainObject(event.identity) ||
    row.tenant_id !== locator.tenantId ||
    row.run_id !== locator.runId ||
    event.identity.runId !== row.run_id ||
    event.sequence !== safeInteger(row.sequence) ||
    event.eventId !== row.event_id
  ) {
    throw new RunStoreError("stored_event_invalid");
  }
  return structuredClone(event);
}

export function decodePostgresRunReceipt(
  row: PostgresRunReceiptRow,
): CommitRunResult {
  const stored = storedObject<CommitRunResult>(
    row.result_json,
    "idempotency_receipt_invalid",
  );
  const result = {
    ...stored,
    state: normalizeStoredRunState(stored.state, "idempotency_receipt_invalid"),
  };
  if (
    result.disposition !== "committed" ||
    !isPlainObject(result.state) ||
    result.state.tenantId !== row.tenant_id ||
    result.state.runId !== row.run_id ||
    !Array.isArray(result.events) ||
    !Array.isArray(result.outbox) ||
    !Array.isArray(result.workItems)
  ) {
    throw new RunStoreError("idempotency_receipt_invalid");
  }
  return structuredClone(result);
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

function safeInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RunStoreError("stored_integer_invalid");
  }
  return parsed;
}

function postgresTimestamp(value: Date | string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new RunStoreError("postgres_timestamp_invalid");
  }
  return timestamp;
}
