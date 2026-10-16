import type { PoolClient } from "pg";
import type { RunState } from "@crewon/domain";
import {
  decodeWorkflowRunOutput,
  workflowOutputMessageId,
  type WorkflowOutputRow,
} from "./workflow-run-output.ts";

export async function readPostgresWorkflowRunOutput(
  client: PoolClient,
  sql: string,
  child: RunState,
): Promise<string> {
  const messageId = workflowOutputMessageId(child);
  const result = await client.query<
    Omit<WorkflowOutputRow, "sequence"> & { sequence: string }
  >(
    `SELECT role,content_digest,sequence,octet_length(content) AS content_bytes,
    CASE WHEN octet_length(content)<=32768 THEN content ELSE NULL END AS content,
    CASE WHEN octet_length(message_json::text)<=131072 THEN message_json::text ELSE NULL END AS message_json
    FROM ${sql}.messages WHERE tenant_id=$1 AND thread_id=$2 AND message_id=$3`,
    [child.tenantId, child.threadId, messageId],
  );
  const events = await client.query<{ json: string | null }>(
    `SELECT CASE WHEN octet_length(event_json::text)<=16384 THEN event_json::text ELSE NULL END AS json
    FROM ${sql}.run_events WHERE tenant_id=$1 AND run_id=$2 AND sequence>$3 ORDER BY sequence DESC LIMIT 8`,
    [child.tenantId, child.runId, Math.max(0, child.lastSequence - 8)],
  );
  const row = result.rows[0];
  return decodeWorkflowRunOutput(
    child,
    row ? { ...row, sequence: Number(row.sequence) } : undefined,
    events.rows,
  );
}
