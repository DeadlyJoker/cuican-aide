import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import { agentVersionAsset } from "./agent-version-store-conformance.test-support.ts";
import type { ModelTokenPrice } from "@crewon/domain";
import { modelCallGoalFixture } from "./model-call-goal.test-support.ts";
import { modelSpendingSchemaSql } from "./model-spending-schema.ts";
import { PostgresModelSpendingStore } from "./postgres-model-spending-store.ts";
const price: ModelTokenPrice = {
  schemaVersion: "crewon.model-token-price.v0",
  currency: "USD",
  rates: { input: "2500000", cacheRead: "250000", output: "10000000" },
};
const ceiling = "2700000000";
async function fixture(
  t: TestContext,
  backend: "memory" | "sqlite" | "postgres",
) {
  const f = await modelCallGoalFixture(t, backend),
    scope = {
      tenantId: f.firstGoal.tenantId,
      threadId: f.firstGoal.threadId,
      goalId: f.firstGoal.goalId,
    };
  const identity = f.source.record.observation;
  const asset = agentVersionAsset(scope.tenantId, identity.agentVersionId);
  await f.store().registerAgentVersion({
    ...asset,
    definitionJson: JSON.stringify({
      ...JSON.parse(asset.definitionJson),
      model: {
        adapterName: identity.adapterName,
        adapterVersion: identity.adapterVersion,
        modelId: identity.modelId,
        contextWindowTokens: 1000,
        autoCompactAtTokens: 800,
        maxOutputTokens: 20,
      },
    }),
  });
  const pricing = {
    tenantId: scope.tenantId,
    agentVersionId: identity.agentVersionId,
  };
  await f.store().modelPricing!.set({ ...pricing, expectedRevision: 0, price });
  const call = (id: string) => {
    const input = f.intent(id);
    return {
      ...input,
      record: {
        ...input.record,
        observation: { ...input.record.observation, maxOutputTokens: 20 },
      },
    };
  };
  const account = () => f.store().modelSpending!.get(scope);
  const set = (limit = ceiling, expectedRevision = 0, currency = "USD") =>
    f.store().modelSpending!.set({
      ...scope,
      expectedRevision,
      currency,
      limitPicounits: limit,
    });
  const usage = (callId: string, reported = true) => ({
    ...f.source,
    record: {
      ...f.source.record,
      observation: {
        ...f.source.record.observation,
        callId,
        providerResponseId: null,
        usage: {
          ...f.source.record.observation.usage,
          cachedInputTokens: reported ? 80 : 0,
          cachedInputTokensReported: reported,
        },
      },
    },
  });
  const sql = async (query: string) => {
    if (backend === "sqlite") {
      const db = new DatabaseSync(f.persistence.path);
      try {
        db.exec(query);
      } finally {
        db.close();
      }
      return;
    }
    assert.equal(backend, "postgres");
    const db = new Pool({
      connectionString: f.persistence.connectionString,
      max: 1,
    });
    try {
      await db.query(`SET search_path TO "${f.persistence.schema}"`);
      await db.query(query);
    } finally {
      await db.end();
    }
  };
  return { ...f, scope, pricing, call, account, set, usage, sql };
}

async function waitForAdvisoryLock(db: PoolClient, pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (
      (
        await db.query(
          `SELECT 1 FROM pg_locks waiter
           JOIN pg_locks holder ON holder.pid=pg_backend_pid() AND holder.granted
             AND holder.locktype=waiter.locktype
             AND holder.database=waiter.database
             AND holder.classid=waiter.classid
             AND holder.objid=waiter.objid
             AND holder.objsubid=waiter.objsubid
           WHERE waiter.pid=$1 AND waiter.locktype='advisory' AND NOT waiter.granted`,
          [pid],
        )
      ).rowCount !== 0
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("writer did not reach the expected advisory lock");
}

test(
  "postgres: an old writer already in flight observes concurrently activated spending before its INSERT commits",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "postgres");
    await f.store().recordModelCall(f.call("before-activation"));
    const pools = Array.from(
      { length: 3 },
      () =>
        new Pool({ connectionString: f.persistence.connectionString, max: 1 }),
    );
    const [admin, settings, legacy] = pools as [Pool, Pool, Pool];
    const settingPid = (await settings.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const legacyPid = (await legacy.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const db = await admin.connect();
    let activated: Promise<unknown> | undefined,
      inserted: Promise<unknown> | undefined;
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `model-spending:${f.scope.tenantId}:${f.scope.threadId}`,
      ]);
      activated = new PostgresModelSpendingStore(
        settings,
        `"${f.persistence.schema}"`,
        () => {},
      ).set({
        ...f.scope,
        currency: "USD",
        expectedRevision: 0,
        limitPicounits: ceiling,
      });
      await waitForAdvisoryLock(db, settingPid);
      inserted = legacy.query(
        `INSERT INTO "${f.persistence.schema}".model_call_observations(call_key,tenant_id,run_id,record_json) SELECT call_key || '-old-writer',tenant_id,run_id,record_json FROM "${f.persistence.schema}".model_call_observations`,
      );
      const rejected = assert.rejects(
        inserted,
        /model_spending_reservation_required/,
      );
      await waitForAdvisoryLock(db, legacyPid);
      await db.query("COMMIT");
      await activated;
      await rejected;
      assert.equal((await f.rows()).length, 1);
      assert.equal((await f.account())!.calls, 0);
    } finally {
      await db.query("ROLLBACK");
      db.release();
      await Promise.allSettled([activated, inserted]);
      await Promise.all(pools.map((pool) => pool.end()));
    }
  },
);

test(
  "postgres: budget activation waits for the Goal mutation fence and rejects a replaced Goal",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "postgres");
    const admin = new Pool({
      connectionString: f.persistence.connectionString,
      max: 1,
    });
    const writer = new Pool({
      connectionString: f.persistence.connectionString,
      max: 1,
      application_name: "spending_activation_fixture",
    });
    const db = await admin.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `thread:${f.scope.tenantId}:${f.scope.threadId}`,
      ]);
      const store = new PostgresModelSpendingStore(
        writer,
        `"${f.persistence.schema}"`,
        () => {},
      );
      const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      pending = store.set({
        ...f.scope,
        currency: "USD",
        limitPicounits: ceiling,
        expectedRevision: 0,
      });
      const rejected = assert.rejects(pending, {
        code: "model_spending_goal_changed",
      });
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting =
          (
            await db.query(
              "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
              [writerPid],
            )
          ).rowCount !== 0;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(
        waiting,
        "configuration must acquire the existing Goal mutation fence",
      );
      await db.query(
        `DELETE FROM "${f.persistence.schema}".thread_goals WHERE tenant_id=$1 AND thread_id=$2`,
        [f.scope.tenantId, f.scope.threadId],
      );
      await db.query("COMMIT");
      await rejected;
      assert.equal(await f.account(), null);
    } finally {
      await db.query("ROLLBACK");
      db.release();
      await pending?.catch(() => {});
      await writer.end();
      await admin.end();
    }
  },
);
for (const backend of ["memory", "sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 20000,
  };
  test(
    `${backend}: atomic model spending survives unknown results, replay, cache enrichment and configuration changes`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.store().recordModelCall(f.call("before-activation"));
      const initial = await f.set();
      assert.equal(initial.coverage, "callsAdmittedAfterActivation");
      const calls = [f.call("one"), f.call("two")];
      const admitted = await Promise.allSettled(
        calls.map((c) => f.store().recordModelCall(c)),
      );
      assert.equal(admitted.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = admitted.find((r) => r.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.equal(rejected.reason.code, "model_spending_budget_exhausted");
      const accepted =
          calls[admitted.findIndex((r) => r.status === "fulfilled")]!,
        callId = accepted.record.observation.callId;
      assert.equal((await f.account())!.reservedPicounits, ceiling);
      assert.equal((await f.account())!.calls, 1);
      assert.equal(await f.store().recordModelCall(accepted), "replayed");
      await f.store().recordModelCall({
        ...accepted,
        record: {
          ...accepted.record,
          observation: {
            ...accepted.record.observation,
            outcome: "canceled",
            finishedAt: "2026-08-08T00:01:05Z",
          },
        },
      });
      await f.reopen();
      assert.equal((await f.account())!.reservedPicounits, ceiling);
      await assert.rejects(f.store().recordModelCall(f.call("after-cancel")), {
        code: "model_spending_budget_exhausted",
      });
      await f.store().recordModelUsage(f.usage(callId, false));
      assert.equal((await f.account())!.chargedPicounits, "350000000");
      assert.equal((await f.account())!.reservedPicounits, "0");
      await f.store().recordModelUsage(f.usage(callId));
      assert.equal((await f.account())!.chargedPicounits, "170000000");
      assert.equal((await f.account())!.unsettledCalls, 0);
      await f.reopen();
      const before = await f.account();
      await f.store().recordModelUsage(f.usage(callId));
      assert.deepEqual(await f.account(), before);
      assert.equal((await f.set("2870000000", 1)).revision, 2);
      assert.equal((await f.set("2870000000", 1)).revision, 2);
      assert.equal((await f.account())!.chargedPicounits, "170000000");
      await assert.rejects(f.set("999", 1), {
        code: "model_spending_revision_conflict",
      });
      await assert.rejects(f.set("2870000000", 2, "CNY"), {
        code: "model_spending_currency_immutable",
      });
      await f.store().recordModelCall(f.call("continued"));
      assert.equal((await f.account())!.reservedPicounits, ceiling);
      assert.equal((await f.account())!.calls, 2);
      assert.equal(
        await f.store().modelSpending!.get({ ...f.scope, tenantId: "other" }),
        null,
      );
    },
  );
  test(
    `${backend}: missing quote, model bounds and currency fail before admission without consuming balance`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.set();
      await f
        .store()
        .modelPricing!.set({ ...f.pricing, expectedRevision: 1, price: null });
      await assert.rejects(f.store().recordModelCall(f.call("unpriced")), {
        code: "model_spending_price_required",
      });
      await f.store().modelPricing!.set({
        ...f.pricing,
        expectedRevision: 2,
        price: { ...price, currency: "CNY" },
      });
      await assert.rejects(f.store().recordModelCall(f.call("currency")), {
        code: "model_spending_currency_mismatch",
      });
      await f
        .store()
        .modelPricing!.set({ ...f.pricing, expectedRevision: 3, price });
      await assert.rejects(f.store().recordModelCall(f.intent("unbounded")), {
        code: "model_spending_token_bounds_required",
      });
      const call = f.call("forged-bound");
      await assert.rejects(
        f.store().recordModelCall({
          ...call,
          record: {
            ...call.record,
            observation: { ...call.record.observation, maxOutputTokens: 1 },
          },
        }),
        { code: "model_spending_token_bounds_required" },
      );
      assert.equal((await f.account())!.calls, 0);
      assert.equal((await f.rows()).length, 0);
    },
  );
  test(
    `${backend}: observed usage above configured bounds is recorded and freezes new spending`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.set();
      await f.store().recordModelCall(f.call("over-bound"));
      const u = f.usage("over-bound");
      await f.store().recordModelUsage({
        ...u,
        record: {
          ...u.record,
          observation: {
            ...u.record.observation,
            usage: {
              inputTokens: 1001,
              cachedInputTokens: 0,
              cachedInputTokensReported: true,
              outputTokens: 100,
              totalTokens: 1101,
            },
          },
        },
      });
      assert.equal((await f.account())!.boundaryExceededCalls, 1);
      assert.equal((await f.account())!.chargedPicounits, "3502500000");
      await f.set("999999999999", 1);
      await assert.rejects(f.store().recordModelCall(f.call("blocked")), {
        code: "model_spending_boundary_exceeded",
      });
    },
  );
  if (backend !== "memory") {
    test(
      `${backend}: old call writers cannot bypass active spending or discard reserved call prices`,
      options,
      async (t) => {
        const f = await fixture(t, backend);
        await f.set();
        await f.store().recordModelCall(f.call("admitted"));
        await assert.rejects(
          f.sql(
            "INSERT INTO model_call_observations(call_key,tenant_id,run_id,record_json) SELECT call_key || '-legacy',tenant_id,run_id,record_json FROM model_call_observations",
          ),
          /model_spending_reservation_required/,
        );
        await assert.rejects(
          f.sql(
            backend === "sqlite"
              ? "UPDATE model_call_observations SET record_json=json_remove(record_json,'$.tokenPricing')"
              : "UPDATE model_call_observations SET record_json=record_json-'tokenPricing'",
          ),
          /model_spending_price_immutable/,
        );
        assert.equal((await f.rows()).length, 1);
        assert.equal((await f.account())!.calls, 1);
        assert.equal((await f.account())!.reservedPicounits, ceiling);
        await f.store().close();
        await f.sql(
          backend === "sqlite"
            ? "DROP TRIGGER model_spending_admission"
            : "ALTER TABLE model_call_observations DISABLE TRIGGER model_spending_admission",
        );
        await assert.rejects(f.reopen(), {
          code: "model_spending_schema_incomplete",
        });
        await f.sql(
          backend === "sqlite"
            ? modelSpendingSchemaSql({ postgres: false })
            : "ALTER TABLE model_call_observations ENABLE TRIGGER model_spending_admission",
        );
        await f.reopen();
        assert.equal((await f.account())!.reservedPicounits, ceiling);
        await f.store().recordModelUsage(f.usage("admitted"));
        assert.equal((await f.account())!.chargedPicounits, "170000000");
      },
    );
    test(
      `${backend}: prior schema migrates without retroactive accounts or changes to historical calls`,
      options,
      async (t) => {
        const f = await fixture(t, backend);
        await f.store().recordModelCall(f.call("historical"));
        const before = await f.rows();
        await f.store().close();
        await f.sql(
          backend === "sqlite"
            ? "DROP TRIGGER model_spending_admission; DROP TRIGGER model_spending_price_fence; DROP TABLE model_spending_reservations; DROP TABLE model_spending_accounts; PRAGMA user_version=42"
            : "DROP TRIGGER model_spending_admission ON model_call_observations; DROP TRIGGER model_spending_price_fence ON model_call_observations; DROP FUNCTION model_spending_admission_guard(); DROP TABLE model_spending_reservations; DROP TABLE model_spending_accounts; UPDATE schema_migrations SET version=13 WHERE component='execution_authority'",
        );
        await f.reopen();
        assert.deepEqual(await f.rows(), before);
        assert.equal(await f.account(), null);
        const account = await f.set();
        assert.equal(account.calls, 0);
        assert.equal(account.coverage, "callsAdmittedAfterActivation");
        await f.store().recordModelUsage(f.usage("historical"));
        assert.deepEqual(await f.account(), account);
        await f.store().recordModelCall(f.call("after-activation"));
        assert.equal((await f.account())!.reservedPicounits, ceiling);
      },
    );
    test(
      `${backend}: reservation and usage settlement roll back with their canonical transactions`,
      options,
      async (t) => {
        const f = await fixture(t, backend);
        await f.set();
        await f.sql(
          backend === "sqlite"
            ? "CREATE TRIGGER spending_fail BEFORE INSERT ON model_call_observations BEGIN SELECT RAISE(ABORT,'fixture_call_failure'); END"
            : "CREATE FUNCTION spending_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_call_failure'; END; $$; CREATE TRIGGER spending_fail BEFORE INSERT ON model_call_observations FOR EACH ROW EXECUTE FUNCTION spending_fail()",
        );
        await assert.rejects(f.store().recordModelCall(f.call("one")));
        assert.equal((await f.account())!.calls, 0);
        await f.sql(
          backend === "sqlite"
            ? "DROP TRIGGER spending_fail"
            : "DROP TRIGGER spending_fail ON model_call_observations; DROP FUNCTION spending_fail()",
        );
        await f.store().recordModelCall(f.call("one"));
        await f.sql(
          backend === "sqlite"
            ? "CREATE TRIGGER spending_fail BEFORE UPDATE ON model_spending_accounts BEGIN SELECT RAISE(ABORT,'fixture_settlement_failure'); END"
            : "CREATE FUNCTION spending_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_settlement_failure'; END; $$; CREATE TRIGGER spending_fail BEFORE UPDATE ON model_spending_accounts FOR EACH ROW EXECUTE FUNCTION spending_fail()",
        );
        await assert.rejects(f.store().recordModelUsage(f.usage("one")));
        assert.equal(
          (
            await f
              .store()
              .listModelUsage({ ...f.source.record, afterOrder: 0, limit: 128 })
          ).length,
          0,
        );
        assert.equal((await f.account())!.reservedPicounits, ceiling);
        await f.sql(
          backend === "sqlite"
            ? "DROP TRIGGER spending_fail"
            : "DROP TRIGGER spending_fail ON model_spending_accounts; DROP FUNCTION spending_fail()",
        );
        await f.reopen();
        await f.store().recordModelUsage(f.usage("one"));
        assert.equal((await f.account())!.chargedPicounits, "170000000");
      },
    );
  }
}
