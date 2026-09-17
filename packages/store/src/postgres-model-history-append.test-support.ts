import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { ModelHistoryItem } from "@crewon/domain";
import { Pool } from "pg";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { outputFixture } from "./run-output-store-conformance.test-support.ts";

export async function historyAppendFixture(context: TestContext) {
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  assert.ok(connectionString);
  const schemaName = `history_append_${randomUUID().replaceAll("-", "_")}`,
    schema = `"${schemaName}"`;
  const admin = new Pool({ connectionString, max: 2 });
  const readers = new Pool({ connectionString, max: 2 });
  const reads: {
    sql: string;
    values: unknown[];
    rows: number;
    body: boolean;
  }[] = [];
  let record = false;
  const observed = new Proxy(readers, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, property) {
              if (property === "query")
                return async (sql: string, values: unknown[] = []) => {
                  const result = await connection.query(sql, values);
                  if (
                    record &&
                    /^\s*SELECT/.test(sql) &&
                    sql.includes("model_history_items")
                  )
                    reads.push({
                      sql,
                      values,
                      rows: result.rows.length,
                      body: result.rows.some((row) =>
                        Object.hasOwn(row, "item_json"),
                      ),
                    });
                  return result;
                };
              const value = Reflect.get(connection, property);
              return typeof value === "function"
                ? value.bind(connection)
                : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const stores: PostgresDomainStore[] = [];
  const open = async (observe = false) => {
    const store = await PostgresDomainStore.open(
      observe
        ? { pool: observed, schema: schemaName }
        : { connectionString, schema: schemaName, maxPoolSize: 2 },
    );
    stores.push(store);
    return store;
  };
  context.after(async () => {
    for (const store of stores) await store.close();
    await readers.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  const fixture = await outputFixture(context, () => open(true));
  const lease = fixture.input([], 2, "unused").lease;
  let revision = 2;
  const input = (
    head: number,
    items: readonly ModelHistoryItem[],
    key = `append-${head}`,
  ) => ({
    lease,
    history: { expectedLastSequence: head, items },
    commit: {
      tenantId: "tenant-1",
      expectedRevision: revision,
      idempotency: {
        scope: "history-append-test",
        key,
        requestFingerprint: JSON.stringify(items),
      },
      events: [
        {
          ...fixture.input([head + 1], revision, key).entries[0]!.event,
          eventId: key,
          sequence: revision + 1,
        },
      ],
      outbox: [],
      workItems: [],
    },
  });
  return {
    ...fixture,
    schema,
    schemaName,
    admin,
    open,
    reads,
    observe: (enabled: boolean) => {
      record = enabled;
      reads.length = 0;
    },
    input,
    append: async (
      head: number,
      items: readonly ModelHistoryItem[],
      store = fixture.store,
    ) => {
      const result = await store.commitLeasedRun(input(head, items));
      revision = result.state.revision;
      return result;
    },
    state: async () =>
      (
        await admin.query(
          `SELECT last_sequence::int, pending_tool_call_count::int FROM ${schema}.model_history_append_state ORDER BY tenant_id,thread_id`,
        )
      ).rows,
    seed: async (items: readonly ModelHistoryItem[]) => {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        for (let offset = 0; offset < items.length; offset += 100)
          await client.query(
            `INSERT INTO ${schema}.model_history_items
          (tenant_id,thread_id,sequence,item_id,run_id,segment_id,call_id,tool_kind,item_type,item_json,created_at)
          SELECT item->>'tenantId',item->>'threadId',(item->>'sequence')::bigint,item->>'itemId',item->>'runId',item->>'segmentId',
            item->>'callId',item->>'kind',item->>'type',item,(item->>'createdAt')::timestamptz FROM jsonb_array_elements($1::jsonb) AS item`,
            [JSON.stringify(items.slice(offset, offset + 100))],
          );
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
