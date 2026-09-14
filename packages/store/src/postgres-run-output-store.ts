import type {
  AppendRunOutputEventsInput,
  AppendRunOutputEventsResult,
  CommitRunResult,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import type { PoolClient } from "pg";
import {
  legacyRunOutputReceipt,
  prepareRunOutputAppend,
  type RunOutputReceipt,
} from "./run-output-append.ts";
import { stableJson } from "./store-invariants.ts";
import {
  writePostgresOutbox,
  writePostgresRunSnapshot,
} from "./postgres-run-writer.ts";

/** The owner holds the transaction, Run lock and current execution lease. */
export async function appendPostgresRunOutputEventsWithin(
  client: PoolClient,
  schema: string,
  current: RunState,
  input: AppendRunOutputEventsInput,
): Promise<AppendRunOutputEventsResult> {
  const existing = await client.query<{
    fingerprint: string;
    run_sequence: string;
    segment_sequence: string;
    event_id: string;
  }>(
    `
    SELECT receipts.fingerprint, receipts.run_sequence, receipts.segment_sequence, events.event_id
    FROM ${schema}.run_output_receipts AS receipts JOIN ${schema}.run_events AS events
      ON events.run_id = receipts.run_id AND events.sequence = receipts.run_sequence
    WHERE receipts.tenant_id=$1 AND receipts.run_id=$2 AND receipts.segment_id=$3 AND receipts.segment_sequence=ANY($4::bigint[])
  `,
    [
      input.tenantId,
      input.runId,
      input.entries[0]!.event.data.segmentId,
      input.entries.map(({ event }) => event.data.segmentSequence),
    ],
  );
  const compact = new Map<number, RunOutputReceipt>(
    existing.rows.map((row) => [
      Number(row.segment_sequence),
      {
        fingerprint: row.fingerprint,
        runSequence: Number(row.run_sequence),
        eventId: row.event_id,
      },
    ]),
  );
  const missing = input.entries.filter(
    ({ event }) => !compact.has(event.data.segmentSequence),
  );
  const legacy =
    missing.length === 0
      ? []
      : (
          await client.query<{
            tenant_id: string;
            run_id: string;
            scope: string;
            idempotency_key: string;
            fingerprint: string;
            result_json: CommitRunResult;
          }>(
            `SELECT receipts.tenant_id, receipts.run_id, receipts.scope, receipts.idempotency_key, receipts.fingerprint, receipts.result_json
    FROM ${schema}.idempotency_receipts AS receipts
    JOIN jsonb_to_recordset($1::jsonb) AS requested(scope text, idempotency_key text)
      ON receipts.scope=requested.scope AND receipts.idempotency_key=requested.idempotency_key`,
            [
              stableJson(
                missing.map(({ idempotency }) => ({
                  scope: idempotency.scope,
                  idempotency_key: idempotency.key,
                })),
              ),
            ],
          )
        ).rows;
  const legacyByKey = new Map(
    legacy.map((row) => [stableJson([row.scope, row.idempotency_key]), row]),
  );
  const prior = input.entries.map((entry) => {
    const receipt = compact.get(entry.event.data.segmentSequence);
    if (receipt !== undefined) return receipt;
    const row = legacyByKey.get(
      stableJson([entry.idempotency.scope, entry.idempotency.key]),
    );
    return legacyRunOutputReceipt(
      input,
      entry,
      row === undefined
        ? null
        : {
            tenantId: row.tenant_id,
            runId: row.run_id,
            fingerprint: row.fingerprint,
            result: row.result_json,
          },
    );
  });
  const usedIds = await client.query<{ id: string; kind: string }>(
    `
    SELECT event_id AS id, 'event' AS kind FROM ${schema}.run_events WHERE event_id=ANY($1::text[])
    UNION ALL SELECT message_id AS id, 'outbox' AS kind FROM ${schema}.outbox WHERE message_id=$2
  `,
    [
      input.entries.map(({ event }) => event.eventId),
      input.notification.messageId,
    ],
  );
  const eventIds = new Set(
    usedIds.rows.filter((row) => row.kind === "event").map((row) => row.id),
  );
  const outboxIds = new Set(
    usedIds.rows.filter((row) => row.kind === "outbox").map((row) => row.id),
  );
  const head = await client.query<{ segment_sequence: string }>(
    `SELECT segment_sequence FROM ${schema}.run_output_receipts WHERE run_id=$1 AND segment_id=$2 ORDER BY segment_sequence DESC LIMIT 1`,
    [input.runId, input.entries[0]!.event.data.segmentId],
  );
  const plan = prepareRunOutputAppend(current, input, prior, {
    eventId: (id) => eventIds.has(id),
    outboxId: (id) => outboxIds.has(id),
    lastSourceSequence: Number(head.rows[0]?.segment_sequence ?? 0),
  });
  if (plan.appendedEvents.length > 0) {
    await writePostgresRunSnapshot(
      client,
      schema,
      current,
      plan.state,
      current.revision,
    );
    await client.query(
      `INSERT INTO ${schema}.run_events (tenant_id, run_id, sequence, event_id, event_json)
      SELECT $1, $2, (event->>'sequence')::bigint, event->>'eventId', event FROM jsonb_array_elements($3::jsonb) AS pending(event)`,
      [input.tenantId, input.runId, stableJson(plan.appendedEvents)],
    );
    await writePostgresOutbox(client, schema, plan.outbox);
  }
  await client.query(
    `INSERT INTO ${schema}.run_output_receipts (tenant_id, run_id, segment_id, segment_sequence, run_sequence, fingerprint)
    SELECT $1, $2, item->>'segmentId', (item->>'segmentSequence')::bigint, (item->>'runSequence')::bigint, item->>'fingerprint'
    FROM jsonb_array_elements($3::jsonb) AS pending(item)
    ON CONFLICT (run_id, segment_id, segment_sequence) DO NOTHING`,
    [
      input.tenantId,
      input.runId,
      stableJson(
        plan.receipts.map(({ entry, receipt }) => ({
          segmentId: entry.event.data.segmentId,
          segmentSequence: entry.event.data.segmentSequence,
          runSequence: receipt.runSequence,
          fingerprint: receipt.fingerprint,
        })),
      ),
    ],
  );
  return structuredClone({
    state: plan.state,
    appendedEvents: plan.appendedEvents,
    replayedCount: plan.replayedCount,
  });
}
