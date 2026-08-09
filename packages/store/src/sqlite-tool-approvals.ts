import type { DatabaseSync } from "node:sqlite";

import {
  ToolApprovalError,
  validateToolApprovalState,
  type ToolApprovalState,
} from "@crewon/domain";
import { RunStoreError } from "@crewon/application";

type ToolApprovalRow = Readonly<{
  approval_id: string;
  tenant_id: string;
  space_id: string;
  run_id: string;
  receipt_id: string;
  work_item_id: string;
  action_digest: string;
  policy_snapshot_id: string;
  status: string;
  revision: number;
  state_json: string;
  required_at: string;
  updated_at: string;
}>;

export function loadSqliteToolApproval(
  database: DatabaseSync,
  locator: Readonly<{ tenantId: string; approvalId: string }>,
): ToolApprovalState | null {
  const row = database
    .prepare(
      `SELECT *
       FROM tool_approvals
       WHERE tenant_id = ? AND approval_id = ?`,
    )
    .get(locator.tenantId, locator.approvalId) as ToolApprovalRow | undefined;
  return row === undefined ? null : decode(row);
}

export function loadSqliteToolApprovalByAction(
  database: DatabaseSync,
  locator: Readonly<{
    tenantId: string;
    runId: string;
    actionDigest: string;
  }>,
): ToolApprovalState | null {
  const row = database
    .prepare(
      `SELECT *
       FROM tool_approvals
       WHERE tenant_id = ? AND run_id = ? AND action_digest = ?`,
    )
    .get(locator.tenantId, locator.runId, locator.actionDigest) as
    | ToolApprovalRow
    | undefined;
  return row === undefined ? null : decode(row);
}

export function loadLatestSqliteToolApprovalForRun(
  database: DatabaseSync,
  locator: Readonly<{ tenantId: string; runId: string }>,
): ToolApprovalState | null {
  const row = database
    .prepare(
      `SELECT *
       FROM tool_approvals
       WHERE tenant_id = ? AND run_id = ?
       ORDER BY required_at DESC, approval_id DESC
       LIMIT 1`,
    )
    .get(locator.tenantId, locator.runId) as ToolApprovalRow | undefined;
  return row === undefined ? null : decode(row);
}

export function insertSqliteToolApproval(
  database: DatabaseSync,
  approval: ToolApprovalState,
): void {
  validate(approval);
  database
    .prepare(
      `INSERT INTO tool_approvals (
         approval_id,
         tenant_id,
         space_id,
         run_id,
         receipt_id,
         work_item_id,
         action_digest,
         policy_snapshot_id,
         status,
         revision,
         state_json,
         required_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      approval.approvalId,
      approval.tenantId,
      approval.spaceId,
      approval.runId,
      approval.receiptId,
      approval.workItemId,
      approval.actionDigest,
      approval.policySnapshotId,
      approval.status,
      approval.revision,
      JSON.stringify(approval),
      approval.requiredAt,
      approval.updatedAt,
    );
}

export function updateSqliteToolApproval(
  database: DatabaseSync,
  current: ToolApprovalState,
  next: ToolApprovalState,
): void {
  validate(next);
  const update = database
    .prepare(
      `UPDATE tool_approvals
       SET status = ?, revision = ?, state_json = ?, updated_at = ?
       WHERE tenant_id = ? AND approval_id = ? AND revision = ?`,
    )
    .run(
      next.status,
      next.revision,
      JSON.stringify(next),
      next.updatedAt,
      current.tenantId,
      current.approvalId,
      current.revision,
    );
  if (update.changes !== 1) {
    throw new RunStoreError("approval_revision_conflict");
  }
}

function decode(row: ToolApprovalRow): ToolApprovalState {
  let state: ToolApprovalState;
  try {
    state = JSON.parse(row.state_json) as ToolApprovalState;
    validateToolApprovalState(state);
  } catch (error) {
    throw new RunStoreError("stored_tool_approval_invalid", { cause: error });
  }
  if (
    state.approvalId !== row.approval_id ||
    state.tenantId !== row.tenant_id ||
    state.spaceId !== row.space_id ||
    state.runId !== row.run_id ||
    state.receiptId !== row.receipt_id ||
    state.workItemId !== row.work_item_id ||
    state.actionDigest !== row.action_digest ||
    state.policySnapshotId !== row.policy_snapshot_id ||
    state.status !== row.status ||
    state.revision !== row.revision ||
    state.requiredAt !== row.required_at ||
    state.updatedAt !== row.updated_at
  ) {
    throw new RunStoreError("stored_tool_approval_invalid");
  }
  return structuredClone(state);
}

function validate(approval: ToolApprovalState): void {
  try {
    validateToolApprovalState(approval);
  } catch (error) {
    throw error instanceof ToolApprovalError
      ? new RunStoreError(error.code, { cause: error })
      : error;
  }
}
