import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import type { ModelCallRecord, ModelUsageRecord } from "@crewon/domain";
import { modelCallKey } from "./model-call-store-support.ts";
import { modelUsageKey } from "./model-usage-store-support.ts";
import {
  sqliteModelCallSchemaSql,
  sqliteModelUsageSchemaSql,
  postgresModelCallSchemaSql,
  postgresModelUsageSchemaSql,
} from "./model-usage-schema.ts";
import { modelAccountingIndexSql } from "./model-accounting-index.ts";
import {
  accountingUsageEvidenceQuery,
  readModelAccountingReport,
  type AccountingDatabase,
} from "./model-accounting-reader.ts";
import {
  readSqliteModelAccountingReport,
  readPostgresModelAccountingReport,
} from "./model-accounting-report.ts";

const locator = { tenantId: "tenant", runId: "run" };
function records(id: string): {
  call: ModelCallRecord;
  usage: ModelUsageRecord;
} {
  const identity = {
    purpose: "agent" as const,
    agentVersionId: "agent",
    adapterName: "adapter",
    adapterVersion: "1",
    modelId: "model",
  };
  const scope = { ...locator, stepId: "step", attemptId: "attempt" };
  return {
    call: {
      ...scope,
      observation: {
        ...identity,
        schemaVersion: "crewon.model-call-observation.v0",
        callId: id,
        transport: "http",
        operation: "generate",
        startedAt: "2026-09-11T00:00:00Z",
        finishedAt: "2026-09-11T00:00:01Z",
        outcome: "completed",
        providerResponseId: `response-${id}`,
        firstOutputLatencyMs: 100,
        usageEventObserved: true,
      },
    },
    usage: {
      ...scope,
      observedAt: "2026-09-11T00:00:01Z",
      observation: {
        ...identity,
        schemaVersion: "crewon.model-usage-observation.v0",
        observationId: `usage-${id}`,
        callId: id,
        providerResponseId: `response-${id}`,
        responseStatus: null,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 80,
          cachedInputTokensReported: true,
          outputTokens: 10,
          totalTokens: 110,
        },
      },
    },
  };
}
async function fixture(t: TestContext, backend: "sqlite" | "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "crewon-accounting-report-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "runtime.sqlite");
  const postgres = backend === "postgres",
    schemaName = `crewon_accounting_${randomUUID().replaceAll("-", "_")}`;
  const schema = postgres ? `"${schemaName}".` : "";
  const db = postgres ? null : new DatabaseSync(databasePath);
  const pool = postgres
    ? new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        max: 1,
      })
    : null;
  t.after(async () => {
    db?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await pool.end();
    }
  });
  const execute = async (
    sql: string,
    parameters: readonly (string | number | null)[] = [],
  ) => {
    if (pool) return (await pool.query(sql, [...parameters])).rows;
    return db!.prepare(sql.replace(/\$\d+/g, "?")).all(...parameters);
  };
  const ddl = async (sql: string) => {
    if (pool) await pool.query(sql);
    else db!.exec(sql);
  };
  if (postgres) await ddl(`CREATE SCHEMA "${schemaName}"`);
  await ddl(
    `CREATE TABLE ${schema}run_snapshots(tenant_id TEXT,run_id TEXT,UNIQUE(tenant_id,run_id)); INSERT INTO ${schema}run_snapshots VALUES('tenant','run'),('noise','noise')`,
  );
  await ddl(
    postgres
      ? postgresModelCallSchemaSql(`"${schemaName}"`) +
          postgresModelUsageSchemaSql(`"${schemaName}"`)
      : sqliteModelCallSchemaSql() + sqliteModelUsageSchemaSql(),
  );
  await ddl(modelAccountingIndexSql(postgres, schema));
  const source: AccountingDatabase = {
    postgres,
    schema,
    query: execute,
    transaction: async (work) => {
      await ddl(
        postgres ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
      );
      try {
        const r = await work();
        await ddl("COMMIT");
        return r;
      } catch (e) {
        await ddl("ROLLBACK");
        throw e;
      }
    },
  };
  const insertCall = (c: ModelCallRecord) =>
    execute(
      `INSERT INTO ${schema}model_call_observations(call_key,tenant_id,run_id,record_json) VALUES($1,$2,$3,$4)`,
      [modelCallKey(c), c.tenantId, c.runId, JSON.stringify(c)],
    );
  const insertUsage = (u: ModelUsageRecord) =>
    execute(
      `INSERT INTO ${schema}model_usage_observations(usage_key,tenant_id,run_id,record_json) VALUES($1,$2,$3,$4)`,
      [modelUsageKey(u), u.tenantId, u.runId, JSON.stringify(u)],
    );
  const read = () =>
    postgres
      ? readPostgresModelAccountingReport({
          ...locator,
          connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
          schema: schemaName,
        })
      : readSqliteModelAccountingReport({ ...locator, databasePath });
  return {
    db,
    pool,
    execute,
    ddl,
    source,
    insertCall,
    insertUsage,
    read,
    databasePath,
    schema,
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: indexed paged reconciliation preserves unfinished usage, deduplicates response retrieval, and is read-only`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      for (let i = 0; i < 301; i++) {
        const r = records(String(i));
        if (i === 0) {
          r.call = {
            ...r.call,
            observation: {
              ...r.call.observation,
              outcome: "unknown",
              finishedAt: null,
              providerResponseId: null,
              firstOutputLatencyMs: null,
              usageEventObserved: false,
            },
          };
        }
        await f.insertCall(r.call);
        await f.insertUsage(r.usage);
      }
      const retrieval = records("get").call;
      await f.insertCall({
        ...retrieval,
        observation: {
          ...retrieval.observation,
          operation: "retrieve",
          providerResponseId: "response-1",
        },
      });
      const json = JSON.stringify(records("noise").usage);
      if (backend === "postgres")
        await f.execute(
          `INSERT INTO ${f.schema}model_usage_observations(usage_key,tenant_id,run_id,record_json) SELECT 'noise-'||n,'noise','noise',$1::jsonb FROM generate_series(1,2000) n`,
          [json],
        );
      else
        await f.execute(
          `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO model_usage_observations(usage_key,tenant_id,run_id,record_json) SELECT 'noise-'||x,'noise','noise',$1 FROM n`,
          [json],
        );
      await f.ddl(
        backend === "postgres"
          ? `ANALYZE ${f.schema}model_usage_observations`
          : "ANALYZE",
      );
      const before = f.db ? readFileSync(f.databasePath) : null;
      let queries = 0;
      const r = await readModelAccountingReport(
        {
          ...f.source,
          query: async (sql, parameters) => {
            queries++;
            const rows = await f.source.query(sql, parameters);
            if (
              sql.startsWith("SELECT call_order") ||
              sql.startsWith("SELECT usage_order")
            )
              assert(rows.length <= 64);
            if (sql.startsWith("WITH wanted")) assert(rows.length <= 192);
            return rows;
          },
        },
        locator,
      );
      assert.equal(queries, 21); // One head read and two queries per 64-row page in each ledger.
      assert.deepEqual(await f.read(), r);
      assert.equal(r.total.calls.intents, 302);
      assert.equal(r.total.calls.directUsage, 301);
      assert.equal(r.total.calls.unfinishedWithUsage, 1);
      assert.equal(r.retrievals.responseUsage, 1);
      assert.equal(r.total.usage.inputTokens, 30100);
      assert.equal(r.total.usage.cacheReadHitRate, 0.8);
      assert.equal(r.usageLinks.directCall, 301);
      const q = accountingUsageEvidenceQuery(
        f.source,
        locator,
        2301,
        Array.from({ length: 64 }, (_, i) => records(String(i + 1)).call),
      );
      const plan = await f.execute(
        `${backend === "postgres" ? "EXPLAIN (FORMAT JSON)" : "EXPLAIN QUERY PLAN"} ${q.sql}`,
        q.parameters,
      );
      const text = JSON.stringify(plan);
      assert.match(text, /model_usage_call_identity/);
      assert(!/"Node Type":"Seq Scan"/.test(text), text);
      assert(!/SCAN (?:u|model_usage_observations)\b/.test(text), text);
      if (f.db) {
        const cli = spawnSync(
          process.execPath,
          [
            "--experimental-strip-types",
            new URL(
              "../../../scripts/crewon-model-cache-report.ts",
              import.meta.url,
            ).pathname,
            f.databasePath,
            locator.tenantId,
            locator.runId,
            "--reconcile",
          ],
          { encoding: "utf8" },
        );
        assert.equal(cli.status, 0, cli.stderr);
        assert.deepEqual(JSON.parse(cli.stdout), r);
        assert.deepEqual(readFileSync(f.databasePath), before);
      }
    },
  );

  test(
    `${backend}: conflicting, duplicate, legacy and missing associations stay explicit; invalid data and missing indexes fail closed`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const a = records("a");
      await f.insertCall(a.call);
      await f.insertUsage(a.usage);
      await f.insertUsage({
        ...a.usage,
        observation: {
          ...a.usage.observation,
          providerResponseId: "different-response",
        },
      });
      const b = records("b");
      await f.insertCall(b.call);
      await f.insertUsage({ ...b.usage, attemptId: "other-attempt" });
      const missing = records("missing");
      await f.insertUsage(missing.usage);
      const legacy = records("legacy").usage;
      delete (legacy.observation as { callId?: string }).callId;
      await f.insertUsage(legacy);
      const r = await f.read();
      assert.equal(r.total.calls.ambiguousUsage, 1);
      assert.equal(r.total.calls.conflictingUsage, 1);
      assert.equal(r.total.calls.persistedUsageCoverage, 0);
      assert.equal(r.usageLinks.missingCall, 1);
      assert.equal(r.usageLinks.legacyWithoutCallId, 1);
      assert.equal(r.total.usage.usageReports, 5);
      await f.execute(
        `UPDATE ${f.schema}model_call_observations SET record_json=$1 WHERE call_key=$2`,
        [JSON.stringify({ private: "must-not-leak" }), modelCallKey(a.call)],
      );
      await assert.rejects(
        f.read(),
        /^RunStoreError: model_call_record_invalid$/,
      );
      await f.ddl(`DROP INDEX ${f.schema}model_usage_call_identity`);
      await assert.rejects(f.read(), /model_accounting_index_unavailable/);
    },
  );
}

test(
  "PostgreSQL locked source respects its query budget, closes failed reporting and permits a later report",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const f = await fixture(t, "postgres"),
      r = records("a");
    await f.insertCall(r.call);
    await f.insertUsage(r.usage);
    await f.ddl(
      `BEGIN; LOCK TABLE ${f.schema}run_snapshots IN ACCESS EXCLUSIVE MODE`,
    );
    try {
      const start = performance.now();
      await assert.rejects(f.read(), { code: "57014" });
      assert(performance.now() - start < 5000);
    } finally {
      await f.ddl("ROLLBACK");
    }
    assert.equal((await f.read()).total.calls.directUsage, 1);
  },
);

test("SQLite per-page snapshots hold joined evidence stable, bound high-water marks and honor cancellation between pages", async (t) => {
  const f = await fixture(t, "sqlite");
  f.db!.exec("PRAGMA journal_mode=WAL");
  const r = records("a");
  await f.insertCall(r.call);
  await f.insertUsage(r.usage);
  const other = new DatabaseSync(f.databasePath);
  t.after(() => other.close());
  let changed = false;
  const source: AccountingDatabase = {
    ...f.source,
    query: async (sql, p) => {
      const rows = await f.source.query(sql, p);
      if (!changed && sql.startsWith("SELECT call_order")) {
        changed = true;
        other
          .prepare("UPDATE model_usage_observations SET record_json=?")
          .run(JSON.stringify({ ...r.usage, attemptId: "changed" }));
        const late = records("late").call;
        other
          .prepare(
            "INSERT INTO model_call_observations(call_key,tenant_id,run_id,record_json) VALUES(?,?,?,?)",
          )
          .run(
            modelCallKey(late),
            locator.tenantId,
            locator.runId,
            JSON.stringify(late),
          );
      }
      return rows;
    },
  };
  const result = await readModelAccountingReport(source, locator);
  assert.equal(result.total.calls.intents, 1);
  assert.equal(result.total.calls.directUsage, 1);
  assert.equal(result.usageLinks.conflictingCall, 1); // The next page has a newer snapshot, explicitly labelled.
  assert.equal(result.consistency, "pageSnapshots");
  assert.equal((await f.read()).total.calls.intents, 2);
  const abort = new AbortController();
  abort.abort(new Error("test_abort"));
  await assert.rejects(
    readModelAccountingReport(f.source, { ...locator, signal: abort.signal }),
    /test_abort/,
  );
  const during = new AbortController();
  let queryCount = 0;
  const cancelSource: AccountingDatabase = {
    ...f.source,
    query: async (sql, parameters) => {
      queryCount++;
      const rows = await f.source.query(sql, parameters);
      if (sql.startsWith("WITH wanted"))
        during.abort(new Error("cancel_between_pages"));
      return rows;
    },
  };
  await assert.rejects(
    readModelAccountingReport(cancelSource, {
      ...locator,
      signal: during.signal,
    }),
    /cancel_between_pages/,
  );
  assert.equal(queryCount, 3);
  other.exec("BEGIN IMMEDIATE; ROLLBACK"); // The canceled report left no read transaction open.
});
