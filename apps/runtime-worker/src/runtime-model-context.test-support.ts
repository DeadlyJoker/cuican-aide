import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type { ModelHistoryItem } from "@crewon/domain";
import {
  SqliteRunStore,
  PostgresDomainStore,
  readSqliteModelAccountingReport,
  readPostgresModelAccountingReport,
  type LeaseClock,
} from "@crewon/store";
import { Pool } from "pg";

export async function createContextTestStorage(
  context: TestContext,
  backend: "sqlite" | "postgres",
  clock: LeaseClock,
) {
  if (backend === "sqlite") {
    const directory = mkdtempSync(join(tmpdir(), "crewon-runtime-context-"));
    const path = join(directory, "store.sqlite");
    const stores: SqliteRunStore[] = [];
    const open = async () => {
      const store = new SqliteRunStore(path, { clock });
      stores.push(store);
      return store;
    };
    const store = await open();
    const database = new DatabaseSync(path);
    context.after(async () => {
      for (const opened of stores) await opened.close();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return {
      store,
      open,
      failCompactionRetirement: async (enabled: boolean) => {
        database.exec(
          enabled
            ? "CREATE TRIGGER fixture_reject_checkpoint_delete BEFORE DELETE ON context_compaction_checkpoints BEGIN SELECT RAISE(ABORT,'fixture_checkpoint_retirement_failure'); END;"
            : "DROP TRIGGER fixture_reject_checkpoint_delete;",
        );
      },
      corruptCompactionCheckpoint: async () => {
        database.exec(
          "UPDATE context_compaction_checkpoints SET payload='corrupt'",
        );
      },
      executionProgressCount: async () => Number(database.prepare("SELECT count(*) n FROM run_execution_progress").get()!.n),
      corruptExecutionProgress: async () => { database.exec("UPDATE run_execution_progress SET payload='corrupt'"); },
      compactionCheckpointCount: async () =>
        Number(
          database
            .prepare("SELECT count(*) n FROM context_compaction_checkpoints")
            .get()!.n,
        ),
      canonicalToolOutputCounts: async () => ({
        history: Number(database.prepare("SELECT count(*) n FROM model_history_items WHERE item_type='tool_result' AND json_type(item_json,'$.output')='object'").get()!.n),
        events: Number(database.prepare("SELECT count(*) n FROM run_events WHERE json_extract(event_json,'$.type')='tool.completed' AND json_type(event_json,'$.data.output')='object'").get()!.n),
      }),
      encodedToolResultCount: async () =>
        Number(
          database
            .prepare("SELECT count(*) n FROM tool_execution_receipts WHERE json_type(state_json,'$.result.output')='object'")
            .get()!.n,
        ),
      breakEncodedToolResult: async () => {
        const row = database
          .prepare("SELECT receipt_id,state_json FROM tool_execution_receipts WHERE json_type(state_json,'$.result.output')='object' LIMIT 1")
          .get();
        if (!row) throw new Error("encoded_tool_result_missing");
        database
          .prepare("UPDATE tool_execution_receipts SET state_json=json_set(state_json,'$.result.output.digest',?) WHERE receipt_id=?")
          .run("0".repeat(64), row.receipt_id!);
        return async () => {
          database
            .prepare("UPDATE tool_execution_receipts SET state_json=? WHERE receipt_id=?")
            .run(row.state_json!, row.receipt_id!);
        };
      },
      receiptStorageSummary: async () => ({
        fullCount: Number(
          database.prepare("SELECT count(*) n FROM idempotency_receipts").get()!
            .n,
        ),
        fullBytes: Number(
          database
            .prepare(
              "SELECT coalesce(sum(length(cast(fingerprint AS BLOB))+length(cast(result_json AS BLOB))),0) n FROM idempotency_receipts",
            )
            .get()!.n,
        ),
        compactCount: Number(
          database.prepare("SELECT count(*) n FROM run_output_receipts").get()!
            .n,
        ),
        compactBytes: Number(
          database
            .prepare(
              "SELECT coalesce(sum(length(fingerprint)),0) n FROM run_output_receipts",
            )
            .get()!.n,
        ),
      }),
      expireWorkItemLease: async (runId: string) => {
        database
          .prepare(
            "UPDATE work_items SET lease_expires_at_ms=0 WHERE run_id=? AND status='leased'",
          )
          .run(runId);
      },
      accountingReport: (locator: { tenantId: string; runId: string }) =>
        readSqliteModelAccountingReport({ databasePath: path, ...locator }),
      makePendingWorkDue: async (runId: string) => {
        database
          .prepare(
            "UPDATE work_items SET available_at_ms=0 WHERE run_id=? AND status='pending'",
          )
          .run(runId);
      },
      progress: async () =>
        Number(
          database
            .prepare("SELECT through_sequence FROM model_history_context_state")
            .get()?.through_sequence ?? 0,
        ),
      seed: async (items: readonly ModelHistoryItem[]) => {
        const insert = database.prepare(`INSERT INTO model_history_items
          (tenant_id, thread_id, sequence, item_id, run_id, segment_id, item_type, item_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const item of items)
            insert.run(
              item.tenantId,
              item.threadId,
              item.sequence,
              item.itemId,
              item.runId,
              item.segmentId,
              item.type,
              JSON.stringify(item),
              item.createdAt,
            );
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    };
  }
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (connectionString === undefined)
    throw new Error("PostgreSQL test URL missing");
  const schemaName = `crewon_worker_context_${randomUUID().replaceAll("-", "_")}`;
  const schema = `"${schemaName}"`;
  const admin = new Pool({ connectionString, max: 1 });
  const stores: PostgresDomainStore[] = [];
  const open = async () => {
    const store = await PostgresDomainStore.open({
      connectionString,
      schema: schemaName,
      maxPoolSize: 2,
    });
    stores.push(store);
    return store;
  };
  const store = await open();
  context.after(async () => {
    for (const opened of stores) await opened.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  return {
    store,
    open,
    failCompactionRetirement: async (enabled: boolean) => {
      await admin.query(
        enabled
          ? `CREATE FUNCTION ${schema}.fixture_reject_checkpoint_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_checkpoint_retirement_failure'; END $$; CREATE TRIGGER fixture_reject_checkpoint_delete BEFORE DELETE ON ${schema}.context_compaction_checkpoints FOR EACH ROW EXECUTE FUNCTION ${schema}.fixture_reject_checkpoint_delete();`
          : `DROP TRIGGER fixture_reject_checkpoint_delete ON ${schema}.context_compaction_checkpoints; DROP FUNCTION ${schema}.fixture_reject_checkpoint_delete();`,
      );
    },
    corruptCompactionCheckpoint: async () => {
      await admin.query(
        `UPDATE ${schema}.context_compaction_checkpoints SET payload='corrupt'`,
      );
    },
    executionProgressCount: async () => Number((await admin.query(`SELECT count(*) n FROM ${schema}.run_execution_progress`)).rows[0].n),
    corruptExecutionProgress: async () => { await admin.query(`UPDATE ${schema}.run_execution_progress SET payload='corrupt'`); },
    compactionCheckpointCount: async () =>
      Number(
        (
          await admin.query(
            `SELECT count(*) n FROM ${schema}.context_compaction_checkpoints`,
          )
        ).rows[0].n,
      ),
    canonicalToolOutputCounts: async () => ({
      history: Number((await admin.query(`SELECT count(*) n FROM ${schema}.model_history_items WHERE item_type='tool_result' AND jsonb_typeof(item_json->'output')='object'`)).rows[0].n),
      events: Number((await admin.query(`SELECT count(*) n FROM ${schema}.run_events WHERE event_json->>'type'='tool.completed' AND jsonb_typeof(event_json->'data'->'output')='object'`)).rows[0].n),
    }),
    encodedToolResultCount: async () =>
      Number(
        (
          await admin.query(`SELECT count(*) n FROM ${schema}.tool_execution_receipts WHERE jsonb_typeof(state_json->'result'->'output')='object'`)
        ).rows[0].n,
      ),
    breakEncodedToolResult: async (): Promise<() => Promise<void>> => {
      throw new Error("encoded_tool_results_are_sqlite_only");
    },
    receiptStorageSummary: async () => {
      const full = (
        await admin.query(
          `SELECT count(*) n, coalesce(sum(octet_length(fingerprint)+octet_length(result_json::text)),0) bytes FROM ${schema}.idempotency_receipts`,
        )
      ).rows[0];
      const compact = (
        await admin.query(
          `SELECT count(*) n, coalesce(sum(octet_length(fingerprint)),0) bytes FROM ${schema}.run_output_receipts`,
        )
      ).rows[0];
      return {
        fullCount: Number(full.n),
        fullBytes: Number(full.bytes),
        compactCount: Number(compact.n),
        compactBytes: Number(compact.bytes),
      };
    },
    expireWorkItemLease: async (runId: string) => {
      await admin.query(
        `UPDATE ${schema}.work_items SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE run_id=$1 AND status='leased'`,
        [runId],
      );
    },
    accountingReport: (locator: { tenantId: string; runId: string }) =>
      readPostgresModelAccountingReport({
        connectionString,
        schema: schemaName,
        ...locator,
      }),
    makePendingWorkDue: async (runId: string) => {
      await admin.query(
        `UPDATE ${schema}.work_items SET available_at=clock_timestamp()-interval '1 millisecond' WHERE run_id=$1 AND status='pending'`,
        [runId],
      );
    },
    progress: async () =>
      Number(
        (
          await admin.query(
            `SELECT through_sequence FROM ${schema}.model_history_context_state`,
          )
        ).rows[0]?.through_sequence ?? 0,
      ),
    seed: async (items: readonly ModelHistoryItem[]) => {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        for (let offset = 0; offset < items.length; offset += 100) {
          await client.query(
            `INSERT INTO ${schema}.model_history_items
            (tenant_id, thread_id, sequence, item_id, run_id, segment_id, call_id, tool_kind, item_type, item_json, created_at)
            SELECT item->>'tenantId', item->>'threadId', (item->>'sequence')::bigint, item->>'itemId', item->>'runId', item->>'segmentId',
              item->>'callId', item->>'kind', item->>'type', item, (item->>'createdAt')::timestamptz
            FROM jsonb_array_elements($1::jsonb) AS item`,
            [JSON.stringify(items.slice(offset, offset + 100))],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
