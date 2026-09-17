import assert from "node:assert/strict";
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
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import { POSTGRES_EXECUTION_SCHEMA_VERSION } from "./postgres-execution-schema.ts";

test("SQLite 38 migrates execution progress without changing existing canonical records", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "crewon-progress-migration-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "store.sqlite");
  const original = new SqliteRunStore(path);
  await seedThread(original);
  await original.commitRun(createRunningCommitFixture());
  const locator = { tenantId: "tenant-1", runId: "run-store-1" };
  const before = await original.listRunEvents(locator, 0, 100);
  await original.close();
  const database = new DatabaseSync(path);
  database.exec(
    "DROP TRIGGER retire_terminal_run_execution_progress; DROP TABLE run_execution_progress; PRAGMA user_version=38;",
  );
  database.close();
  const migrated = new SqliteRunStore(path);
  assert.deepEqual(await migrated.listRunEvents(locator, 0, 100), before);
  await migrated.close();
  const check = new DatabaseSync(path);
  try {
    assert.equal(
      check.prepare("PRAGMA user_version").get()!.user_version,
      SQLITE_SCHEMA_VERSION,
    );
    assert.deepEqual(check.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      check.prepare("SELECT count(*) n FROM run_execution_progress").get()!.n,
      0,
    );
    assert.equal(
      check
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='retire_terminal_run_execution_progress'",
        )
        .get()!.n,
      1,
    );
    const plan = check
      .prepare(
        "EXPLAIN QUERY PLAN SELECT through_sequence FROM run_execution_progress WHERE tenant_id=? AND run_id=?",
      )
      .all("tenant-1", "run-store-1");
    assert.match(JSON.stringify(plan), /SEARCH.*INDEX/);
    check.exec("DROP TABLE run_execution_progress");
  } finally {
    check.close();
  }
  assert.throws(() => new SqliteRunStore(path));
});

test(
  "PostgreSQL execution 10 concurrently migrates execution progress without copying Run events",
  { skip: process.env.CREWON_TEST_POSTGRES_URL === undefined },
  async (context) => {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
    const schema = `crewon_progress_migration_${randomUUID().replaceAll("-", "_")}`;
    const admin = new Pool({ connectionString, max: 1 });
    const stores: PostgresDomainStore[] = [];
    context.after(async () => {
      for (const store of stores) await store.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
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
      `DROP TRIGGER retire_terminal_run_execution_progress ON "${schema}".run_snapshots;DROP FUNCTION "${schema}".retire_terminal_run_execution_progress();DROP TABLE "${schema}".run_execution_progress;UPDATE "${schema}".schema_migrations SET version=10 WHERE component='execution_authority'`,
    );
    const opened = await Promise.all([
      PostgresDomainStore.open({ connectionString, schema, maxPoolSize: 2 }),
      PostgresDomainStore.open({ connectionString, schema, maxPoolSize: 2 }),
    ]);
    stores.push(...opened);
    for (const store of opened)
      assert.deepEqual(await store.listRunEvents(locator, 0, 100), before);
    assert.equal(
      (
        await admin.query(
          `SELECT version FROM "${schema}".schema_migrations WHERE component='execution_authority'`,
        )
      ).rows[0].version,
      POSTGRES_EXECUTION_SCHEMA_VERSION,
    );
    assert.equal(
      Number(
        (
          await admin.query(
            `SELECT count(*) n FROM "${schema}".run_execution_progress`,
          )
        ).rows[0].n,
      ),
      0,
    );
    for (const store of opened) await store.close();
    await admin.query(`DROP TABLE "${schema}".run_execution_progress`);
    await assert.rejects(
      PostgresDomainStore.open({ connectionString, schema, maxPoolSize: 2 }),
    );
  },
);
