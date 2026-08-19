import {
  RunStoreError,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { PoolClient } from "pg";

import { stableJson } from "./store-invariants.ts";
import { workflowAuthorityId } from "./workflow-run-composition-support.ts";
import {
  completePostgresWorkflowLease,
  insertPostgresWorkflowReceipt,
  insertPostgresWorkflowWorkItem,
  loadPostgresWorkflowAuthorities,
  loadPostgresWorkflowReceipt,
  postgresWorkflowFingerprint,
  validatePostgresWorkflowLease,
} from "./postgres-workflow-run-composition-transactions.ts";

type Input = Parameters<
  WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]
>[0];

export async function schedulePostgresWorkflowReconciliation(
  client: PoolClient,
  schema: string,
  input: Input,
  digester: WorkflowContentDigester,
): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]> {
  const fingerprint = postgresWorkflowFingerprint(
    "scheduleReconciliation",
    input,
    digester,
  );
  const replay = await loadPostgresWorkflowReceipt(
    client,
    schema,
    input,
    "scheduleReconciliation",
    fingerprint,
  );
  if (replay !== null) {
    const result = replay as Awaited<
      ReturnType<WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]>
    >;
    await validateReplay(client, schema, input, result, digester);
    return { ...structuredClone(result), disposition: "replay" };
  }
  const now = await validatePostgresWorkflowLease(client, schema, input);
  await loadPostgresWorkflowAuthorities(client, schema, input, digester);
  const current = await client.query<{ work_item_json: { payload?: unknown } }>(
    `SELECT work_item_json FROM ${schema}.work_items WHERE work_item_id=$1 FOR UPDATE`,
    [input.lease.workItemId],
  );
  if (
    (
      current.rows[0]?.work_item_json.payload as
        | { trigger?: unknown }
        | undefined
    )?.trigger === "workflowReconcile"
  )
    throw new RunStoreError("workflow_reconciliation_handoff_loop");
  const reconciliationWorkItemId = expectedId(input, digester);
  await insertPostgresWorkflowWorkItem(
    client,
    schema,
    reconciliationWorkItemId,
    input,
    expectedPayload(input),
    now,
  );
  const result = {
    disposition: "scheduled" as const,
    reconciliationWorkItemId,
    handoff: {
      currentWorkItem: "completed" as const,
      nextWorkItemId: reconciliationWorkItemId,
      kind: "reconcile" as const,
    },
  };
  await insertPostgresWorkflowReceipt(
    client,
    schema,
    input,
    "scheduleReconciliation",
    fingerprint,
    result,
  );
  await completePostgresWorkflowLease(client, schema, input, now);
  return structuredClone(result);
}

async function validateReplay(
  client: PoolClient,
  schema: string,
  input: Input,
  result: Awaited<
    ReturnType<WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]>
  >,
  digester: WorkflowContentDigester,
) {
  await loadPostgresWorkflowAuthorities(client, schema, input, digester, true);
  const expected = expectedId(input, digester);
  const work = await client.query<{
    work_item_json: { payload?: unknown };
  }>(`SELECT work_item_json FROM ${schema}.work_items WHERE work_item_id=$1`, [
    expected,
  ]);
  if (
    result.reconciliationWorkItemId !== expected ||
    result.handoff.currentWorkItem !== "completed" ||
    result.handoff.nextWorkItemId !== expected ||
    result.handoff.kind !== "reconcile" ||
    stableJson(work.rows[0]?.work_item_json.payload) !==
      stableJson(expectedPayload(input))
  )
    throw new RunStoreError("workflow_composition_receipt_corrupt");
}

function expectedId(input: Input, digester: WorkflowContentDigester) {
  return workflowAuthorityId(
    "reconcile",
    {
      tenantId: input.tenantId,
      runId: input.runId,
      binding: input.binding,
      operationId: input.operationId,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
    },
    digester,
  );
}

function expectedPayload(input: Input) {
  return {
    schemaVersion: "crewon.workflow-reconcile-work-item.v0" as const,
    trigger: "workflowReconcile" as const,
    binding: input.binding,
    nodeId: input.nodeId,
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    reconciliationOperationId: input.operationId,
  };
}
