import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
  type WorkflowNodeAttemptAdmission,
} from "@crewon/application";
import type { CompiledWorkflowVersion, RunStepState } from "@crewon/domain";
import {
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import {
  validateWorkflowNodeRows,
  validateWorkflowNodeAdmission,
  type WorkflowNodeRow,
} from "./workflow-node-authority.ts";
export type { WorkflowNodeRow } from "./workflow-node-authority.ts";

export function readSqliteWorkflowNodes(
  database: DatabaseSync,
  state: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
): Map<string, WorkflowNodeRow> {
  const rows = database
    .prepare(
      `SELECT n.node_id,n.claim_id,n.step_id,n.attempt_id,n.work_item_id,n.lease_epoch,n.operation_id,n.input_digest,
    CASE WHEN length(CAST(n.input_json AS BLOB))<=32768 THEN n.input_json ELSE NULL END AS input_json,
    n.output_digest,CASE WHEN length(CAST(n.output_json AS BLOB))<=32768 THEN n.output_json ELSE NULL END AS output_json,
    CASE WHEN length(CAST(n.settlement_fingerprint AS BLOB))<=4096 THEN n.settlement_fingerprint ELSE NULL END AS settlement_fingerprint,
    q.tenant_id AS queue_tenant,q.run_id AS queue_run,q.lease_epoch AS queue_epoch,q.status AS queue_status,q.lease_expires_at_ms AS queue_expires
    FROM workflow_node_admissions n LEFT JOIN work_items q ON q.work_item_id=n.work_item_id
    WHERE n.tenant_id=? AND n.run_id=? ORDER BY n.node_id LIMIT 65`,
    )
    .all(state.tenantId, state.runId) as unknown as WorkflowNodeRow[];
  return validateWorkflowNodeRows(rows, state, workflow);
}

export function sqliteWorkflowNodeAdmission(
  database: DatabaseSync,
  state: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
  row: WorkflowNodeRow,
): WorkflowNodeAttemptAdmission {
  // Guard canonical Step/Attempt bodies before the shared decoders retrieve them.
  const bytes = database
    .prepare(
      `SELECT length(CAST(s.state_json AS BLOB)) AS step_bytes,
    CASE WHEN ? IS NULL THEN 0 ELSE length(CAST(a.state_json AS BLOB)) END AS attempt_bytes
    FROM run_steps s LEFT JOIN run_attempts a ON a.tenant_id=s.tenant_id AND a.run_id=s.run_id AND a.step_id=s.step_id AND a.attempt_id=?
    WHERE s.tenant_id=? AND s.run_id=? AND s.step_id=?`,
    )
    .get(
      row.attempt_id,
      row.attempt_id,
      state.tenantId,
      state.runId,
      row.step_id,
    ) as { step_bytes: number; attempt_bytes: number | null } | undefined;
  if (
    !bytes ||
    bytes.step_bytes > 65536 ||
    bytes.attempt_bytes === null ||
    bytes.attempt_bytes > 65536
  )
    corrupt();
  const locator = {
    tenantId: state.tenantId,
    runId: state.runId,
    stepId: row.step_id,
  };
  const step = loadSqliteRunStep(database, locator);
  const attempt =
    row.attempt_id === null
      ? null
      : loadSqliteRunAttempt(database, {
          ...locator,
          attemptId: row.attempt_id,
        });
  return validateWorkflowNodeAdmission(state, workflow, row, step, attempt);
}

export function insertSqliteWorkflowGate(
  database: DatabaseSync,
  input: { tenantId: string; runId: string; stepId: string; now: string },
): RunStepState {
  const step: RunStepState = {
    schemaVersion: "crewon.run-step.v0",
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
    kind: "gate",
    status: "waitingApproval",
    revision: 1,
    currentAttemptId: null,
    attemptCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
    terminalAt: null,
  };
  database
    .prepare(
      `INSERT INTO run_steps (tenant_id,run_id,step_id,kind,status,revision,current_attempt_id,attempt_count,state_json,created_at,updated_at,terminal_at)
    VALUES (?,?,?,'gate','waitingApproval',1,NULL,0,?,?,?,NULL)`,
    )
    .run(
      input.tenantId,
      input.runId,
      input.stepId,
      canonicalJson(step),
      input.now,
      input.now,
    );
  return step;
}

function corrupt(): never {
  throw new RunStoreError("workflow_node_authority_corrupt");
}
