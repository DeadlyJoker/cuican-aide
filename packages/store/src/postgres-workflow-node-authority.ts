import type { PoolClient } from "pg";
import {
  RunStoreError,
  type WorkflowExecutionState,
} from "@crewon/application";
import type { CompiledWorkflowVersion } from "@crewon/domain";
import {
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import {
  validateWorkflowNodeRows,
  validateWorkflowNodeAdmission,
  type WorkflowNodeRow,
} from "./workflow-node-authority.ts";

export async function readPostgresWorkflowNodes(
  client: PoolClient,
  sql: string,
  state: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
) {
  const result = await client.query<
    Omit<WorkflowNodeRow, "lease_epoch" | "queue_epoch" | "queue_expires"> & {
      lease_epoch: string;
      queue_epoch: string | null;
      queue_expires: string | null;
    }
  >(
    `SELECT n.node_id,n.claim_id,n.step_id,n.attempt_id,n.work_item_id,n.lease_epoch,n.operation_id,n.input_digest,
     CASE WHEN octet_length(n.input_json)<=32768 THEN n.input_json ELSE NULL END AS input_json,
     n.output_digest,CASE WHEN octet_length(n.output_json)<=32768 THEN n.output_json ELSE NULL END AS output_json,
     CASE WHEN octet_length(n.settlement_fingerprint)<=4096 THEN n.settlement_fingerprint ELSE NULL END AS settlement_fingerprint,
     q.tenant_id AS queue_tenant,q.run_id AS queue_run,q.lease_epoch AS queue_epoch,q.status AS queue_status,
     (extract(epoch FROM q.lease_expires_at)*1000)::bigint AS queue_expires
     FROM ${sql}.workflow_node_admissions n LEFT JOIN ${sql}.work_items q ON q.work_item_id=n.work_item_id
     WHERE n.tenant_id=$1 AND n.run_id=$2 ORDER BY n.node_id LIMIT 65`,
    [state.tenantId, state.runId],
  );
  const rows: WorkflowNodeRow[] = result.rows.map((row) => ({
    ...row,
    lease_epoch: integer(row.lease_epoch),
    queue_epoch: row.queue_epoch === null ? null : integer(row.queue_epoch),
    queue_expires:
      row.queue_expires === null ? null : integer(row.queue_expires),
  }));
  return validateWorkflowNodeRows(rows, state, workflow);
}

export async function postgresWorkflowNodeAdmission(
  client: PoolClient,
  sql: string,
  state: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
  row: WorkflowNodeRow,
) {
  const bytes = await client.query<{
    step_bytes: number;
    attempt_bytes: number | null;
  }>(
    `SELECT octet_length(s.state_json::text) AS step_bytes,
     CASE WHEN $1::text IS NULL THEN 0 ELSE octet_length(a.state_json::text) END AS attempt_bytes
     FROM ${sql}.run_steps s LEFT JOIN ${sql}.run_attempts a ON a.tenant_id=s.tenant_id AND a.run_id=s.run_id AND a.step_id=s.step_id AND a.attempt_id=$1
     WHERE s.tenant_id=$2 AND s.run_id=$3 AND s.step_id=$4`,
    [row.attempt_id, state.tenantId, state.runId, row.step_id],
  );
  const bound = bytes.rows[0];
  if (
    !bound ||
    bound.step_bytes > 65536 ||
    bound.attempt_bytes === null ||
    bound.attempt_bytes > 65536
  )
    throw new RunStoreError("workflow_node_authority_corrupt");
  const locator = {
    tenantId: state.tenantId,
    runId: state.runId,
    stepId: row.step_id,
  };
  const step = await loadPostgresRunStep(client, sql, locator);
  const attempt =
    row.attempt_id === null
      ? null
      : await loadPostgresRunAttempt(client, sql, {
          ...locator,
          attemptId: row.attempt_id,
        });
  return validateWorkflowNodeAdmission(state, workflow, row, step, attempt);
}
function integer(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new RunStoreError("workflow_node_authority_corrupt");
  return result;
}
