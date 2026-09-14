import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import type { ModelHistoryItem } from "@crewon/domain";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import {
  PostgresModelHistoryContextStore,
  lockPostgresHistoryThread,
} from "./postgres-model-history-context.ts";
import { writePostgresModelHistory } from "./postgres-thread-writer.ts";
import { outputFixture } from "./run-output-store-conformance.test-support.ts";
import {
  locator,
  message,
  compaction,
  rollback,
  assertReplay,
  readWindow,
} from "./model-history-context.test-support.ts";
import { toolHistory } from "./model-history-append.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

test(
  "PostgreSQL references match canonical replay through compaction, tool pairs and repeated rollback",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await createFixture(context);
    const history: ModelHistoryItem[] = [];
    const append = async (...items: ModelHistoryItem[]) => {
      await fixture.append(items);
      history.push(...items);
      await assertReplay(fixture.store.modelHistoryContext, history);
    };
    await append(message(1), message(2, "assistant"), compaction(3, 2));
    await append(message(4, "user", "goal_steering"), message(5));
    await append(
      toolHistory(6, "call", "tool_call", "run-store-1"),
      toolHistory(7, "call", "tool_result", "run-store-1"),
    );
    await append(message(8, "assistant"), compaction(9, 7));
    await append(rollback(history, 1));
    assert.equal(
      (await fixture.store.modelHistoryContext.prepare(locator)).context
        ?.lastCompaction?.sequence,
      3,
    );
    await append(message(11), compaction(12, 3));
    await append(rollback(history, 2));
    await append(rollback(history, 3));
    await append(
      message(15),
      message(16, "assistant"),
      compaction(17, 16),
      message(18),
    );
    await fixture.store.close();
    await assertReplay((await fixture.open()).modelHistoryContext, history);
  },
);

test(
  "PostgreSQL resumes a 20,202-item context build and warm reads use bounded index searches",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await createFixture(context);
    const history: ModelHistoryItem[] = [];
    for (let sequence = 1; sequence <= 20_200; sequence += 1) {
      history.push(
        sequence === 1 || sequence === 20_200
          ? message(sequence, sequence === 1 ? "user" : "assistant")
          : toolHistory(
              sequence,
              `old-${Math.floor((sequence - 2) / 2)}`,
              sequence % 2 === 0 ? "tool_call" : "tool_result",
              "run-store-1",
            ),
      );
    }
    history.push(compaction(20_201, 20_200), message(20_202));
    await fixture.seed(history);
    assert.equal(
      (await fixture.store.modelHistoryContext.prepare(locator))
        .processedThroughSequence,
      100,
    );
    await fixture.store.close();
    const reopened = await fixture.open();
    assert.equal(
      (await reopened.modelHistoryContext.prepare(locator))
        .processedThroughSequence,
      200,
    );
    await assertReplay(reopened.modelHistoryContext, history);
    await fixture.admin.query(
      `ANALYZE ${fixture.schema}.model_history_items; ANALYZE ${fixture.schema}.model_history_context_refs`,
    );
    const reads: { sql: string; values: unknown[]; rows: number }[] = [];
    const observed = new Proxy(fixture.admin, {
      get(target, key) {
        if (key === "connect")
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, property) {
                if (property === "query")
                  return async (sql: string, values: unknown[] = []) => {
                    const result = await connection.query(sql, values);
                    if (sql.includes("model_history_items"))
                      reads.push({ sql, values, rows: result.rows.length });
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
    const state = await readWindow(
      new PostgresModelHistoryContextStore(observed, fixture.schema, () => {}),
    );
    assert.equal(state.items.length, 1);
    assert.ok(reads.length > 0 && reads.length <= 10);
    assert.ok(reads.every((read) => read.rows <= 1));
    for (const read of reads) {
      const plan = await fixture.admin.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${read.sql}`,
        read.values,
      );
      assert.ok(
        !JSON.stringify(plan.rows).includes('"Node Type":"Seq Scan"'),
        JSON.stringify(plan.rows),
      );
    }
    context.diagnostic(
      `20,202 canonical items: ${reads.length} bounded warm queries, at most one row each; real PostgreSQL plans contain no sequential scan`,
    );
  },
);

test(
  "PostgreSQL independent pools serialize backfill with canonical writes and fence stale readers",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await createFixture(context);
    const second = await fixture.open();
    const history = Array.from({ length: 350 }, (_, index) =>
      message(index + 1),
    );
    await fixture.seed(history);
    const progress = await Promise.all([
      fixture.store.modelHistoryContext.prepare(locator),
      second.modelHistoryContext.prepare(locator),
    ]);
    assert.deepEqual(
      progress
        .map((value) => value.processedThroughSequence)
        .sort((a, b) => a - b),
      [100, 200],
    );
    const writer = await fixture.admin.connect();
    try {
      await writer.query("BEGIN");
      await lockPostgresHistoryThread(writer, fixture.schema, locator);
      await writePostgresModelHistory(writer, fixture.schema, [message(351)]);
      const preparing = second.modelHistoryContext.prepare(locator);
      // Observe an actual blocked backend instead of inferring locking from a timeout.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const lock = await fixture.observe.query(
          `SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type='Lock' AND query LIKE $1`,
          [`SELECT 1 FROM ${fixture.schema}.threads%`],
        );
        if (lock.rowCount !== 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(
        waiting,
        "backfill must wait for the canonical writer's Thread lock",
      );
      await writer.query("COMMIT");
      assert.equal((await preparing).processedThroughSequence, 300);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
    history.push(message(351));
    await assertReplay(second.modelHistoryContext, history);
    const old = (await second.modelHistoryContext.prepare(locator)).context!;
    await fixture.append([message(352)]);
    await assert.rejects(
      second.modelHistoryContext.listItems(locator, old.checkpoint, 0, 100),
      /model_history_context_changed/,
    );
    await assertReplay(second.modelHistoryContext, [...history, message(352)]);
  },
);

test(
  "PostgreSQL history and checkpoint roll back together when a batched reference insert fails",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await createFixture(context);
    await fixture.append([message(1)]);
    const before = (await fixture.store.modelHistoryContext.prepare(locator))
      .context;
    await fixture.admin
      .query(`CREATE FUNCTION ${fixture.schema}.fail_context() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.sequence=151 THEN RAISE EXCEPTION 'injected_context_failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_context BEFORE INSERT ON ${fixture.schema}.model_history_context_refs
      FOR EACH ROW EXECUTE FUNCTION ${fixture.schema}.fail_context()`);
    const items = Array.from({ length: 200 }, (_, index) => message(index + 2));
    await assert.rejects(fixture.append(items), /injected_context_failure/);
    assert.equal(
      (await fixture.store.loadModelHistoryHead(locator))?.lastSequence,
      1,
    );
    assert.deepEqual(
      (await fixture.store.modelHistoryContext.prepare(locator)).context,
      before,
    );
    await fixture.admin.query(
      `DROP TRIGGER fail_context ON ${fixture.schema}.model_history_context_refs`,
    );
    await fixture.append(items);
    await assertReplay(fixture.store.modelHistoryContext, [
      message(1),
      ...items,
    ]);
  },
);

test(
  "PostgreSQL v5 migration is lazy and invalidates checkpoints on raw changes",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await createFixture(context);
    const history = [
      message(1),
      message(2, "assistant"),
      compaction(3, 2),
      message(4),
    ];
    await fixture.seed(history);
    const before = (
      await fixture.admin.query(
        `SELECT item_json FROM ${fixture.schema}.model_history_items ORDER BY sequence`,
      )
    ).rows;
    await fixture.store.close();
    await fixture.admin
      .query(`DROP TRIGGER model_history_context_invalidate ON ${fixture.schema}.model_history_items;
    DROP FUNCTION ${fixture.schema}.invalidate_model_history_context(); DROP TABLE ${fixture.schema}.model_history_context_refs;
    DROP TABLE ${fixture.schema}.model_history_context_state;
    UPDATE ${fixture.schema}.schema_migrations SET version=5 WHERE component='thread_authority'`);
    const reopened = await fixture.open();
    assert.equal(
      (
        await fixture.admin.query(
          `SELECT version FROM ${fixture.schema}.schema_migrations WHERE component='thread_authority'`,
        )
      ).rows[0]?.version,
      6,
    );
    assert.equal(
      (
        await fixture.admin.query(
          `SELECT COUNT(*)::int AS value FROM ${fixture.schema}.model_history_context_state`,
        )
      ).rows[0]?.value,
      0,
    );
    assert.deepEqual(
      (
        await fixture.admin.query(
          `SELECT item_json FROM ${fixture.schema}.model_history_items ORDER BY sequence`,
        )
      ).rows,
      before,
    );
    const old = (await reopened.modelHistoryContext.prepare(locator)).context!;
    await fixture.admin.query(
      `UPDATE ${fixture.schema}.model_history_items SET item_json=jsonb_set(item_json, '{content}', '"replacement"'::jsonb) WHERE sequence=4`,
    );
    await assert.rejects(
      reopened.modelHistoryContext.listItems(locator, old.checkpoint, 0, 100),
      /model_history_context_changed/,
    );
    const rebuilt = (await reopened.modelHistoryContext.prepare(locator))
      .context!;
    assert.notEqual(rebuilt.checkpoint.fingerprint, old.checkpoint.fingerprint);
    await fixture.admin.query(
      `UPDATE ${fixture.schema}.model_history_context_refs SET item_digest='broken' WHERE sequence=4`,
    );
    await assert.rejects(
      reopened.modelHistoryContext.listItems(
        locator,
        rebuilt.checkpoint,
        0,
        100,
      ),
      /model_history_context_invalid/,
    );
    await assert.rejects(
      reopened.modelHistoryContext.listItems(
        { ...locator, tenantId: "wrong-tenant" },
        rebuilt.checkpoint,
        0,
        100,
      ),
      /model_history_context_changed/,
    );
  },
);

async function createFixture(context: TestContext) {
  assert.ok(connectionString !== undefined);
  const schemaName = `crewon_context_${randomUUID().replaceAll("-", "_")}`;
  const schema = `"${schemaName}"`;
  const admin = new Pool({ connectionString, max: 2 });
  const observe = new Pool({ connectionString, max: 1 });
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
  const seeded = await outputFixture(context, open);
  const within = async (work: (client: PoolClient) => Promise<void>) => {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await work(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  context.after(async () => {
    for (const store of stores) await store.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await observe.end();
  });
  return {
    schema,
    admin,
    observe,
    open,
    store: seeded.store as PostgresDomainStore,
    append: (items: readonly ModelHistoryItem[]) =>
      within((client) => writePostgresModelHistory(client, schema, items)),
    seed: (items: readonly ModelHistoryItem[]) =>
      within(async (client) => {
        // Simulates data written before this index existed, without invoking its writer.
        for (let offset = 0; offset < items.length; offset += 100) {
          const batch = items.slice(offset, offset + 100);
          await client.query(
            `INSERT INTO ${schema}.model_history_items
          (tenant_id, thread_id, sequence, item_id, run_id, segment_id, call_id, tool_kind, item_type, item_json, created_at)
          SELECT item->>'tenantId', item->>'threadId', (item->>'sequence')::bigint, item->>'itemId', item->>'runId', item->>'segmentId',
            item->>'callId', item->>'kind', item->>'type', item, (item->>'createdAt')::timestamptz
          FROM jsonb_array_elements($1::jsonb) AS item`,
            [JSON.stringify(batch)],
          );
        }
      }),
  };
}
