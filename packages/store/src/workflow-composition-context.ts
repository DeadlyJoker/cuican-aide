import {
  canonicalJson,
  RunStoreError,
  type WorkItem,
  type WorkItemLeaseInput,
  type WorkflowRunAdmissionAuthority,
  type WorkflowRunInputAuthority,
} from "@crewon/application";
import type { FrozenWorkflowVersionBinding, RunState } from "@crewon/domain";
import {
  validateWorkflowAdmissionAuthority,
  validateWorkflowInputAuthority,
  validateWorkflowSchedulerWorkItems,
} from "./workflow-run-admission-validation.ts";
export type WorkflowCompositionContextInput = {
  run: RunState;
  binding: FrozenWorkflowVersionBinding;
  lease: Pick<WorkItemLeaseInput, "workItemId">;
  schedulerOperationId?: string;
};
export type WorkflowCompositionContextRow = {
  authority_json: string | null;
  value_id: string;
  value_digest: string;
  value_json: string | null;
};
export function decodeWorkflowCompositionContext(
  input: WorkflowCompositionContextInput,
  row: WorkflowCompositionContextRow | undefined,
  workItem: WorkItem,
) {
  const { run } = input;
  if (
    run.purpose !== "workflow" ||
    canonicalJson(run.workflowVersionBinding) !== canonicalJson(input.binding)
  )
    throw new RunStoreError("workflow_execution_binding_mismatch");
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
