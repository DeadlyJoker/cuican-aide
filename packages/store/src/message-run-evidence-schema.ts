/** These indexes reference append-only evidence, never the frequently updated Run JSON. */
export const SQLITE_TURN_START_EVIDENCE_PREDICATE =
  "json_extract(result_json, '$.messages[0].role') = 'user' AND json_extract(result_json, '$.runEvents[0].type') = 'run.created'";
export const POSTGRES_TURN_START_EVIDENCE_PREDICATE =
  "result_json #>> '{messages,0,role}' = 'user' AND result_json #>> '{runEvents,0,type}' = 'run.created'";
export const SQLITE_MESSAGE_COMPLETED_EVIDENCE_PREDICATE =
  "json_extract(event_json, '$.type') = 'message.completed'";
export const POSTGRES_MESSAGE_COMPLETED_EVIDENCE_PREDICATE =
  "event_json->>'type' = 'message.completed'";

export function sqliteMessageRunEvidenceIndexSql(): string {
  return `CREATE INDEX IF NOT EXISTS message_run_start_evidence_idx
    ON idempotency_receipts(tenant_id, json_extract(result_json, '$.messages[0].messageId'), run_id)
    WHERE ${SQLITE_TURN_START_EVIDENCE_PREDICATE};
    CREATE INDEX IF NOT EXISTS message_run_output_evidence_idx
    ON run_events(tenant_id, json_extract(event_json, '$.data.messageId'), run_id)
    WHERE ${SQLITE_MESSAGE_COMPLETED_EVIDENCE_PREDICATE};`;
}

export function postgresMessageRunEvidenceIndexSql(schema: string): string {
  return `DO $existing_index$ BEGIN
      IF to_regclass('${schema}.message_run_start_evidence_idx') IS NULL THEN
        CREATE INDEX IF NOT EXISTS message_run_start_evidence_idx
    ON ${schema}.idempotency_receipts(tenant_id, (result_json #>> '{messages,0,messageId}'), run_id)
    WHERE ${POSTGRES_TURN_START_EVIDENCE_PREDICATE};
      END IF;
    END $existing_index$;
    DO $existing_index$ BEGIN
      IF to_regclass('${schema}.message_run_output_evidence_idx') IS NULL THEN
        CREATE INDEX IF NOT EXISTS message_run_output_evidence_idx
    ON ${schema}.run_events(tenant_id, (event_json->'data'->>'messageId'), run_id)
    WHERE ${POSTGRES_MESSAGE_COMPLETED_EVIDENCE_PREDICATE};
      END IF;
    END $existing_index$;`;
}
