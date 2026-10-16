import type { DatabaseSync } from "node:sqlite";
import type { RunState } from "@crewon/domain";
import {
  decodeWorkflowRunOutput,
  workflowOutputMessageId,
} from "./workflow-run-output.ts";

export function readSqliteWorkflowRunOutput(
  db: DatabaseSync,
  child: RunState,
): string {
  const messageId = workflowOutputMessageId(child);
  const row = db
    .prepare(
      `SELECT role,content_digest,sequence,length(CAST(content AS BLOB)) AS content_bytes,
    CASE WHEN length(CAST(content AS BLOB))<=32768 THEN content ELSE NULL END AS content,
    CASE WHEN length(CAST(message_json AS BLOB))<=131072 THEN message_json ELSE NULL END AS message_json
    FROM messages WHERE tenant_id=? AND thread_id=? AND message_id=?`,
    )
    .get(child.tenantId, child.threadId, messageId) as
    | {
        role: string;
        content_digest: string;
        sequence: number;
        content_bytes: number;
        content: string | null;
        message_json: string | null;
      }
    | undefined;
  const events = db
    .prepare(
      `SELECT CASE WHEN length(CAST(event_json AS BLOB))<=16384 THEN event_json ELSE NULL END AS json
    FROM run_events WHERE tenant_id=? AND run_id=? AND sequence>? ORDER BY sequence DESC LIMIT 8`,
    )
    .all(child.tenantId, child.runId, Math.max(0, child.lastSequence - 8));
  return decodeWorkflowRunOutput(
    child,
    row,
    events as { json: string | null }[],
  );
}
