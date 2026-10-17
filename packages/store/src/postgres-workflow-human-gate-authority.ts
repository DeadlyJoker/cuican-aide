import type { PoolClient } from "pg";
import { readPostgresWorkflowReviewContexts } from "./workflow-gate-review-context.ts";
import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import {
  validateWorkflowHumanGateRows,
  type GateContext,
  type WorkflowHumanGateRow,
  type WorkflowHumanGateStoredRow,
} from "./workflow-human-gate-authority.ts";
import {
  assertPostgresWorkflowHumanGateSchema,
  postgresWorkflowHumanGateSchemaPresent,
} from "./postgres-workflow-human-gate-schema.ts";

/** The parent Run lock serializes publication and decisions; all reads stay bounded to this DAG. */
export async function readPostgresWorkflowHumanGates(
  client: PoolClient,
  sql: string,
  state: WorkflowExecutionState,
  parent: RunState,
  context: GateContext,
  enabled: boolean,
) {
  const claimed = state.nodes.some(
    (node) => node.kind === "humanGate" && node.claimId !== null,
  );
  if (claimed && !enabled) throw new RunStoreError("workflow_gate_unavailable");
  const schema = sql.slice(1, -1);
  if (!(await postgresWorkflowHumanGateSchemaPresent(client, schema))) {
    if (enabled || claimed)
      throw new RunStoreError("workflow_gate_schema_corrupt");
    return new Map<string, WorkflowHumanGateRow>();
  }
  await assertPostgresWorkflowHumanGateSchema(client, schema);
  const rows = await client.query<WorkflowHumanGateStoredRow>(
    `SELECT node_id,request_id,wake_work_item_id,
     CASE WHEN octet_length(authority_json)<=8192 THEN authority_json ELSE NULL END AS authority_json,
     decision_json IS NOT NULL AS decided,
     CASE WHEN octet_length(decision_json)<=16384 THEN decision_json ELSE NULL END AS decision_json,
     CASE WHEN octet_length(wake_json)<=65536 THEN wake_json ELSE NULL END AS wake_json
     FROM ${sql}.workflow_human_gates WHERE tenant_id=$1 AND run_id=$2 LIMIT 65`,
    [state.tenantId, state.runId],
  );
  const result = validateWorkflowHumanGateRows(
    rows.rows,
    state,
    parent,
    context,
  );
  for (const { wake } of result.values()) {
    if (!wake) continue;
    const stored = (
      await client.query<{ tenant_id: string; run_id: string; json: unknown }>(
        `SELECT tenant_id,run_id,CASE WHEN octet_length(work_item_json::text)<=65536 THEN work_item_json ELSE NULL END AS json FROM ${sql}.work_items WHERE work_item_id=$1`,
        [wake.workItemId],
      )
    ).rows[0];
    if (
      stored?.tenant_id !== parent.tenantId ||
      stored.run_id !== parent.runId ||
      !stored.json ||
      canonicalJson(stored.json) !== canonicalJson(wake)
    )
      throw new RunStoreError("workflow_gate_authority_conflict");
  }
  await readPostgresWorkflowReviewContexts(client, sql, result);
  return result;
}
