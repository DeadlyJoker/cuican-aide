import type { PoolClient } from "pg";
import {
  canonicalJson,
  RunStoreError,
  type WorkItem,
} from "@crewon/application";
import { MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES } from "./workflow-run-admission-receipt.ts";
import {
  decodeWorkflowCompositionContext,
  type WorkflowCompositionContextInput,
  type WorkflowCompositionContextRow,
} from "./workflow-composition-context.ts";

export async function readPostgresWorkflowCompositionContext(
  client: PoolClient,
  sql: string,
  input: WorkflowCompositionContextInput,
) {
  const { run } = input;
  if (
    run.purpose !== "workflow" ||
    canonicalJson(run.workflowVersionBinding) !== canonicalJson(input.binding)
  )
    throw new RunStoreError("workflow_execution_binding_mismatch");
  const result = await client.query<WorkflowCompositionContextRow>(
    `SELECT
    CASE WHEN octet_length(a.authority_json)<=${MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES} THEN a.authority_json ELSE NULL END AS authority_json,
    v.value_id,v.value_digest,CASE WHEN octet_length(v.value_json)<=32768 THEN v.value_json ELSE NULL END AS value_json
    FROM ${sql}.workflow_run_admissions a JOIN ${sql}.workflow_run_inputs v ON v.tenant_id=a.tenant_id AND v.run_id=a.run_id
    WHERE a.tenant_id=$1 AND a.run_id=$2`,
    [run.tenantId, run.runId],
  );
  const work = await client.query<{ json: unknown }>(
    `SELECT CASE WHEN octet_length(work_item_json::text)<=65536 THEN work_item_json ELSE NULL END AS json
    FROM ${sql}.work_items WHERE work_item_id=$1 AND tenant_id=$2 AND run_id=$3`,
    [input.lease.workItemId, run.tenantId, run.runId],
  );
  if (!work.rows[0]?.json)
    throw new RunStoreError("workflow_scheduler_payload_invalid");
  return decodeWorkflowCompositionContext(
    input,
    result.rows[0],
    work.rows[0].json as WorkItem,
  );
}
