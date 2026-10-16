import type { PoolClient } from "pg";
import { RunStoreError } from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { assertPostgresWorkflowCancellationSchema } from "./postgres-workflow-cancellation-schema.ts";
import { readPostgresWorkflowCompositionContext } from "./postgres-workflow-composition-context.ts";
import {
  decodePostgresRunEvent,
  type PostgresRunEventRow,
} from "./postgres-run-codec.ts";

/** Prove the original one-shot wake against canonical cancellation evidence, never a lifetime event scan. */
export async function readPostgresWorkflowCancellationRequest(
  client: PoolClient,
  sql: string,
  run: RunState,
) {
  await assertPostgresWorkflowCancellationSchema(client, sql.slice(1, -1));
  if (run.purpose !== "workflow" || !run.cancelRequested) corrupt();
  const row = (
    await client.query<
      PostgresRunEventRow & {
        work_item_id: string;
        operation_id: string;
        request_sequence: string;
        created_at: Date;
        children_signaled: boolean;
      }
    >(
      `SELECT w.work_item_id,w.operation_id,w.request_sequence,w.created_at,w.children_signaled,
      e.tenant_id,e.run_id,e.sequence,e.event_id,
      CASE WHEN octet_length(e.event_json::text)<=16384 THEN e.event_json ELSE NULL END AS event_json
      FROM ${sql}.workflow_cancellation_wakes w JOIN ${sql}.run_events e ON e.tenant_id=w.tenant_id AND e.run_id=w.run_id AND e.sequence=w.request_sequence
      WHERE w.tenant_id=$1 AND w.run_id=$2`,
      [run.tenantId, run.runId],
    )
  ).rows[0];
  if (!row || !row.event_json || typeof row.children_signaled !== "boolean")
    corrupt();
  const request = decodePostgresRunEvent(row, run);
  if (
    request.type !== "run.cancel.requested" ||
    request.sequence !== Number(row.request_sequence) ||
    request.sequence > run.lastSequence ||
    Date.parse(request.occurredAt) !== row.created_at.getTime()
  )
    corrupt();
  const context = await readPostgresWorkflowCompositionContext(client, sql, {
    run,
    binding: run.workflowVersionBinding!,
    lease: { workItemId: row.work_item_id },
    schedulerOperationId: row.operation_id,
  });
  if (context.workItem.createdAt !== request.occurredAt) corrupt();
  return { request, context, signaled: row.children_signaled };
}
function corrupt(): never {
  throw new RunStoreError("workflow_cancel_request_authority_missing");
}
