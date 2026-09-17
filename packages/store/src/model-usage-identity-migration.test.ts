import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import type { DomainStore } from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import { POSTGRES_EXECUTION_SCHEMA_VERSION } from "./postgres-execution-schema.ts";
import {
  ManualLeaseClock,
  createRunningCommitFixture,
} from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { modelUsageInput } from "./model-usage-store.test-support.ts";
import { modelCallInput } from "./model-call-store.test-support.ts";
import { modelUsageIdentityQuery } from "./model-usage-identity.ts";
import { modelUsageKey } from "./model-usage-store-support.ts";

async function seed(store: DomainStore) {
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  const claim = await store.claimNextWorkItem({
    ownerId: "identity-test",
    leaseId: "identity-lease",
    leaseDurationMs: 30_000,
  });
  assert(claim);
  const input = modelUsageInput(claim, "model-step-1", "usage-attempt");
  await store.beginRunAttempt({
    tenantId: input.record.tenantId,
    runId: input.record.runId,
    lease: input.lease,
    stepId: input.record.stepId,
    attemptId: input.record.attemptId,
    kind: "model",
    startedAt: "2026-08-08T00:01:01Z",
  });
  return {
    ...input,
    record: {
      ...input.record,
      observation: { ...input.record.observation, callId: "legacy-call" },
    },
  };
}

async function sqlite(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-usage-identity-")),
    filename = join(directory, "runtime.sqlite");
  const clock = new ManualLeaseClock(),
    stores: SqliteRunStore[] = [];
  const open = () => {
    const store = new SqliteRunStore(filename, { clock });
    stores.push(store);
    return store;
  };
  const store = open(),
    input = await seed(store),
    database = new DatabaseSync(filename);
  t.after(async () => {
    database.close();
    for (const store of stores) await store.close();
    rmSync(directory, { recursive: true });
  });
  return { open, store, input, database };
}

test("SQLite v36 preserves old usage and history, adds no aliases on open and lazily binds legacy response rows", async (t) => {
  const f = await sqlite(t);
  await f.store.recordModelUsage(f.input);
  const before = f.database
    .prepare("SELECT * FROM model_usage_observations")
    .all();
  const history = await f.store.listRunEvents(f.input.record, 0, 100);
  await f.store.close();
  f.database.exec(
    "DROP TABLE model_usage_call_aliases; PRAGMA user_version=36",
  );
  const store = f.open();
  assert.equal(
    f.database.prepare("PRAGMA user_version").get()!.user_version,
    SQLITE_SCHEMA_VERSION,
  );
  assert.deepEqual(
    f.database.prepare("SELECT * FROM model_usage_observations").all(),
    before,
  );
  assert.equal(
    f.database.prepare("SELECT count(*) n FROM model_usage_call_aliases").get()!
      .n,
    0,
  );
  const weak = {
    ...f.input,
    record: {
      ...f.input.record,
      observation: { ...f.input.record.observation, providerResponseId: null },
    },
  };
  for (let n = 0; n < 1000; n++)
    assert.equal(await store.recordModelUsage(weak), "replayed");
  assert.equal(
    f.database.prepare("SELECT count(*) n FROM model_usage_call_aliases").get()!
      .n,
    1,
  );
  assert.deepEqual(
    f.database.prepare("SELECT * FROM model_usage_observations").all(),
    before,
  );
  assert.deepEqual(await store.listRunEvents(f.input.record, 0, 100), history);
  await store.close();
  assert.equal(await f.open().recordModelUsage(weak), "replayed");
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("SQLite alias write failure rolls back response promotion and call completion together", async (t) => {
  const f = await sqlite(t);
  const intent = modelCallInput(f.input, "legacy-call");
  await f.store.recordModelCall(intent);
  await f.store.recordModelUsage({
    ...f.input,
    record: {
      ...f.input.record,
      observation: { ...f.input.record.observation, providerResponseId: null },
    },
  });
  const usage = f.database
    .prepare("SELECT * FROM model_usage_observations")
    .all();
  const calls = f.database
    .prepare("SELECT * FROM model_call_observations")
    .all();
  f.database.exec(
    "CREATE TRIGGER fail_usage_alias BEFORE INSERT ON model_usage_call_aliases BEGIN SELECT RAISE(ABORT,'alias_commit_failed'); END",
  );
  const final = {
    ...intent,
    record: {
      ...intent.record,
      observation: {
        ...intent.record.observation,
        outcome: "completed" as const,
        finishedAt: "2026-08-08T00:01:03Z",
        providerResponseId: f.input.record.observation.providerResponseId,
        usageEventObserved: true,
      },
    },
  };
  await assert.rejects(f.store.recordModelCall(final));
  assert.deepEqual(
    f.database.prepare("SELECT * FROM model_usage_observations").all(),
    usage,
  );
  assert.deepEqual(
    f.database.prepare("SELECT * FROM model_call_observations").all(),
    calls,
  );
  f.database.exec("DROP TRIGGER fail_usage_alias");
  assert.equal(await f.store.recordModelCall(final), "enriched");
  assert.equal(await f.store.recordModelUsage(f.input), "replayed");
  assert.equal(
    f.database.prepare("SELECT count(*) n FROM model_usage_observations").get()!
      .n,
    1,
  );
});

test("SQLite legacy lookup seeks indexes, bounds corrupt evidence and never auto-merges ambiguous old rows", async (t) => {
  const f = await sqlite(t);
  await f.store.recordModelUsage(f.input);
  await f.store.close();
  f.database.exec(`DROP TABLE model_usage_call_aliases; PRAGMA user_version=36;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
    INSERT INTO model_usage_observations(usage_key,tenant_id,run_id,record_json)
    SELECT 'noise-'||x,tenant_id,run_id,json_set(record_json,'$.observation.callId','noise-'||x) FROM n JOIN model_usage_observations ON usage_order=1`);
  const store = f.open(),
    q = modelUsageIdentityQuery(false, "", f.input.record);
  const plan = JSON.stringify(
    f.database.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.values),
  );
  assert.match(plan, /SEARCH.*model_usage_call_identity/);
  assert.equal(f.database.prepare(q.sql).all(...q.values).length, 1);
  assert.equal(await store.recordModelUsage(f.input), "replayed");
  const duplicate = {
    ...f.input.record,
    observation: {
      ...f.input.record.observation,
      providerResponseId: "legacy-second-response",
    },
  };
  f.database.exec("DELETE FROM model_usage_call_aliases");
  f.database
    .prepare(
      "INSERT INTO model_usage_observations(usage_key,tenant_id,run_id,record_json) VALUES (?,?,?,?)",
    )
    .run(
      modelUsageKey(duplicate),
      duplicate.tenantId,
      duplicate.runId,
      JSON.stringify(duplicate),
    );
  assert.equal(f.database.prepare(q.sql).all(...q.values).length, 2);
  await assert.rejects(store.recordModelUsage(f.input), {
    code: "model_usage_conflict",
  });
  assert.equal(f.database.prepare(q.sql).all(...q.values).length, 2);
  f.database
    .prepare("DELETE FROM model_usage_observations WHERE usage_key=?")
    .run(modelUsageKey(duplicate));
  f.database.exec(
    "DELETE FROM model_usage_call_aliases; UPDATE model_usage_observations SET record_json=json_set(record_json,'$.oversized',printf('%.*c',100000,'x')) WHERE usage_order=1",
  );
  assert.equal(
    f.database.prepare(q.sql).all(...q.values)[0]!.record_json,
    null,
  );
  await assert.rejects(store.recordModelUsage(f.input));
});

test("current and newer SQLite schemas cannot silently recreate missing usage aliases", async (t) => {
  const f = await sqlite(t);
  await f.store.close();
  f.database.exec("DROP TABLE model_usage_call_aliases");
  assert.throws(f.open);
  f.database.exec(`PRAGMA user_version=${SQLITE_SCHEMA_VERSION + 1}`);
  assert.throws(f.open, { code: "sqlite_schema_too_new" });
  assert.equal(
    f.database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name='model_usage_call_aliases'",
      )
      .get(),
    undefined,
  );
});

test(
  "PostgreSQL v8 aliases migrate lazily, promote atomically and reject missing current authority",
  { skip: process.env.CREWON_TEST_POSTGRES_URL === undefined },
  async (t) => {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!,
      schema = `usage_identity_${randomUUID().replaceAll("-", "_")}`;
    const admin = new Pool({ connectionString, max: 1 }),
      stores: PostgresDomainStore[] = [];
    const open = async () => {
      const store = await PostgresDomainStore.open({
        connectionString,
        schema,
        maxPoolSize: 2,
      });
      stores.push(store);
      return store;
    };
    t.after(async () => {
      for (const store of stores) await store.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    const original = await open(),
      input = await seed(original);
    await original.recordModelUsage(input);
    const before = (
      await admin.query(`SELECT * FROM "${schema}".model_usage_observations`)
    ).rows;
    await original.close();
    await admin.query(
      `DROP TABLE "${schema}".model_usage_call_aliases; UPDATE "${schema}".schema_migrations SET version=8 WHERE component='execution_authority'`,
    );
    const [a, b] = await Promise.all([open(), open()]);
    assert.equal(
      (
        await admin.query(
          `SELECT version FROM "${schema}".schema_migrations WHERE component='execution_authority'`,
        )
      ).rows[0].version,
      POSTGRES_EXECUTION_SCHEMA_VERSION,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*) n FROM "${schema}".model_usage_call_aliases`,
        )
      ).rows[0].n,
      "0",
    );
    const weak = {
      ...input,
      record: {
        ...input.record,
        observation: { ...input.record.observation, providerResponseId: null },
      },
    };
    assert.deepEqual(
      await Promise.all([a!.recordModelUsage(weak), b!.recordModelUsage(weak)]),
      ["replayed", "replayed"],
    );
    assert.deepEqual(
      (await admin.query(`SELECT * FROM "${schema}".model_usage_observations`))
        .rows,
      before,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*) n FROM "${schema}".model_usage_call_aliases`,
        )
      ).rows[0].n,
      "1",
    );
    const weakNew = {
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          callId: "atomic-call",
          providerResponseId: null,
        },
      },
    };
    const intent = modelCallInput(weakNew, "atomic-call");
    await a!.recordModelCall(intent);
    await a!.recordModelUsage(weakNew);
    const usageBefore = (
      await admin.query(
        `SELECT * FROM "${schema}".model_usage_observations ORDER BY usage_order`,
      )
    ).rows;
    const callsBefore = (
      await admin.query(
        `SELECT * FROM "${schema}".model_call_observations ORDER BY call_order`,
      )
    ).rows;
    await admin.query(`CREATE FUNCTION "${schema}".fail_alias() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'alias_write_failed'; END$$;
      CREATE TRIGGER fail_alias BEFORE INSERT ON "${schema}".model_usage_call_aliases FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_alias()`);
    const final = {
      ...intent,
      record: {
        ...intent.record,
        observation: {
          ...intent.record.observation,
          outcome: "completed" as const,
          finishedAt: "2026-08-08T00:01:03Z",
          providerResponseId: "new-finished-response",
          usageEventObserved: true,
        },
      },
    };
    await assert.rejects(a!.recordModelCall(final));
    assert.deepEqual(
      (
        await admin.query(
          `SELECT * FROM "${schema}".model_usage_observations ORDER BY usage_order`,
        )
      ).rows,
      usageBefore,
    );
    assert.deepEqual(
      (
        await admin.query(
          `SELECT * FROM "${schema}".model_call_observations ORDER BY call_order`,
        )
      ).rows,
      callsBefore,
    );
    await admin.query(
      `DROP TRIGGER fail_alias ON "${schema}".model_usage_call_aliases`,
    );
    assert.equal(await a!.recordModelCall(final), "enriched");
    await a!.close();
    await b!.close();
    await admin.query(`DROP TABLE "${schema}".model_usage_call_aliases`);
    await assert.rejects(open());
    assert.equal(
      (
        await admin.query("SELECT to_regclass($1) AS relation", [
          `${schema}.model_usage_call_aliases`,
        ])
      ).rows[0].relation,
      null,
    );
  },
);
