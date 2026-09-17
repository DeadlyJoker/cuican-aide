import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type WorkItem,
  type WorkItemLeaseInput,
  type WorkflowRunAdmissionAuthority,
  type WorkflowRunInputAuthority,
} from "@crewon/application";
import {
  MAX_WORKFLOW_DEFINITION_BYTES,
  type FrozenWorkflowVersionBinding,
  type RunState,
} from "@crewon/domain";
import {
  validateWorkflowAdmissionAuthority,
  validateWorkflowInputAuthority,
  validateWorkflowSchedulerWorkItems,
} from "./workflow-run-admission-validation.ts";

export function readSqliteWorkflowCompositionContext(
  database: DatabaseSync,
  input: {
    run: RunState;
    binding: FrozenWorkflowVersionBinding;
    lease: Pick<WorkItemLeaseInput, "workItemId">;
    schedulerOperationId?: string;
  },
) {
  const { run } = input;
  if (
    run.purpose !== "workflow" ||
    canonicalJson(run.workflowVersionBinding) !== canonicalJson(input.binding)
  )
    throw new RunStoreError("workflow_execution_binding_mismatch");
  const row = database
    .prepare(
      `SELECT
    CASE WHEN length(CAST(a.authority_json AS BLOB))<=${MAX_WORKFLOW_DEFINITION_BYTES * 2 + 16384} THEN a.authority_json ELSE NULL END AS authority_json,
    v.value_id,v.value_digest,CASE WHEN length(CAST(v.value_json AS BLOB))<=32768 THEN v.value_json ELSE NULL END AS value_json
    FROM workflow_run_admissions a JOIN workflow_run_inputs v ON v.tenant_id=a.tenant_id AND v.run_id=a.run_id
    WHERE a.tenant_id=? AND a.run_id=?`,
    )
    .get(run.tenantId, run.runId) as
    | {
        authority_json: string | null;
        value_id: string;
        value_digest: string;
        value_json: string | null;
      }
    | undefined;
  if (!row || row.authority_json === null || row.value_json === null)
    throw new RunStoreError("workflow_run_admission_authority_missing");
  const authority = JSON.parse(
    row.authority_json,
  ) as WorkflowRunAdmissionAuthority;
  const rootInput: WorkflowRunInputAuthority = {
    schemaVersion: "crewon.workflow-execution-value.v0",
    valueId: row.value_id,
    valueDigest: row.value_digest,
    value: JSON.parse(row.value_json),
  };
  validateWorkflowInputAuthority(rootInput);
  const workflow = validateWorkflowAdmissionAuthority(
    {
      tenantId: run.tenantId,
      workflowVersionId: input.binding.workflowVersionId,
      workflowInput: rootInput.value,
    },
    authority,
  );
  if (
    authority.workflowVersion.workflowId !== input.binding.workflowId ||
    authority.workflowVersion.contentDigest !== input.binding.contentDigest ||
    Object.entries(authority.route).some(
      ([key, value]) =>
        (run as unknown as Record<string, unknown>)[key] !== value,
    )
  )
    throw new RunStoreError("workflow_execution_binding_mismatch");
  const workRow = database
    .prepare(
      `SELECT CASE WHEN length(CAST(work_item_json AS BLOB))<=65536 THEN work_item_json ELSE NULL END AS json
    FROM work_items WHERE work_item_id=? AND tenant_id=? AND run_id=?`,
    )
    .get(input.lease.workItemId, run.tenantId, run.runId) as
    | { json: string | null }
    | undefined;
  if (!workRow || workRow.json === null)
    throw new RunStoreError("workflow_scheduler_payload_invalid");
  const workItem = JSON.parse(workRow.json) as WorkItem;
  validateWorkflowSchedulerWorkItems(
    [workItem],
    run.runId,
    run.tenantId,
    () => false,
  );
  if (
    workItem.workItemId !== input.lease.workItemId ||
    (input.schedulerOperationId !== undefined &&
      workItem.payload.schedulerOperationId !== input.schedulerOperationId) ||
    canonicalJson(workItem.payload.binding) !== canonicalJson(input.binding) ||
    canonicalJson(workItem.payload.workflowInput) !==
      canonicalJson({
        valueId: rootInput.valueId,
        valueDigest: rootInput.valueDigest,
      })
  )
    throw new RunStoreError("workflow_scheduler_payload_invalid");
  return {
    authority,
    rootInput,
    workItem,
    workflow,
  };
}
