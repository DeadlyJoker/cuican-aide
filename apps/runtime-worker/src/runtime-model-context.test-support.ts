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
      accountingReport: (locator: { tenantId: string; runId: string }) => readSqliteModelAccountingReport({ databasePath: path, ...locator }),
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
    accountingReport: (locator: { tenantId: string; runId: string }) => readPostgresModelAccountingReport({ connectionString, schema: schemaName, ...locator }),
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
