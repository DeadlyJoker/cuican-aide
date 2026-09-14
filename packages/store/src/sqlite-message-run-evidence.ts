import type { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type MessageRecord,
  type ThreadScopedLocator,
} from "@crewon/application";
import {
  MessageRunEvidenceBudget,
  resolveMessageRunEvidence,
} from "./message-run-evidence.ts";
import {
  SQLITE_TURN_START_EVIDENCE_PREDICATE,
  SQLITE_MESSAGE_COMPLETED_EVIDENCE_PREDICATE,
} from "./message-run-evidence-schema.ts";

export function sqliteMessageRunEvidenceReadSql(
  role: "user" | "assistant",
): string {
  const user = role === "user";
  const payload = user ? "result_json" : "event_json";
  return `SELECT e.tenant_id, e.run_id, b.thread_id, s.space_id,
    length(CAST(e.${payload} AS BLOB)) AS stored_bytes,
    CASE WHEN length(CAST(e.${payload} AS BLOB)) <= ? THEN e.${payload} ELSE NULL END AS payload
    FROM ${user ? "idempotency_receipts" : "run_events"} e
    LEFT JOIN run_thread_bindings b ON b.tenant_id=e.tenant_id AND b.run_id=e.run_id
    LEFT JOIN run_snapshots s ON s.tenant_id=e.tenant_id AND s.run_id=e.run_id
    WHERE e.tenant_id=? AND json_extract(e.${payload}, '${user ? "$.messages[0].messageId" : "$.data.messageId"}')=?
    AND ${user ? SQLITE_TURN_START_EVIDENCE_PREDICATE : SQLITE_MESSAGE_COMPLETED_EVIDENCE_PREDICATE}
    ORDER BY e.run_id ASC LIMIT 2`;
}

/** Caller owns the short message-window transaction. Bodies are bounded before JS decoding. */
export function readSqliteMessageRunBindings(
  database: DatabaseSync,
  locator: ThreadScopedLocator,
  messages: readonly MessageRecord[],
) {
  const budget = new MessageRunEvidenceBudget();
  const user = database.prepare(sqliteMessageRunEvidenceReadSql("user"));
  const assistant = database.prepare(
    sqliteMessageRunEvidenceReadSql("assistant"),
  );
  return messages.map((message) => {
    const rows =
      message.role === "user" || message.role === "assistant"
        ? (message.role === "user" ? user : assistant).all(
            budget.remaining,
            locator.tenantId,
            message.messageId,
          )
        : [];
    if (rows.length > 1)
      throw new RunStoreError("message_run_evidence_ambiguous");
    return resolveMessageRunEvidence(
      locator,
      message,
      rows.map((row) => {
        budget.consume(Number(row.stored_bytes));
        if (typeof row.payload !== "string")
          throw new RunStoreError("message_run_evidence_invalid");
        return {
          tenantId: String(row.tenant_id),
          runId: String(row.run_id),
          threadId: row.thread_id === null ? null : String(row.thread_id),
          spaceId: row.space_id === null ? null : String(row.space_id),
          payload: JSON.parse(row.payload) as unknown,
        };
      }),
    );
  });
}
