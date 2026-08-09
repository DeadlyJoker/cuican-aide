import {
  RunStoreError,
  type ToolExecutionActionLocator,
  type ToolExecutionReceiptLocator,
} from "@crewon/application";
import {
  validateToolExecutionReceipt,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import { type Pool, type PoolClient } from "pg";

import { safeInteger } from "./postgres-thread-codec.ts";
import { stableJson } from "./store-invariants.ts";

type ToolExecutionReceiptRow = Readonly<{
  receipt_id: string;
  tenant_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  work_item_id: string;
  action_digest: string;
  idempotency_key: string;
  status: string;
  revision: string | number;
  state_json: unknown;
  prepared_at: Date | string;
  updated_at: Date | string;
  resolved_at: Date | string | null;
}>;

const COLUMNS = `receipt_id, tenant_id, run_id, step_id, attempt_id,
  work_item_id, action_digest, idempotency_key, status, revision, state_json,
  prepared_at, updated_at, resolved_at`;

export async function loadPostgresToolExecutionReceipt(
  connection: Pool | PoolClient,
  schema: string,
  locator: ToolExecutionReceiptLocator,
  lock = false,
): Promise<ToolExecutionReceiptState | null> {
  const result = await connection.query<ToolExecutionReceiptRow>(
    `SELECT ${COLUMNS} FROM ${table(schema)}
     WHERE tenant_id=$1 AND run_id=$2 AND receipt_id=$3${lock ? " FOR UPDATE" : ""}`,
    [locator.tenantId, locator.runId, locator.receiptId],
  );
  return result.rows[0] === undefined ? null : decode(result.rows[0]);
}

export async function loadPostgresToolExecutionReceiptByAction(
  connection: Pool | PoolClient,
  schema: string,
  locator: ToolExecutionActionLocator,
): Promise<ToolExecutionReceiptState | null> {
  const result = await connection.query<ToolExecutionReceiptRow>(
    `SELECT ${COLUMNS} FROM ${table(schema)}
     WHERE tenant_id=$1 AND run_id=$2 AND action_digest=$3`,
    [locator.tenantId, locator.runId, locator.actionDigest],
  );
  return result.rows[0] === undefined ? null : decode(result.rows[0]);
}

export async function insertPostgresToolExecutionReceipt(
  client: PoolClient,
  schema: string,
  receipt: ToolExecutionReceiptState,
): Promise<void> {
  for (const key of [
    `tool-action:${receipt.tenantId}:${receipt.runId}:${receipt.actionDigest}`,
    `tool-idempotency:${receipt.tenantId}:${receipt.idempotencyKey}`,
    `tool-receipt:${receipt.receiptId}`,
  ].sort()) {
    await advisoryLock(client, key);
  }
  const conflicts = await client.query<
    Pick<
      ToolExecutionReceiptRow,
      "receipt_id" | "action_digest" | "idempotency_key"
    >
  >(
    `SELECT receipt_id, action_digest, idempotency_key FROM ${table(schema)}
     WHERE receipt_id=$1
        OR (tenant_id=$2 AND run_id=$3 AND action_digest=$4)
        OR (tenant_id=$2 AND idempotency_key=$5)`,
    [
      receipt.receiptId,
      receipt.tenantId,
      receipt.runId,
      receipt.actionDigest,
      receipt.idempotencyKey,
    ],
  );
  if (conflicts.rows.some((row) => row.receipt_id === receipt.receiptId)) {
    throw new RunStoreError("tool_receipt_id_conflict");
  }
  if (
    conflicts.rows.some((row) => row.action_digest === receipt.actionDigest)
  ) {
    throw new RunStoreError("tool_action_digest_conflict");
  }
  if (
    conflicts.rows.some((row) => row.idempotency_key === receipt.idempotencyKey)
  ) {
    throw new RunStoreError("tool_idempotency_conflict");
  }
  await client.query(
    `INSERT INTO ${table(schema)} (${COLUMNS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    values(receipt),
  );
}

export async function updatePostgresToolExecutionReceipt(
  client: PoolClient,
  schema: string,
  current: ToolExecutionReceiptState,
  next: ToolExecutionReceiptState,
): Promise<void> {
  const updated = await client.query(
    `UPDATE ${table(schema)}
     SET status=$1, revision=$2, state_json=$3, updated_at=$4, resolved_at=$5
     WHERE tenant_id=$6 AND run_id=$7 AND receipt_id=$8 AND revision=$9`,
    [
      next.status,
      next.revision,
      stableJson(next),
      next.updatedAt,
      next.resolvedAt,
      next.tenantId,
      next.runId,
      next.receiptId,
      current.revision,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new RunStoreError("tool_receipt_revision_conflict");
  }
}

function decode(row: ToolExecutionReceiptRow): ToolExecutionReceiptState {
  const state = storedReceipt(row.state_json);
  if (
    state.receiptId !== row.receipt_id ||
    state.tenantId !== row.tenant_id ||
    state.runId !== row.run_id ||
    state.stepId !== row.step_id ||
    state.attemptId !== row.attempt_id ||
    state.workItemId !== row.work_item_id ||
    state.actionDigest !== row.action_digest ||
    state.idempotencyKey !== row.idempotency_key ||
    state.status !== row.status ||
    state.revision !== safeInteger(row.revision) ||
    Date.parse(state.preparedAt) !== timestamp(row.prepared_at) ||
    Date.parse(state.updatedAt) !== timestamp(row.updated_at) ||
    !sameNullableTimestamp(state.resolvedAt, row.resolved_at)
  ) {
    throw new RunStoreError("stored_tool_receipt_invalid");
  }
  return structuredClone(state);
}

function storedReceipt(value: unknown): ToolExecutionReceiptState {
  try {
    stableJson(value);
    validateToolExecutionReceipt(value as ToolExecutionReceiptState);
  } catch (error) {
    throw new RunStoreError("stored_tool_receipt_invalid", { cause: error });
  }
  return value as ToolExecutionReceiptState;
}

function values(receipt: ToolExecutionReceiptState): unknown[] {
  return [
    receipt.receiptId,
    receipt.tenantId,
    receipt.runId,
    receipt.stepId,
    receipt.attemptId,
    receipt.workItemId,
    receipt.actionDigest,
    receipt.idempotencyKey,
    receipt.status,
    receipt.revision,
    stableJson(receipt),
    receipt.preparedAt,
    receipt.updatedAt,
    receipt.resolvedAt,
  ];
}

function table(schema: string): string {
  return `${schema}.tool_execution_receipts`;
}

function timestamp(value: Date | string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new RunStoreError("stored_tool_receipt_invalid");
  }
  return parsed;
}

function sameNullableTimestamp(
  state: string | null,
  stored: Date | string | null,
): boolean {
  return state === null
    ? stored === null
    : stored !== null && Date.parse(state) === timestamp(stored);
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
}
