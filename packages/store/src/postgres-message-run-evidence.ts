import type { PoolClient } from "pg";
import {
  RunStoreError,
  type MessageRecord,
  type ThreadScopedLocator,
} from "@crewon/application";
import {
  MAX_MESSAGE_RUN_EVIDENCE_BYTES,
  MessageRunEvidenceBudget,
  resolveMessageRunEvidence,
  type MessageRunEvidence,
} from "./message-run-evidence.ts";
import {
  POSTGRES_TURN_START_EVIDENCE_PREDICATE,
  POSTGRES_MESSAGE_COMPLETED_EVIDENCE_PREDICATE,
} from "./message-run-evidence-schema.ts";

type EvidenceRole = "user" | "assistant";
type EvidenceMetadata = {
  message_id: string;
  tenant_id: string;
  run_id: string;
  thread_id: string | null;
  space_id: string | null;
  scope: string | null;
  key: string;
  stored_bytes: string | number;
};

/** Each requested message performs an indexed lookup with at most two candidates. */
export function postgresMessageRunEvidenceReadSql(
  schema: string,
  role: EvidenceRole,
): string {
  const user = role === "user";
  const payload = user ? "result_json" : "event_json";
  return `SELECT requested.message_id, e.*, b.thread_id, s.space_id
    FROM unnest($2::text[]) WITH ORDINALITY requested(message_id, ordinal)
    CROSS JOIN LATERAL (
      SELECT e.tenant_id, e.run_id,
        ${user ? "e.scope, e.idempotency_key AS key" : "NULL::text AS scope, e.sequence::text AS key"},
        octet_length(e.${payload}::text) AS stored_bytes
      FROM ${schema}.${user ? "idempotency_receipts" : "run_events"} e
      WHERE e.tenant_id=$1 AND ${user ? "e.result_json #>> '{messages,0,messageId}'" : "e.event_json->'data'->>'messageId'"}=requested.message_id
      AND ${user ? POSTGRES_TURN_START_EVIDENCE_PREDICATE : POSTGRES_MESSAGE_COMPLETED_EVIDENCE_PREDICATE}
      ORDER BY e.run_id ASC LIMIT 2
    ) e
    LEFT JOIN ${schema}.run_thread_bindings b ON b.tenant_id=e.tenant_id AND b.run_id=e.run_id
    LEFT JOIN ${schema}.run_snapshots s ON s.tenant_id=e.tenant_id AND s.run_id=e.run_id
    ORDER BY requested.ordinal, e.run_id`;
}

/** Read only preflighted primary keys inside the caller's unchanged snapshot. */
export function postgresMessageRunEvidenceBodySql(
  schema: string,
  role: EvidenceRole,
): string {
  const user = role === "user";
  const payload = user ? "result_json" : "event_json";
  return `SELECT requested.message_id, body.payload
    FROM jsonb_to_recordset($2::jsonb) AS requested(message_id text, run_id text, scope text, key text)
    CROSS JOIN LATERAL (
      SELECT CASE WHEN octet_length(e.${payload}::text) <= $3 THEN e.${payload} ELSE NULL END AS payload
      FROM ${schema}.${user ? "idempotency_receipts" : "run_events"} e
      WHERE e.tenant_id=$1 AND e.run_id=requested.run_id
      AND ${user ? "e.scope=requested.scope AND e.idempotency_key=requested.key" : "e.sequence=requested.key::bigint"}
      LIMIT 1
    ) body`;
}

/** At most four round trips per window; byte preflight precedes any proof decoding. */
export async function readPostgresMessageRunBindings(
  client: PoolClient,
  schema: string,
  locator: ThreadScopedLocator,
  messages: readonly MessageRecord[],
) {
  const budget = new MessageRunEvidenceBudget();
  const groups: { role: EvidenceRole; rows: EvidenceMetadata[] }[] = [];
  const candidates = new Map<string, MessageRunEvidence[]>();
  for (const role of ["user", "assistant"] as const) {
    const ids = messages
      .filter((message) => message.role === role)
      .map((message) => message.messageId);
    if (ids.length === 0) continue;
    const { rows } = await client.query<EvidenceMetadata>(
      postgresMessageRunEvidenceReadSql(schema, role),
      [locator.tenantId, ids],
    );
    for (const row of rows) {
      if (candidates.has(row.message_id))
        throw new RunStoreError("message_run_evidence_ambiguous");
      budget.consume(row.stored_bytes);
      candidates.set(row.message_id, [
        {
          tenantId: row.tenant_id,
          runId: row.run_id,
          threadId: row.thread_id,
          spaceId: row.space_id,
          payload: null,
        },
      ]);
    }
    if (rows.length > 0) groups.push({ role, rows });
  }
  for (const { role, rows } of groups) {
    const bodies = await client.query<{ message_id: string; payload: unknown }>(
      postgresMessageRunEvidenceBodySql(schema, role),
      [
        locator.tenantId,
        JSON.stringify(
          rows.map(({ message_id, run_id, scope, key }) => ({
            message_id,
            run_id,
            scope,
            key,
          })),
        ),
        MAX_MESSAGE_RUN_EVIDENCE_BYTES,
      ],
    );
    if (bodies.rows.length !== rows.length)
      throw new RunStoreError("message_run_evidence_invalid");
    const seen = new Set<string>();
    for (const body of bodies.rows) {
      const evidence = candidates.get(body.message_id)?.[0];
      if (!evidence || seen.has(body.message_id))
        throw new RunStoreError("message_run_evidence_invalid");
      seen.add(body.message_id);
      candidates.set(body.message_id, [{ ...evidence, payload: body.payload }]);
    }
  }
  return messages.map((message) =>
    resolveMessageRunEvidence(
      locator,
      message,
      candidates.get(message.messageId) ?? [],
    ),
  );
}
