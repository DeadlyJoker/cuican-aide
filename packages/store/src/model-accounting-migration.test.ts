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
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import { POSTGRES_EXECUTION_SCHEMA_VERSION } from "./postgres-execution-schema.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";
import { accountingCallIdentity } from "./model-accounting-index.ts";

const locator = { tenantId: "tenant-1", runId: "run-store-1" };
const historical = [
  JSON.stringify({
    observation: { callId: "valid-call" },
    privateLegacyData: "preserved",
  }),
  JSON.stringify({
    observation: {},
    privateLegacyData: "without-call-identity",
  }),
  JSON.stringify({ observation: { callId: "x".repeat(16000) } }),
];

test("SQLite v32 adds only the bounded call index and preserves legacy ledger bytes and canonical events", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "crewon-accounting-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "store.sqlite"),
    store = new SqliteRunStore(file);
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  const events = await store.listRunEvents(locator, 0, 100);
  await store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec("DROP INDEX model_usage_call_identity; PRAGMA user_version=32");
    for (const [i, value] of historical.entries())
      db.prepare(
        "INSERT INTO model_usage_observations(usage_key,tenant_id,run_id,record_json) VALUES(?,?,?,?)",
      ).run(String(i), locator.tenantId, locator.runId, value);
    const reopened = new SqliteRunStore(file);
    try {
      assert.deepEqual(await reopened.listRunEvents(locator, 0, 100), events);
    } finally {
      await reopened.close();
    }
    assert.equal(
      db.prepare("PRAGMA user_version").get()!.user_version,
      SQLITE_SCHEMA_VERSION,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT record_json FROM model_usage_observations ORDER BY usage_order",
        )
        .all()
        .map((r) => r.record_json),
      historical,
    );
    const candidates = db
      .prepare(
        `SELECT usage_order FROM model_usage_observations INDEXED BY model_usage_call_identity WHERE ${accountingCallIdentity(false)} IS NOT NULL`,
      )
      .all();
    assert.deepEqual(
      candidates.map((r) => r.usage_order),
      [1],
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test(
  "PostgreSQL execution v7 concurrent migration preserves observations and does not index oversized or absent call identities",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!,
      schemaName = `crewon_account_mig_${randomUUID().replaceAll("-", "_")}`,
      schema = `"${schemaName}"`;
    const admin = new Pool({ connectionString, max: 1 }),
      stores: PostgresDomainStore[] = [];
    t.after(async () => {
      for (const store of stores) await store.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const original = await PostgresDomainStore.open({
      connectionString,
      schema: schemaName,
      maxPoolSize: 2,
    });
    stores.push(original);
    await seedThread(original);
    await original.commitRun(createRunningCommitFixture());
    const events = await original.listRunEvents(locator, 0, 100);
    await original.close();
    await admin.query(
      `DROP INDEX ${schema}.model_usage_call_identity; UPDATE ${schema}.schema_migrations SET version=7 WHERE component='execution_authority'`,
    );
    for (const [i, value] of historical.entries())
      await admin.query(
        `INSERT INTO ${schema}.model_usage_observations(usage_key,tenant_id,run_id,record_json) VALUES($1,$2,$3,$4)`,
        [String(i), locator.tenantId, locator.runId, value],
      );
    const before = (
      await admin.query(
        `SELECT record_json FROM ${schema}.model_usage_observations ORDER BY usage_order`,
      )
    ).rows;
    const reopened = await Promise.all(
      Array.from({ length: 2 }, () =>
        PostgresDomainStore.open({
          connectionString,
          schema: schemaName,
          maxPoolSize: 2,
        }),
      ),
    );
    stores.push(...reopened);
    for (const store of reopened)
      assert.deepEqual(await store.listRunEvents(locator, 0, 100), events);
    assert.deepEqual(
      (
        await admin.query(
          `SELECT record_json FROM ${schema}.model_usage_observations ORDER BY usage_order`,
        )
      ).rows,
      before,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT version FROM ${schema}.schema_migrations WHERE component='execution_authority'`,
        )
      ).rows[0].version,
      POSTGRES_EXECUTION_SCHEMA_VERSION,
    );
    assert.deepEqual(
      (
        await admin.query(
          `SELECT usage_order FROM ${schema}.model_usage_observations WHERE ${accountingCallIdentity(true)} IS NOT NULL`,
        )
      ).rows.map((r) => Number(r.usage_order)),
      [1],
    );
  },
);
