import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import {
  RunStoreError,
  type ArtifactRetentionCandidate,
} from "@crewon/application";
import {
  parseArtifactRecord,
  validateToolExecutionReceipt,
  type RunState,
  type ToolExecutionReceiptState,
} from "@crewon/domain";

export function validateArtifactRetentionCandidate(
  input: ArtifactRetentionCandidate,
): void {
  parseArtifactRecord(input.record);
  if (
    typeof input.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,1023}$/u.test(input.idempotencyKey)
  )
    throw new RunStoreError("artifact_retention_candidate_invalid");
}

export function artifactRecoveryFinished(
  input: ArtifactRetentionCandidate,
  run: RunState | null,
  receipt: ToolExecutionReceiptState | null,
): boolean {
  validateArtifactRetentionCandidate(input);
  if (run === null || receipt === null) return false;
  validateToolExecutionReceipt(receipt);
  const r = input.record;
  return (
    run.tenantId === r.tenantId &&
    run.runId === r.source.runId &&
    run.spaceId === r.spaceId &&
    run.createdByActorId === r.ownerActorId &&
    ["completed", "failed", "canceled"].includes(run.status) &&
    typeof run.terminalAt === "string" &&
    Number.isFinite(Date.parse(run.terminalAt)) &&
    receipt.tenantId === r.tenantId &&
    receipt.runId === r.source.runId &&
    receipt.stepId === r.source.stepId &&
    receipt.attemptId === r.source.attemptId &&
    receipt.call.callId === r.source.callId &&
    receipt.idempotencyKey === input.idempotencyKey &&
    receipt.status === "completed" &&
    receipt.result?.artifactRef === r.artifactId
  );
}

/** Existing primary/unique keys locate one Run and one receipt. Large/corrupt evidence cannot authorize deletion. */
function query(schema: string, postgres: boolean) {
  const p = (n: number) => (postgres ? `$${n}` : "?");
  const bounded = (column: string) =>
    postgres
      ? `CASE WHEN octet_length(${column}::text) <= 1048576 THEN ${column} ELSE NULL END`
      : `CASE WHEN length(CAST(${column} AS BLOB)) <= 1048576 THEN ${column} ELSE NULL END`;
  return `SELECT ${bounded("r.state_json")} AS run_json, ${bounded("t.state_json")} AS receipt_json,
    r.space_id, r.revision AS run_revision, r.last_sequence,
    t.receipt_id, t.step_id, t.attempt_id, t.status, t.revision AS receipt_revision
    FROM ${schema}run_snapshots r JOIN ${schema}tool_execution_receipts t
      ON t.tenant_id = r.tenant_id AND t.run_id = r.run_id
    WHERE r.tenant_id=${p(1)} AND r.run_id=${p(2)} AND t.idempotency_key=${p(3)}`;
}
function allowed(
  input: ArtifactRetentionCandidate,
  row: Record<string, unknown> | undefined,
): boolean {
  if (!row || row.run_json === null || row.receipt_json === null) return false;
  const run = (
    typeof row.run_json === "string" ? JSON.parse(row.run_json) : row.run_json
  ) as RunState;
  const receipt = (
    typeof row.receipt_json === "string"
      ? JSON.parse(row.receipt_json)
      : row.receipt_json
  ) as ToolExecutionReceiptState;
  if (
    run.spaceId !== row.space_id ||
    run.revision !== Number(row.run_revision) ||
    run.lastSequence !== Number(row.last_sequence) ||
    receipt.receiptId !== row.receipt_id ||
    receipt.stepId !== row.step_id ||
    receipt.attemptId !== row.attempt_id ||
    receipt.status !== row.status ||
    receipt.revision !== Number(row.receipt_revision)
  )
    throw new RunStoreError("artifact_retention_evidence_invalid");
  return artifactRecoveryFinished(input, run, receipt);
}
export function canRetireSqliteArtifact(
  database: DatabaseSync,
  input: ArtifactRetentionCandidate,
): boolean {
  validateArtifactRetentionCandidate(input);
  return allowed(
    input,
    database
      .prepare(query("", false))
      .get(
        input.record.tenantId,
        input.record.source.runId,
        input.idempotencyKey,
      ),
  );
}
export async function canRetirePostgresArtifact(
  pool: Pool,
  schema: string,
  input: ArtifactRetentionCandidate,
): Promise<boolean> {
  validateArtifactRetentionCandidate(input);
  const result = await pool.query(query(`${schema}.`, true), [
    input.record.tenantId,
    input.record.source.runId,
    input.idempotencyKey,
  ]);
  return allowed(input, result.rows[0]);
}
