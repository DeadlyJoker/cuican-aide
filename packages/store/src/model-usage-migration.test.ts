import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import assert from "node:assert/strict";
import { POSTGRES_EXECUTION_SCHEMA_VERSION } from "./postgres-execution-schema.ts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Pool } from "pg";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";

test("SQLite v28 adds the usage ledger without copying or changing legacy Run events", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-usage-migration-"));
  context.after(() => rmSync(directory, { recursive: true }));
  const path = join(directory, "runtime.sqlite");
  const store = new SqliteRunStore(path);
  const locator = { tenantId: "tenant-1", runId: "run-store-1" };
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  const before = await store.listRunEvents(locator, 0, 100);
  await store.close();
  const database = new DatabaseSync(path);
  database.exec(
    "DROP TABLE model_usage_call_aliases; DROP TABLE model_usage_observations; PRAGMA user_version=28;",
  );
  database.close();
  const reopened = new SqliteRunStore(path);
  try {
    assert.deepEqual(
      await reopened.listModelUsage({ ...locator, afterOrder: 0, limit: 128 }),
      [],
    );
    assert.deepEqual(await reopened.listRunEvents(locator, 0, 100), before);
  } finally {
    await reopened.close();
  }
  const migrated = new DatabaseSync(path);
  try {
    assert.equal(
      migrated.prepare("PRAGMA user_version").get()?.user_version,
      SQLITE_SCHEMA_VERSION,
    );
    assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    const query = migrated
      .prepare(
        "EXPLAIN QUERY PLAN SELECT usage_order FROM model_usage_observations WHERE tenant_id=? AND run_id=? AND usage_order>? ORDER BY usage_order LIMIT 128",
      )
      .all(locator.tenantId, locator.runId, 0);
    assert.match(JSON.stringify(query), /model_usage_run_order/);
  } finally {
    migrated.close();
  }
});

test(
  "PostgreSQL execution v5 adds one ledger under concurrent opens without backfilling old usage",
  { skip: process.env.CREWON_TEST_POSTGRES_URL === undefined },
  async (context) => {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
    const schema = `crewon_usage_migration_${randomUUID().replaceAll("-", "_")}`;
    const admin = new Pool({ connectionString, max: 1 });
    const stores: PostgresDomainStore[] = [];
    context.after(async () => {
      for (const store of stores) await store.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    const original = await PostgresDomainStore.open({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
    stores.push(original);
    await seedThread(original);
    await original.commitRun(createRunningCommitFixture());
    const locator = { tenantId: "tenant-1", runId: "run-store-1" };
    const before = await original.listRunEvents(locator, 0, 100);
    await original.close();
    await admin.query(
      `DROP TABLE "${schema}".model_usage_call_aliases; DROP TABLE "${schema}".model_usage_observations; UPDATE "${schema}".schema_migrations SET version=5 WHERE component='execution_authority'`,
    );
    const reopened = await Promise.all([
      PostgresDomainStore.open({ connectionString, schema, maxPoolSize: 2 }),
      PostgresDomainStore.open({ connectionString, schema, maxPoolSize: 2 }),
    ]);
    stores.push(...reopened);
    for (const store of reopened) {
      assert.deepEqual(
        await store.listModelUsage({ ...locator, afterOrder: 0, limit: 128 }),
        [],
      );
      assert.deepEqual(await store.listRunEvents(locator, 0, 100), before);
    }
    assert.equal(
      (
        await admin.query(
          `SELECT version FROM "${schema}".schema_migrations WHERE component='execution_authority'`,
        )
      ).rows[0].version,
      POSTGRES_EXECUTION_SCHEMA_VERSION,
    );
  },
);
