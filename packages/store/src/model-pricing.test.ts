import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  reportModelUsageObservations,
  type ModelTokenPrice,
} from "@crewon/domain";
import { modelCallGoalFixture } from "./model-call-goal.test-support.ts";
const price: ModelTokenPrice = {
  schemaVersion: "crewon.model-token-price.v0",
  currency: "USD",
  rates: { input: "2500000", cacheRead: "250000", output: "10000000" },
};
const replacement: ModelTokenPrice = {
  ...price,
  rates: { input: "5000000", cacheRead: "500000", output: "20000000" },
};
for (const backend of ["memory", "sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15000,
  };
  test(
    `${backend}: pricing CAS is tenant scoped, replayable and survives restart`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend),
        key = {
          tenantId: f.source.record.tenantId,
          agentVersionId: f.source.record.observation.agentVersionId,
        };
      const prices = () => f.store().modelPricing!;
      assert.deepEqual(await prices().get(key), { revision: 0, price: null });
      const results = await Promise.allSettled([
        prices().set({ ...key, expectedRevision: 0, price }),
        prices().set({ ...key, expectedRevision: 0, price: replacement }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const first = await prices().get(key);
      assert.equal(first.revision, 1);
      assert.deepEqual(
        await prices().set({ ...key, expectedRevision: 0, price: first.price }),
        first,
      );
      await assert.rejects(
        prices().set({ ...key, expectedRevision: 0, price: null }),
        { code: "model_pricing_revision_conflict" },
      );
      assert.deepEqual(await prices().get({ ...key, tenantId: "other" }), {
        revision: 0,
        price: null,
      });
      await f.reopen();
      assert.deepEqual(await prices().get(key), first);
      assert.deepEqual(
        await prices().set({ ...key, expectedRevision: 1, price: null }),
        { revision: 2, price: null },
      );
      const restored = await prices().set({
        ...key,
        expectedRevision: 2,
        price,
      });
      assert.equal(restored.revision, 3);
    },
  );
  test(
    `${backend}: late retrieved usage uses dispatch price, enriches cache and never reprices historical calls`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend),
        key = {
          tenantId: f.source.record.tenantId,
          agentVersionId: f.source.record.observation.agentVersionId,
        };
      const input = f.intent("generate");
      await f.store().recordModelCall(f.intent("legacy-unpriced"));
      await f.store().modelPricing!.set({ ...key, expectedRevision: 0, price });
      await f.store().recordModelCall(input);
      const original = (await f.rows())[1]!.record;
      assert.deepEqual(original.tokenPricing, { revision: 1, price });
      await f
        .store()
        .modelPricing!.set({ ...key, expectedRevision: 1, price: replacement });
      await f.changeGoal(null);
      await f.reopen();
      const finish = {
        ...input,
        record: {
          ...input.record,
          observation: {
            ...input.record.observation,
            outcome: "failed" as const,
            finishedAt: "2026-08-08T00:01:04Z",
            providerResponseId: "response-1",
          },
        },
      };
      await assert.rejects(
        f.store().recordModelCall({
          ...finish,
          record: {
            ...finish.record,
            tokenPricing: { revision: 2, price: replacement },
          },
        }),
        { code: "model_call_pricing_conflict" },
      );
      await f.store().recordModelCall(finish);
      const retrieve = f.intent("retrieve");
      await f.store().recordModelCall({
        ...retrieve,
        record: {
          ...retrieve.record,
          observation: {
            ...retrieve.record.observation,
            operation: "retrieve",
            providerResponseId: "response-1",
          },
        },
      });
      const usage = {
        ...f.source,
        record: {
          ...f.source.record,
          observation: {
            ...f.source.record.observation,
            callId: "retrieve",
            providerResponseId: "response-1",
            usage: {
              inputTokens: 100,
              cachedInputTokens: 0,
              cachedInputTokensReported: false,
              outputTokens: 10,
              totalTokens: 110,
            },
          },
        },
      };
      await f.store().recordModelUsage(usage);
      const rows = () =>
        f
          .store()
          .listModelUsage({ ...f.source.record, afterOrder: 0, limit: 128 });
      assert.deepEqual((await rows())[0]!.record.generation?.tokenPricing, {
        revision: 1,
        price,
      });
      const report = () =>
        rows().then((r) => reportModelUsageObservations(f.source.record, r));
      assert.equal(
        (await report()).tokenCost.currencies[0]!.upperPicounits,
        "350000000",
      );
      const enriched = {
        ...usage,
        record: {
          ...usage.record,
          observation: {
            ...usage.record.observation,
            usage: {
              ...usage.record.observation.usage,
              cachedInputTokens: 80,
              cachedInputTokensReported: true,
            },
          },
        },
      };
      assert.equal(await f.store().recordModelUsage(enriched), "enriched");
      assert.equal(
        (await report()).tokenCost.currencies[0]!.upperPicounits,
        "170000000",
      );
      const before = await rows();
      await f.reopen();
      assert.equal(await f.store().recordModelUsage(enriched), "replayed");
      assert.deepEqual(await rows(), before);
      const calls = await f.rows();
      assert.equal(calls[0]!.record.tokenPricing, undefined);
      assert.deepEqual(calls[1]!.record.tokenPricing, { revision: 1, price });
      assert.equal(calls[2]!.record.tokenPricing, undefined);
      await f.store().recordModelCall(f.intent("new-price"));
      assert.deepEqual((await f.rows())[3]!.record.tokenPricing, {
        revision: 2,
        price: replacement,
      });
      assert.equal(
        (await report()).tokenCost.currencies[0]!.upperPicounits,
        "170000000",
      );
    },
  );
  if (backend !== "memory")
    test(
      `${backend}: pricing migration starts empty and current-schema corruption fails closed`,
      options,
      async (t) => {
        const f = await modelCallGoalFixture(t, backend);
        await f.store().recordModelCall(f.intent("unpriced"));
        const before = await f.rows();
        async function sql(query: string) {
          if (backend === "sqlite") {
            const db = new DatabaseSync(f.persistence.path);
            try {
              return db.prepare(query).all();
            } finally {
              db.close();
            }
          }
          const pool = new Pool({
            connectionString: f.persistence.connectionString,
            max: 1,
          });
          try {
            await pool.query(`SET search_path TO "${f.persistence.schema}"`);
            return (await pool.query(query)).rows;
          } finally {
            await pool.end();
          }
        }
        await sql("DROP TABLE model_token_pricing");
        await sql(
          backend === "sqlite"
            ? "PRAGMA user_version=41"
            : "UPDATE schema_migrations SET version=12 WHERE component='execution_authority'",
        );
        await f.reopen();
        assert.deepEqual(await f.rows(), before);
        assert.equal(
          Number(
            (await sql("SELECT count(*) n FROM model_token_pricing"))[0]!.n,
          ),
          0,
        );
        const plans = await sql(
          backend === "sqlite"
            ? "EXPLAIN QUERY PLAN SELECT revision,price_json FROM model_token_pricing WHERE tenant_id='t' AND agent_version_id='a'"
            : "EXPLAIN SELECT revision,price_json FROM model_token_pricing WHERE tenant_id='t' AND agent_version_id='a'",
        );
        assert.match(JSON.stringify(plans), /INDEX|Index/);
        await sql("DROP TABLE model_token_pricing");
        await assert.rejects(f.reopen());
      },
    );
}
