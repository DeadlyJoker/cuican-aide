import type { PoolClient } from "pg";
import {
  canonicalJson,
  RunStoreError,
  type WorkItem,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import type { PostgresWorkflowChildRow } from "./postgres-workflow-children.ts";
import { validateWorkItems } from "./store-invariants.ts";
import { decodePostgresWorkItem } from "./postgres-queue-codec.ts";

/** Locate one durable child queue entry through its creation receipt; never scan the lifetime queue. */
export async function readPostgresWorkflowChildWork(
  client: PoolClient,
  sql: string,
  parent: RunState,
  child: RunState,
  row: PostgresWorkflowChildRow,
): Promise<{ kind: "live"; work: WorkItem } | { kind: "terminal" }> {
  const receipt = (
    await client.query<{ tenant_id: string; run_id: string; json: unknown }>(
      `SELECT tenant_id,run_id,CASE WHEN octet_length(result_json::text)<=16384 THEN result_json ELSE NULL END AS json FROM ${sql}.idempotency_receipts WHERE scope=$1 AND idempotency_key=$2`,
      [`workflow-child:${parent.tenantId}:${parent.runId}`, row.claim_id],
    )
  ).rows[0];
  if (
    !receipt ||
    receipt.tenant_id !== child.tenantId ||
    receipt.run_id !== child.runId ||
    !receipt.json ||
    typeof receipt.json !== "object"
  )
    missing();
  const result = receipt.json as { state?: RunState; workItems?: WorkItem[] };
  if (
    result.state?.runId !== child.runId ||
    result.state.threadId !== child.threadId ||
    !Array.isArray(result.workItems) ||
    result.workItems.length !== 1
  )
    missing();
  const work = result.workItems[0]!;
  validateWorkItems([work], child.runId, child.tenantId, 1, () => false);
  const stored = (
    await client.query<{
      tenant_id: string;
      run_id: string;
      kind: string;
      item_json: unknown;
      created_at: Date;
      status: string;
      run_status: string;
    }>(
      `SELECT w.tenant_id,w.run_id,w.kind,w.created_at,w.status,CASE WHEN octet_length(w.work_item_json::text)<=65536 THEN w.work_item_json ELSE NULL END AS item_json,r.state_json->>'status' AS run_status
    FROM ${sql}.work_items w JOIN ${sql}.run_snapshots r ON r.tenant_id=w.tenant_id AND r.run_id=w.run_id WHERE w.work_item_id=$1 AND w.tenant_id=$2 AND w.run_id=$3`,
      [work.workItemId, child.tenantId, child.runId],
    )
  ).rows[0];
  if (
    !stored ||
    !["pending", "leased", "completed"].includes(stored.status) ||
    canonicalJson(decodePostgresWorkItem(stored)) !== canonicalJson(work)
  )
    missing();
  if (["completed", "failed", "canceled"].includes(stored.run_status))
    return { kind: "terminal" };
  if (stored.status === "completed") missing();
  return { kind: "live", work };
}
function missing(): never {
  throw new RunStoreError("workflow_child_work_authority_missing");
}
