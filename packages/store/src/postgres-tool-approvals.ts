import { RunStoreError } from "@crewon/application";
import {
  ToolApprovalError,
  validateToolApprovalState,
  type ToolApprovalState,
} from "@crewon/domain";
import { type Pool, type PoolClient } from "pg";

import { safeInteger } from "./postgres-thread-codec.ts";
import { stableJson } from "./store-invariants.ts";

export type ApprovalLocator = Readonly<{
  tenantId: string;
  approvalId: string;
}>;

export type ApprovalActionLocator = Readonly<{
  tenantId: string;
  runId: string;
  actionDigest: string;
}>;

export type ApprovalRunLocator = Readonly<{
  tenantId: string;
  runId: string;
}>;

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
  revision: string | number;
  state_json: unknown;
  required_at: Date | string;
  updated_at: Date | string;
}>;

const COLUMNS = `approval_id, tenant_id, space_id, run_id, receipt_id,
  work_item_id, action_digest, policy_snapshot_id, status, revision,
  state_json, required_at, updated_at`;

export async function loadPostgresToolApproval(
  connection: Pool | PoolClient,
  schema: string,
  locator: ApprovalLocator,
  lock = false,
): Promise<ToolApprovalState | null> {
  const result = await connection.query<ToolApprovalRow>(
    `SELECT ${COLUMNS} FROM ${table(schema)}
     WHERE tenant_id=$1 AND approval_id=$2${lock ? " FOR UPDATE" : ""}`,
    [locator.tenantId, locator.approvalId],
  );
  return result.rows[0] === undefined ? null : decode(result.rows[0]);
}

export async function loadPostgresToolApprovalInSpace(
  connection: Pool | PoolClient,
  schema: string,
  locator: ApprovalLocator & Readonly<{ spaceId: string }>,
): Promise<ToolApprovalState | null> {
  const result = await connection.query<ToolApprovalRow>(
    `SELECT ${COLUMNS} FROM ${table(schema)}
     WHERE tenant_id=$1 AND space_id=$2 AND approval_id=$3`,
    [locator.tenantId, locator.spaceId, locator.approvalId],
  );
  return result.rows[0] === undefined ? null : decode(result.rows[0]);
}

export async function loadPostgresToolApprovalByAction(
  connection: Pool | PoolClient,
  schema: string,
  locator: ApprovalActionLocator,
): Promise<ToolApprovalState | null> {
  const result = await connection.query<ToolApprovalRow>(
    `SELECT ${COLUMNS} FROM ${table(schema)}
     WHERE tenant_id=$1 AND run_id=$2 AND action_digest=$3`,
    [locator.tenantId, locator.runId, locator.actionDigest],
  );
  return result.rows[0] === undefined ? null : decode(result.rows[0]);
}

export async function loadLatestPostgresToolApprovalForRun(
  connection: Pool | PoolClient,
  schema: string,
  locator: ApprovalRunLocator,
): Promise<ToolApprovalState | null> {
  const result = await connection.query<ToolApprovalRow>(
    `SELECT ${COLUMNS} FROM ${table(schema)}
     WHERE tenant_id=$1 AND run_id=$2
     ORDER BY required_at DESC, approval_id DESC LIMIT 1`,
    [locator.tenantId, locator.runId],
  );
  return result.rows[0] === undefined ? null : decode(result.rows[0]);
}

export async function insertPostgresToolApproval(
  client: PoolClient,
  schema: string,
  approval: ToolApprovalState,
): Promise<void> {
  validate(approval);
  for (const key of [
    `approval-action:${approval.tenantId}:${approval.runId}:${approval.actionDigest}`,
    `approval-id:${approval.approvalId}`,
  ].sort()) {
    await advisoryLock(client, key);
  }
  const conflict = await client.query(
    `SELECT 1 FROM ${table(schema)}
     WHERE approval_id=$1
        OR (tenant_id=$2 AND run_id=$3 AND action_digest=$4)`,
    [
      approval.approvalId,
      approval.tenantId,
      approval.runId,
      approval.actionDigest,
    ],
  );
  if (conflict.rowCount !== 0) {
    throw new RunStoreError("tool_approval_conflict");
  }
  await client.query(
    `INSERT INTO ${table(schema)} (${COLUMNS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    values(approval),
  );
}

export async function updatePostgresToolApproval(
  client: PoolClient,
  schema: string,
  current: ToolApprovalState,
  next: ToolApprovalState,
): Promise<void> {
  validate(next);
  const updated = await client.query(
    `UPDATE ${table(schema)}
     SET status=$1, revision=$2, state_json=$3, updated_at=$4
     WHERE tenant_id=$5 AND approval_id=$6 AND revision=$7`,
    [
      next.status,
      next.revision,
      stableJson(next),
      next.updatedAt,
      current.tenantId,
      current.approvalId,
      current.revision,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new RunStoreError("approval_revision_conflict");
  }
}

function decode(row: ToolApprovalRow): ToolApprovalState {
  const state = storedApproval(row.state_json);
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
    state.revision !== safeInteger(row.revision) ||
    Date.parse(state.requiredAt) !== timestamp(row.required_at) ||
    Date.parse(state.updatedAt) !== timestamp(row.updated_at)
  ) {
    throw new RunStoreError("stored_tool_approval_invalid");
  }
  return structuredClone(state);
}

function storedApproval(value: unknown): ToolApprovalState {
  try {
    stableJson(value);
    validateToolApprovalState(value as ToolApprovalState);
  } catch (error) {
    throw new RunStoreError("stored_tool_approval_invalid", { cause: error });
  }
  return value as ToolApprovalState;
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

function values(approval: ToolApprovalState): unknown[] {
  return [
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
    stableJson(approval),
    approval.requiredAt,
    approval.updatedAt,
  ];
}

function table(schema: string): string {
  return `${schema}.tool_approvals`;
}

function timestamp(value: Date | string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new RunStoreError("stored_tool_approval_invalid");
  }
  return parsed;
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
}
