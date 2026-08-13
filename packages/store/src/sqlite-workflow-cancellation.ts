import type { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type WorkflowExecutionState,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import type {
  CompiledWorkflowVersion,
  WorkflowContentDigester,
} from "@crewon/domain";

import { stableJson } from "./store-invariants.ts";
import { workflowAuthorityId } from "./workflow-run-composition-support.ts";

type CancellationInput = Parameters<
  WorkflowRunCompositionStore["cancelWorkflowExecution"]
>[0];
type WorkflowNode = WorkflowExecutionState["nodes"][number];

export type SqliteWorkflowCancellationContext = Readonly<{
  database: DatabaseSync;
  digester: WorkflowContentDigester;
  loadWorkflow(input: CancellationInput): CompiledWorkflowVersion;
  insertWorkItem(
    workItemId: string,
    input: CancellationInput,
    payload: Record<string, unknown>,
    now: string,
    nowMs: number,
  ): void;
}>;

export function ensureSqliteCancellationReconciliation(
  context: SqliteWorkflowCancellationContext,
  input: CancellationInput,
  node: WorkflowNode,
  now: string,
  nowMs: number,
): string {
  const rows = cancellationReconciliationRows(context, input, node);
  const active = rows.filter(
    (row) => row.status === "pending" || row.status === "leased",
  );
  if (active.length > 1)
    throw new RunStoreError("workflow_cancellation_reconciliation_required");
  if (active[0] !== undefined) return active[0].workItemId;
  const reconciliationOperationId = `${input.operationId}:${node.nodeId}:reconcile:${rows.length + 1}`;
  const workItemId = workflowAuthorityId(
    "reconcile",
    {
      tenantId: input.tenantId,
      runId: input.runId,
      binding: input.binding,
      operationId: reconciliationOperationId,
      nodeId: node.nodeId,
      claimId: node.claimId,
      claimEpoch: node.claimEpoch,
    },
    context.digester,
  );
  context.insertWorkItem(
    workItemId,
    input,
    {
      schemaVersion: "crewon.workflow-reconcile-work-item.v0",
      trigger: "workflowReconcile",
      binding: input.binding,
      nodeId: node.nodeId,
      claimId: node.claimId,
      claimEpoch: node.claimEpoch,
      reconciliationOperationId,
    },
    now,
    nowMs,
  );
  return workItemId;
}

export function sqliteCancellationReconciliationWorkItemIds(
  context: SqliteWorkflowCancellationContext,
  input: CancellationInput,
  execution: WorkflowExecutionState,
): string[] {
  const workflow = context.loadWorkflow(input);
  const workItemIds = workflow.executionOrder.flatMap((nodeId) => {
    const node = execution.nodes.find(
      (candidate) => candidate.nodeId === nodeId,
    )!;
    const rows = cancellationReconciliationRows(context, input, node);
    const active = rows.filter(
      (row) => row.status === "pending" || row.status === "leased",
    );
    if (active.length > 1)
      throw new RunStoreError("workflow_cancellation_reconciliation_required");
    const proof = active[0] ?? rows.at(-1);
    return proof === undefined ? [] : [proof.workItemId];
  });
  workItemIds.sort();
  return workItemIds;
}

function cancellationReconciliationRows(
  context: SqliteWorkflowCancellationContext,
  input: CancellationInput,
  node: WorkflowNode,
): { workItemId: string; status: string }[] {
  if (node.claimId === null) return [];
  const rows = context.database
    .prepare(
      `SELECT rowid,work_item_id,status,work_item_json
    FROM work_items WHERE tenant_id=? AND run_id=? AND
    json_extract(work_item_json,'$.payload.trigger')='workflowReconcile' AND
    json_extract(work_item_json,'$.payload.nodeId')=? AND
    json_extract(work_item_json,'$.payload.claimId')=? AND
    json_extract(work_item_json,'$.payload.claimEpoch')=? ORDER BY rowid`,
    )
    .all(
      input.tenantId,
      input.runId,
      node.nodeId,
      node.claimId,
      node.claimEpoch,
    ) as { work_item_id: string; status: string; work_item_json: string }[];
  return rows.map((row) => {
    const payload = (
      JSON.parse(row.work_item_json) as { payload?: Record<string, unknown> }
    ).payload;
    const operationId = payload?.reconciliationOperationId;
    if (
      typeof operationId !== "string" ||
      !["pending", "leased", "completed"].includes(row.status) ||
      row.work_item_id !==
        workflowAuthorityId(
          "reconcile",
          {
            tenantId: input.tenantId,
            runId: input.runId,
            binding: input.binding,
            operationId,
            nodeId: node.nodeId,
            claimId: node.claimId,
            claimEpoch: node.claimEpoch,
          },
          context.digester,
        ) ||
      stableJson(payload) !==
        stableJson({
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile",
          binding: input.binding,
          nodeId: node.nodeId,
          claimId: node.claimId,
          claimEpoch: node.claimEpoch,
          reconciliationOperationId: operationId,
        })
    )
      throw new RunStoreError("workflow_cancellation_reconciliation_required");
    return { workItemId: row.work_item_id, status: row.status };
  });
}
