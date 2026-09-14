import { sqliteActiveRunReadSql } from "./sqlite-active-run-read.ts";
import { postgresActiveRunReadSql } from "./postgres-active-run-read.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import type { CommitRunInput, DomainStore } from "@crewon/application";
import type { RunLifecycleEvent } from "@crewon/domain";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { InMemoryRunMap } from "./in-memory-run-map.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  createRunningCommitFixture,
  runningStateFixture,
} from "./run-store-conformance.test-support.ts";
import { MAX_ACTIVE_RUN_SNAPSHOT_BYTES } from "./active-run-read.ts";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import { POSTGRES_RUN_SCHEMA_VERSION } from "./postgres-run-schema.ts";

const locator = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  threadId: "thread-1",
};
const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
type Backend = "SQLite" | "PostgreSQL" | "InMemory";

function commit(id: string, terminal = false): CommitRunInput {
  const base = createRunningCommitFixture();
  const events: RunLifecycleEvent[] = base.events.map((event) => ({
    ...event,
    identity: { runId: id },
    eventId: `${id}:${event.sequence}`,
  }));
  if (terminal) events.push(completed(id));
  return {
    ...base,
    events,
    outbox: [],
    workItems: [],
    idempotency: { scope: "active-read-test", key: id, requestFingerprint: id },
  };
}
function completed(runId: string): RunLifecycleEvent {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId },
    eventId: `${runId}:completed`,
    sequence: 3,
    occurredAt: "2026-08-08T00:02:00Z",
    type: "run.completed",
    data: { outputRef: null },
  };
}
async function open(context: TestContext, backend: Backend) {
  let store: DomainStore;
  let database: DatabaseSync | undefined;
  let pool: Pool | undefined;
  let path: string | undefined;
  const schema = `active_${randomUUID().replaceAll("-", "_")}`;
  if (backend === "SQLite") {
    const directory = mkdtempSync(join(tmpdir(), "crewon-active-run-"));
    path = join(directory, "store.db");
    store = new SqliteRunStore(path);
    database = new DatabaseSync(path);
    context.after(async () => {
      database!.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    });
  } else if (backend === "PostgreSQL") {
    assert.ok(connectionString);
    pool = new Pool({ connectionString });
    store = await PostgresDomainStore.open({ connectionString, schema });
    context.after(async () => {
      await store.close();
      try {
        await pool!.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool!.end();
      }
    });
  } else {
    store = new InMemoryRunStore();
    context.after(() => store.close());
  }
  await seedThread(store);
  return { store, database, pool, schema, path };
}

for (const backend of ["SQLite", "PostgreSQL", "InMemory"] as const) {
  const options = {
    skip: backend === "PostgreSQL" && connectionString === undefined,
  };
  test(
    `${backend} locates an old active Run beyond 1,505 completed Runs and retires its index on completion`,
    options,
    async (context) => {
      const f = await open(context, backend);
      const active = await f.store.commitRun(commit("active-old"));
      for (let i = 0; i < 1505; i++)
        await f.store.commitRun(commit(`completed-${i}`, true));
      const found = await f.store.loadActiveRunInThread!(locator);
      assert.deepEqual(found, active.state);
      (found as { runId: string }).runId = "changed-return-value";
      assert.equal(
        (await f.store.loadActiveRunInThread!(locator))?.runId,
        "active-old",
      );
      for (const other of [
        { ...locator, spaceId: "other" },
        { ...locator, tenantId: "other" },
        { ...locator, threadId: "other" },
      ])
        assert.equal(await f.store.loadActiveRunInThread!(other), null);
      if (f.database) {
        const plan = f.database
          .prepare(`EXPLAIN QUERY PLAN ${sqliteActiveRunReadSql()}`)
          .all(locator.tenantId, locator.spaceId, locator.threadId);
        assert.match(JSON.stringify(plan), /run_snapshots_live_scope_idx/);
        assert.doesNotMatch(
          JSON.stringify(plan),
          /SCAN run_snapshots|TEMP B-TREE/,
        );
      }
      if (f.pool) {
        await f.pool.query(`ANALYZE "${f.schema}".run_snapshots`);
        const plan = await f.pool.query(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${postgresActiveRunReadSql(`"${f.schema}"`)}`,
          [locator.tenantId, locator.spaceId, locator.threadId],
        );
        assert.match(JSON.stringify(plan.rows), /run_snapshots_live_scope_idx/);
        assert.doesNotMatch(JSON.stringify(plan.rows), /Seq Scan/);
      }
      await f.store.commitRun({
        tenantId: locator.tenantId,
        idempotency: {
          scope: "active-read-test",
          key: "finish",
          requestFingerprint: "finish",
        },
        expectedRevision: 2,
        events: [completed("active-old")],
        outbox: [],
        workItems: [],
      });
      assert.equal(await f.store.loadActiveRunInThread!(locator), null);
    },
  );
  test(
    `${backend} rejects multiple live Runs instead of choosing an arbitrary one`,
    options,
    async (context) => {
      const { store } = await open(context, backend);
      await store.commitRun(commit("one"));
      await store.commitRun(commit("two"));
      await assert.rejects(
        store.loadActiveRunInThread!(locator),
        /thread_active_run_invariant/,
      );
      await assert.rejects(
        store.loadActiveRunInThread!({ ...locator, spaceId: " " }),
        /space_id_invalid/,
      );
    },
  );
  if (backend !== "InMemory")
    test(
      `${backend} migrates existing Run state and suppresses oversized snapshots before decoding`,
      options,
      async (context) => {
        const f = await open(context, backend);
        await f.store.commitRun(commit("active"));
        await f.store.close();
        let migrated: DomainStore;
        if (f.database) {
          f.database.exec(
            "DROP INDEX run_snapshots_live_scope_idx; ALTER TABLE run_snapshots DROP COLUMN active_read; PRAGMA user_version=29",
          );
          migrated = new SqliteRunStore(f.path!);
          assert.equal(
            f.database.prepare("PRAGMA user_version").get()?.user_version,
            SQLITE_SCHEMA_VERSION,
          );
        } else {
          await f.pool!.query(
            `DROP INDEX "${f.schema}".run_snapshots_live_scope_idx; ALTER TABLE "${f.schema}".run_snapshots DROP COLUMN active_read; UPDATE "${f.schema}".schema_migrations SET version=3 WHERE component='run_authority'`,
          );
          migrated = await PostgresDomainStore.open({
            connectionString: connectionString!,
            schema: f.schema,
          });
          assert.equal(
            (
              await f.pool!.query(
                `SELECT version FROM "${f.schema}".schema_migrations WHERE component='run_authority'`,
              )
            ).rows[0].version,
            POSTGRES_RUN_SCHEMA_VERSION,
          );
        }
        try {
          assert.equal(
            (await migrated.loadActiveRunInThread!(locator))?.runId,
            "active",
          );
          const original = await migrated.loadActiveRunInThread!(locator);
          const padding = "x".repeat(MAX_ACTIVE_RUN_SNAPSHOT_BYTES);
          if (f.database)
            f.database
              .prepare(
                "UPDATE run_snapshots SET state_json=json_set(state_json,'$.testPadding',?) WHERE run_id='active'",
              )
              .run(padding);
          else
            await f.pool!.query(
              `UPDATE "${f.schema}".run_snapshots SET state_json=jsonb_set(state_json,'{testPadding}',to_jsonb($1::text)) WHERE run_id='active'`,
              [padding],
            );
          await assert.rejects(
            migrated.loadActiveRunInThread!(locator),
            /thread_active_run_too_large/,
          );
          for (const corrupt of [
            { ...original, status: null },
            { ...original, threadId: "wrong-thread" },
          ]) {
            if (f.database)
              f.database
                .prepare(
                  "UPDATE run_snapshots SET state_json=? WHERE run_id='active'",
                )
                .run(JSON.stringify(corrupt));
            else
              await f.pool!.query(
                `UPDATE "${f.schema}".run_snapshots SET state_json=$1::jsonb WHERE run_id='active'`,
                [JSON.stringify(corrupt)],
              );
            await assert.rejects(
              migrated.loadActiveRunInThread!(locator),
              /stored_run_state_invalid|thread_active_run_identity_invalid/,
            );
          }
        } finally {
          await migrated.close();
        }
      },
    );
}

test(
  "PostgreSQL derived activity preserves HOT updates for changing output snapshots",
  { skip: connectionString === undefined },
  async (context) => {
    const f = await open(context, "PostgreSQL");
    await f.store.commitRun(commit("hot-run"));
    const client = await f.pool!.connect();
    const table = `"${f.schema}".run_snapshots`;
    const readStats = async () =>
      (
        await client.query<{ updates: string; hot: string }>(
          `SELECT pg_stat_get_xact_tuples_updated($1::regclass) AS updates, pg_stat_get_xact_tuples_hot_updated($1::regclass) AS hot`,
          [table],
        )
      ).rows[0]!;
    const measure = async () => {
      await client.query("BEGIN");
      const before = await readStats();
      for (let count = 0; count < 100; count++)
        await client.query(
          `UPDATE ${table} SET state_json=jsonb_set(state_json,'{testCounter}',to_jsonb($1::int)) WHERE run_id='hot-run'`,
          [count],
        );
      const stats = await readStats();
      await client.query("COMMIT");
      return {
        updates: Number(stats.updates) - Number(before.updates),
        hot: Number(stats.hot) - Number(before.hot),
      };
    };
    try {
      const generated = await measure();
      assert.equal(generated.updates, 100);
      assert.ok(
        generated.hot > 0,
        "activity value is unchanged; output updates should remain HOT-eligible",
      );
      await client.query(
        `CREATE INDEX raw_json_activity_test ON ${table}(tenant_id, space_id, run_id) WHERE COALESCE(state_json->>'status','') NOT IN ('completed','failed','canceled')`,
      );
      const rawJson = await measure();
      assert.equal(rawJson.updates, 100);
      assert.equal(rawJson.hot, 0);
      context.diagnostic(JSON.stringify({ generated, rawJson }));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);

test("InMemory Run index uses only live IDs and follows replacement, deletion and clear", () => {
  const runs = new InMemoryRunMap();
  for (let i = 0; i < 10_000; i++)
    runs.set(String(i), {
      ...runningStateFixture(),
      runId: String(i),
      status: "completed",
    });
  runs.set("active", { ...runningStateFixture(), runId: "active" });
  runs.values = () => {
    throw new Error("must_not_scan_history");
  };
  assert.equal(runs.activeInThread(locator)[0]?.runId, "active");
  runs.set("active", { ...runs.get("active")!, status: "completed" });
  assert.deepEqual(runs.activeInThread(locator), []);
  runs.set("active", { ...runningStateFixture(), runId: "active" });
  runs.delete("active");
  assert.deepEqual(runs.activeInThread(locator), []);
  runs.set("active", { ...runningStateFixture(), runId: "active" });
  runs.clear();
  assert.deepEqual(runs.activeInThread(locator), []);
});
