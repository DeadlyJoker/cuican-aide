import type { DatabaseSync } from "node:sqlite";
import { RunStoreError } from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

export function readSqliteWorkflowRunOutput(
  db: DatabaseSync,
  child: RunState,
): string {
  if (!child.outputRef?.startsWith("message:")) corrupt();
  const messageId = child.outputRef.slice("message:".length);
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
  if (row && row.content_bytes > 32768)
    throw new RunStoreError("workflow_child_output_limit");
  if (
    !row ||
    row.content === null ||
    row.message_json === null ||
    row.role !== "assistant" ||
    workflowAdmissionDigest.sha256(row.content) !== row.content_digest
  )
    corrupt();
  const message = JSON.parse(row.message_json);
  if (
    message.tenantId !== child.tenantId ||
    message.threadId !== child.threadId ||
    message.messageId !== messageId ||
    message.role !== "assistant" ||
    message.sequence !== row.sequence ||
    message.content !== row.content ||
    message.contentDigest !== row.content_digest
  )
    corrupt();
  const events = db
    .prepare(
      `SELECT CASE WHEN length(CAST(event_json AS BLOB))<=16384 THEN event_json ELSE NULL END AS json
    FROM run_events WHERE tenant_id=? AND run_id=? AND sequence>? ORDER BY sequence DESC LIMIT 8`,
    )
    .all(child.tenantId, child.runId, Math.max(0, child.lastSequence - 8));
  if (events.some((row) => row.json === null)) corrupt();
  const evidence = events
    .map((row) => JSON.parse(String(row.json)))
    .filter(
      (event) =>
        event.type === "message.completed" &&
        event.identity?.runId === child.runId &&
        event.data?.messageId === messageId,
    );
  if (
    evidence.length !== 1 ||
    evidence[0].data.role !== "assistant" ||
    evidence[0].data.contentDigest !== row.content_digest ||
    evidence[0].data.messageSequence !== row.sequence
  )
    corrupt();
  return row.content;
}
function corrupt(): never {
  throw new RunStoreError("workflow_child_output_authority_corrupt");
}
