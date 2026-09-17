import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type CommitRunInput,
  type WorkItem,
} from "@crewon/application";
import type { RunState, RunLifecycleEvent } from "@crewon/domain";
import type {
  WorkflowChildOperations,
  WorkflowChildRow,
} from "./sqlite-workflow-child-dispatch.ts";
import { RECONCILIATION_CANCEL_WAKE } from "./reconciliation-cancellation-wake.ts";
import { validateWorkItems } from "./store-invariants.ts";

export type WorkflowChildCancellationOperations = Pick<
  WorkflowChildOperations,
  "loadRun" | "commitChildRun"
> & { now(): number };
/** Caller owns the enclosing transaction and validates the root/node cancellation authority. */
export function commitSqliteWorkflowChildCancellation(
  input: {
    child: RunState;
    actorId: string;
    idempotency: CommitRunInput["idempotency"];
  },
  ops: WorkflowChildCancellationOperations,
  nextId: () => string,
): void {
  const { child } = input;
  const now = new Date(ops.now()).toISOString();
  const event: RunLifecycleEvent = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: child.runId },
    eventId: nextId(),
    sequence: child.lastSequence + 1,
    occurredAt: now,
    type: "run.cancel.requested",
    data: { actorId: input.actorId },
  };
  const result = ops.commitChildRun({
    tenantId: child.tenantId,
    expectedRevision: child.revision,
    idempotency: input.idempotency,
    events: [event],
    workItems: [],
    outbox: [
      {
        messageId: nextId(),
        tenantId: child.tenantId,
        runId: child.runId,
        topic: "run.updated",
        payload: {
          eventId: event.eventId,
          eventType: event.type,
          throughSequence: event.sequence,
        },
        createdAt: now,
      },
    ],
  });
  if (result.disposition !== "committed")
    throw new RunStoreError("workflow_child_cancel_authority_conflict");
}
export function wakeSqliteWorkflowChildCancellation(
  db: DatabaseSync,
  child: RunState,
  work: WorkItem,
  ops: Pick<WorkflowChildCancellationOperations, "now">,
): void {
  // Keep a live lease intact. Claim/retry consumes this one-shot reason, including a backoff set after cancellation.
  const changed = db
    .prepare(
      "UPDATE work_items SET available_at_ms=MIN(available_at_ms,?),last_error_code=? WHERE work_item_id=? AND tenant_id=? AND run_id=? AND status IN ('pending','leased')",
    )
    .run(
      ops.now(),
      RECONCILIATION_CANCEL_WAKE,
      work.workItemId,
      child.tenantId,
      child.runId,
    );
  if (changed.changes !== 1)
    throw new RunStoreError("workflow_child_work_authority_missing");
}

export function readSqliteWorkflowChildWorkItem(
  db: DatabaseSync,
  parent: RunState,
  child: RunState,
  row: WorkflowChildRow,
): WorkItem {
  // Use the creation receipt's exact queue identity; never scan the application's lifetime queue.
  const receipt = db
    .prepare(
      `SELECT tenant_id,run_id,CASE WHEN length(CAST(result_json AS BLOB))<=16384 THEN result_json ELSE NULL END AS json
    FROM idempotency_receipts WHERE scope=? AND idempotency_key=?`,
    )
    .get(`workflow-child:${parent.tenantId}:${parent.runId}`, row.claim_id);
  if (
    !receipt ||
    receipt.tenant_id !== child.tenantId ||
    receipt.run_id !== child.runId ||
    typeof receipt.json !== "string"
  )
    throw new RunStoreError("workflow_child_work_authority_missing");
  const result = JSON.parse(receipt.json);
  if (
    result.state?.runId !== child.runId ||
    result.state?.threadId !== child.threadId ||
    !Array.isArray(result.workItems) ||
    result.workItems.length !== 1
  )
    throw new RunStoreError("workflow_child_work_authority_missing");
  const work = result.workItems[0] as WorkItem;
  validateWorkItems([work], child.runId, child.tenantId, 1, () => false);
  const stored = db
    .prepare(
      `SELECT status,tenant_id,run_id,
    CASE WHEN length(CAST(work_item_json AS BLOB))<=65536 THEN work_item_json ELSE NULL END AS json
    FROM work_items WHERE work_item_id=?`,
    )
    .get(work.workItemId);
  if (
    !stored ||
    stored.tenant_id !== child.tenantId ||
    stored.run_id !== child.runId ||
    !["pending", "leased"].includes(String(stored.status)) ||
    typeof stored.json !== "string" ||
    canonicalJson(JSON.parse(stored.json)) !== canonicalJson(work)
  )
    throw new RunStoreError("workflow_child_work_authority_missing");
  return work;
}
