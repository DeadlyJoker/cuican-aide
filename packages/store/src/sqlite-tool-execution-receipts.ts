import { DatabaseSync } from "node:sqlite";

import {
  validateToolExecutionReceipt,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import {
  RunStoreError,
  type ToolExecutionActionLocator,
  type ToolExecutionReceiptLocator,
} from "@crewon/application";

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
  revision: number;
  state_json: string;
  prepared_at: string;
  updated_at: string;
  resolved_at: string | null;
}>;

const COLUMNS = `
  receipt_id,
  tenant_id,
  run_id,
  step_id,
  attempt_id,
  work_item_id,
  action_digest,
  idempotency_key,
  status,
  revision,
  state_json,
  prepared_at,
  updated_at,
  resolved_at`;

export function loadSqliteToolExecutionReceipt(
  database: DatabaseSync,
  locator: ToolExecutionReceiptLocator,
): ToolExecutionReceiptState | null {
  const row = database
    .prepare(
      `SELECT ${COLUMNS}
       FROM tool_execution_receipts
       WHERE tenant_id = ? AND run_id = ? AND receipt_id = ?`,
    )
    .get(locator.tenantId, locator.runId, locator.receiptId) as
    | ToolExecutionReceiptRow
    | undefined;
  return row === undefined ? null : decode(row);
}

export function loadSqliteToolExecutionReceiptByAction(
  database: DatabaseSync,
  locator: ToolExecutionActionLocator,
): ToolExecutionReceiptState | null {
  const row = database
    .prepare(
      `SELECT ${COLUMNS}
       FROM tool_execution_receipts
       WHERE tenant_id = ? AND run_id = ? AND action_digest = ?`,
    )
    .get(locator.tenantId, locator.runId, locator.actionDigest) as
    | ToolExecutionReceiptRow
    | undefined;
  return row === undefined ? null : decode(row);
}

export function insertSqliteToolExecutionReceipt(
  database: DatabaseSync,
  receipt: ToolExecutionReceiptState,
): void {
  const conflicts = database
    .prepare(
      `SELECT receipt_id, action_digest, idempotency_key
       FROM tool_execution_receipts
       WHERE receipt_id = ?
          OR (tenant_id = ? AND run_id = ? AND action_digest = ?)
          OR (tenant_id = ? AND idempotency_key = ?)`,
    )
    .all(
      receipt.receiptId,
      receipt.tenantId,
      receipt.runId,
      receipt.actionDigest,
      receipt.tenantId,
      receipt.idempotencyKey,
    ) as unknown as Pick<
    ToolExecutionReceiptRow,
    "receipt_id" | "action_digest" | "idempotency_key"
  >[];
  if (conflicts.some((row) => row.receipt_id === receipt.receiptId)) {
    throw new RunStoreError("tool_receipt_id_conflict");
  }
  if (conflicts.some((row) => row.action_digest === receipt.actionDigest)) {
    throw new RunStoreError("tool_action_digest_conflict");
  }
  if (conflicts.some((row) => row.idempotency_key === receipt.idempotencyKey)) {
    throw new RunStoreError("tool_idempotency_conflict");
  }
  database
    .prepare(
      `INSERT INTO tool_execution_receipts (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function updateSqliteToolExecutionReceipt(
  database: DatabaseSync,
  current: ToolExecutionReceiptState,
  next: ToolExecutionReceiptState,
): void {
  const result = database
    .prepare(
      `UPDATE tool_execution_receipts
       SET status = ?, revision = ?, state_json = ?, updated_at = ?, resolved_at = ?
       WHERE tenant_id = ? AND run_id = ? AND receipt_id = ? AND revision = ?`,
    )
    .run(
      next.status,
      next.revision,
      stableJson(next),
      next.updatedAt,
      next.resolvedAt,
      next.tenantId,
      next.runId,
      next.receiptId,
      current.revision,
    );
  if (result.changes !== 1) {
    throw new RunStoreError("tool_receipt_revision_conflict");
  }
}

function decode(row: ToolExecutionReceiptRow): ToolExecutionReceiptState {
  let state: ToolExecutionReceiptState;
  try {
    state = JSON.parse(row.state_json) as ToolExecutionReceiptState;
    validateToolExecutionReceipt(state);
  } catch (error) {
    throw new RunStoreError("stored_tool_receipt_invalid", { cause: error });
  }
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
    state.revision !== row.revision ||
    state.preparedAt !== row.prepared_at ||
    state.updatedAt !== row.updated_at ||
    state.resolvedAt !== row.resolved_at
  ) {
    throw new RunStoreError("stored_tool_receipt_invalid");
  }
  return state;
}
