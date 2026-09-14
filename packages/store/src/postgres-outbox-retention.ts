import type { Pool } from "pg";
import type {
  OutboxRetentionPolicy,
  OutboxRetentionResult,
} from "@crewon/application";
import {
  DEFERRED_OUTBOX_RETENTION,
  validatedOutboxRetentionPolicy,
} from "./outbox-retention.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";

export async function prunePostgresDeliveredOutbox(
  pool: Pool,
  schema: string,
  input: OutboxRetentionPolicy,
): Promise<OutboxRetentionResult> {
  const policy = validatedOutboxRetentionPolicy(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '1ms'");
    await client.query("SET LOCAL statement_timeout = '250ms'");
    const acquired = await client.query(
      `UPDATE ${schema}.outbox_maintenance
      SET next_due = clock_timestamp() + $1 * interval '1 millisecond'
      WHERE singleton = 1 AND next_due <= clock_timestamp() RETURNING singleton`,
      [policy.minimumIntervalMs],
    );
    if (acquired.rowCount === 0) {
      await client.query("COMMIT");
      return DEFERRED_OUTBOX_RETENTION;
    }
    const candidates = await client.query<{ message_id: string }>(
      `SELECT message_id FROM ${schema}.outbox
      WHERE status = 'delivered' AND delivered_at <= statement_timestamp() - $1 * interval '1 millisecond'
      ORDER BY delivered_at, outbox_order LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [policy.retentionMs, policy.maxBatchSize],
    );
    const ids = candidates.rows.map((row) => row.message_id);
    // Standalone queue adapters have no Automation authority. Domain adapters do.
    const authority = await client.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [`${schema}.automation_invocation_receipts`],
    );
    const retainedBody =
      authority.rows[0]?.present === true
        ? `CASE WHEN EXISTS (SELECT 1 FROM ${schema}.automation_invocation_receipts AS receipt
          WHERE receipt.tenant_id = original.tenant_id AND receipt.run_id = original.run_id
            AND receipt.result_json->'outbox'->>'messageId' = original.message_id)
          THEN message_json ELSE NULL END`
        : "NULL::jsonb";
    await client.query(
      `INSERT INTO ${schema}.outbox_deduplication AS identity (message_id, tenant_id, run_id, replay_message_json)
      SELECT message_id, tenant_id, run_id, ${retainedBody} FROM ${schema}.outbox AS original WHERE message_id = ANY($1::text[])
      ON CONFLICT (message_id) DO UPDATE SET replay_message_json = excluded.replay_message_json
        WHERE identity.tenant_id = excluded.tenant_id AND identity.run_id = excluded.run_id`,
      [ids],
    );
    const removed = await client.query(
      `DELETE FROM ${schema}.outbox AS original
      USING ${schema}.outbox_deduplication AS identity
      WHERE original.message_id = ANY($1::text[]) AND original.status = 'delivered'
        AND identity.message_id = original.message_id
        AND identity.tenant_id = original.tenant_id AND identity.run_id = original.run_id`,
      [ids],
    );
    if (removed.rowCount !== ids.length)
      throw new Error("outbox_retention_identity_invalid");
    await client.query("COMMIT");
    return { disposition: "pruned", deletedMessages: removed.rowCount ?? 0 };
  } catch (error) {
    await rollbackPostgres(client);
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : null;
    if (code === "55P03" || code === "57014") return DEFERRED_OUTBOX_RETENTION;
    throw normalizePostgresError(error);
  } finally {
    client.release();
  }
}
