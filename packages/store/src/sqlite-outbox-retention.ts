import type { DatabaseSync } from "node:sqlite";
import type {
  OutboxRetentionPolicy,
  OutboxRetentionResult,
} from "@crewon/application";
import {
  DEFERRED_OUTBOX_RETENTION,
  validatedOutboxRetentionPolicy,
} from "./outbox-retention.ts";
import { rollback } from "./sqlite-schema.ts";

export function pruneSqliteDeliveredOutbox(
  database: DatabaseSync,
  input: OutboxRetentionPolicy,
  now: number,
): OutboxRetentionResult {
  const policy = validatedOutboxRetentionPolicy(input);
  if (!Number.isSafeInteger(now + policy.minimumIntervalMs))
    throw new Error("outbox_maintenance_clock_invalid");
  const due = database
    .prepare("SELECT next_due_ms FROM outbox_maintenance WHERE singleton = 1")
    .get();
  if (typeof due?.next_due_ms !== "number")
    throw new Error("outbox_maintenance_state_invalid");
  if (due.next_due_ms > now) return DEFERRED_OUTBOX_RETENTION;
  const busyTimeout = database.prepare("PRAGMA busy_timeout").get()!.timeout;
  // Maintenance never waits behind foreground writes on this synchronous connection.
  database.exec("PRAGMA busy_timeout = 0");
  try {
    database.exec("BEGIN IMMEDIATE");
    const acquired = database
      .prepare(
        `UPDATE outbox_maintenance SET next_due_ms = ?
      WHERE singleton = 1 AND next_due_ms <= ?`,
      )
      .run(now + policy.minimumIntervalMs, now);
    if (acquired.changes === 0) {
      database.exec("COMMIT");
      return DEFERRED_OUTBOX_RETENTION;
    }
    // No JSON is returned to JavaScript; the index locates at most one bounded batch.
    const rows = database
      .prepare(
        `SELECT message_id FROM outbox INDEXED BY outbox_delivered_retention_idx
      WHERE status = 'delivered' AND delivered_at_ms <= ?
      ORDER BY delivered_at_ms, outbox_order LIMIT ?`,
      )
      .all(now - policy.retentionMs, policy.maxBatchSize);
    const remember =
      database.prepare(`INSERT INTO outbox_deduplication (message_id, tenant_id, run_id, replay_message_json)
      SELECT message_id, tenant_id, run_id,
        CASE WHEN EXISTS (SELECT 1 FROM automation_invocation_receipts AS receipt
          WHERE receipt.tenant_id = outbox.tenant_id AND receipt.run_id = outbox.run_id
            AND json_extract(receipt.result_json, '$.outbox.messageId') = outbox.message_id)
          THEN message_json ELSE NULL END
      FROM outbox WHERE message_id = ? AND status = 'delivered'
      ON CONFLICT (message_id) DO UPDATE SET replay_message_json = excluded.replay_message_json
        WHERE outbox_deduplication.tenant_id = excluded.tenant_id AND outbox_deduplication.run_id = excluded.run_id`);
    const remove =
      database.prepare(`DELETE FROM outbox WHERE message_id = ? AND status = 'delivered'
      AND EXISTS (SELECT 1 FROM outbox_deduplication AS identity
        WHERE identity.message_id = outbox.message_id AND identity.tenant_id = outbox.tenant_id AND identity.run_id = outbox.run_id)`);
    for (const row of rows) {
      remember.run(row.message_id!);
      if (remove.run(row.message_id!).changes !== 1)
        throw new Error("outbox_retention_identity_invalid");
    }
    database.exec("COMMIT");
    return { disposition: "pruned", deletedMessages: rows.length };
  } catch (error) {
    rollback(database);
    if (
      error instanceof Error &&
      /database is (?:locked|busy)/i.test(error.message)
    )
      return DEFERRED_OUTBOX_RETENTION;
    throw error;
  } finally {
    database.exec(`PRAGMA busy_timeout = ${Number(busyTimeout)}`);
  }
}
