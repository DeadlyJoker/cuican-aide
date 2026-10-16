import type { PoolClient } from "pg";
import {
  RunStoreError,
  type WorkflowExecutionState,
} from "@crewon/application";
import {
  assertTransition,
  decodeState,
  validateState,
  MAX_WORKFLOW_EXECUTION_BYTES,
} from "./workflow-execution-state.ts";

export async function readPostgresWorkflowExecution(
  client: PoolClient,
  sql: string,
  input: { tenantId: string; runId: string },
  options: { lock: "update" | "snapshot" } = { lock: "update" },
): Promise<WorkflowExecutionState | null> {
  const result = await client.query<{
    revision: string;
    state_json: unknown;
    updated_at: Date;
  }>(
    `SELECT revision,updated_at,CASE WHEN octet_length(state_json::text)<=${MAX_WORKFLOW_EXECUTION_BYTES} THEN state_json ELSE NULL END AS state_json
     FROM ${sql}.workflow_executions WHERE tenant_id=$1 AND run_id=$2${options.lock === "update" ? " FOR UPDATE" : ""}`,
    [input.tenantId, input.runId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.state_json === null)
    throw new RunStoreError("workflow_execution_too_large");
  const state = decodeState(row.state_json);
  if (
    state.tenantId !== input.tenantId ||
    state.runId !== input.runId ||
    state.revision !== Number(row.revision) ||
    Date.parse(state.updatedAt) !== row.updated_at.getTime()
  )
    throw new RunStoreError("workflow_execution_store_corrupt");
  return state;
}

/** Caller owns the canonical Run lock, scheduler lease and transaction. */
export async function writePostgresWorkflowExecution(
  client: PoolClient,
  sql: string,
  current: WorkflowExecutionState | null,
  next: WorkflowExecutionState,
): Promise<void> {
  validateState(next);
  const json = JSON.stringify(next);
  if (Buffer.byteLength(json) > MAX_WORKFLOW_EXECUTION_BYTES)
    throw new RunStoreError("workflow_execution_too_large");
  if (current === null) {
    if (next.revision !== 1)
      throw new RunStoreError("workflow_execution_revision_invalid");
    await client.query(
      `INSERT INTO ${sql}.workflow_executions (tenant_id,run_id,revision,state_json,updated_at) VALUES ($1,$2,$3,$4,$5)`,
      [next.tenantId, next.runId, next.revision, json, next.updatedAt],
    );
    return;
  }
  if (next.revision !== current.revision + 1)
    throw new RunStoreError("workflow_execution_revision_invalid");
  assertTransition(current, next);
  const result = await client.query(
    `UPDATE ${sql}.workflow_executions SET revision=$1,state_json=$2,updated_at=$3
    WHERE tenant_id=$4 AND run_id=$5 AND revision=$6`,
    [
      next.revision,
      json,
      next.updatedAt,
      current.tenantId,
      current.runId,
      current.revision,
    ],
  );
  if (result.rowCount !== 1)
    throw new RunStoreError("workflow_execution_revision_conflict");
}
