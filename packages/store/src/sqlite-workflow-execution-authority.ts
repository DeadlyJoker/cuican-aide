import type { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type WorkflowExecutionState,
} from "@crewon/application";
import {
  assertTransition,
  decodeState,
  validateState,
} from "./workflow-execution-state.ts";

export const MAX_WORKFLOW_EXECUTION_BYTES = 524_288;

export function readSqliteWorkflowExecution(
  database: DatabaseSync,
  input: { tenantId: string; runId: string },
): WorkflowExecutionState | null {
  const row = database
    .prepare(
      `SELECT revision,
    CASE WHEN length(CAST(state_json AS BLOB))<=${MAX_WORKFLOW_EXECUTION_BYTES} THEN state_json ELSE NULL END AS state_json
    FROM workflow_executions WHERE tenant_id=? AND run_id=?`,
    )
    .get(input.tenantId, input.runId) as
    | { revision: number; state_json: string | null }
    | undefined;
  if (!row) return null;
  if (row.state_json === null)
    throw new RunStoreError("workflow_execution_too_large");
  const state = decodeState(row.state_json);
  if (
    state.tenantId !== input.tenantId ||
    state.runId !== input.runId ||
    state.revision !== row.revision
  )
    throw new RunStoreError("workflow_execution_store_corrupt");
  return state;
}

/** The caller owns a transaction covering the Run, WorkItem lease and node authorities. */
export function writeSqliteWorkflowExecution(
  database: DatabaseSync,
  current: WorkflowExecutionState | null,
  next: WorkflowExecutionState,
): void {
  validateState(next);
  const json = JSON.stringify(next);
  if (Buffer.byteLength(json) > MAX_WORKFLOW_EXECUTION_BYTES)
    throw new RunStoreError("workflow_execution_too_large");
  if (current === null) {
    if (next.revision !== 1)
      throw new RunStoreError("workflow_execution_revision_invalid");
    database
      .prepare(
        "INSERT INTO workflow_executions (tenant_id,run_id,revision,state_json,updated_at) VALUES (?,?,?,?,?)",
      )
      .run(next.tenantId, next.runId, next.revision, json, next.updatedAt);
    return;
  }
  if (next.revision !== current.revision + 1)
    throw new RunStoreError("workflow_execution_revision_invalid");
  assertTransition(current, next);
  const result = database
    .prepare(
      "UPDATE workflow_executions SET revision=?,state_json=?,updated_at=? WHERE tenant_id=? AND run_id=? AND revision=?",
    )
    .run(
      next.revision,
      json,
      next.updatedAt,
      current.tenantId,
      current.runId,
      current.revision,
    );
  if (result.changes !== 1)
    throw new RunStoreError("workflow_execution_revision_conflict");
}
