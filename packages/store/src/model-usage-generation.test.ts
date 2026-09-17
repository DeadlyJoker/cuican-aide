import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { reportModelUsageObservations } from "@crewon/domain";
import { modelCallGoalFixture } from "./model-call-goal.test-support.ts";
import { generationCallQuery } from "./model-generation-response-store.ts";
import { generationResponseKey } from "./model-usage-generation.ts";

type Fixture = Awaited<ReturnType<typeof modelCallGoalFixture>>;
function finish(f: Fixture, callId: string, responseId = "response-1") {
  const input = f.intent(callId);
  return {
    ...input,
    record: {
      ...input.record,
      observation: {
        ...input.record.observation,
        outcome: "failed" as const,
        finishedAt: "2026-08-08T00:01:04Z",
        providerResponseId: responseId,
      },
    },
  };
}
function usage(
  f: Fixture,
  callId: string,
  responseId: string | null = "response-1",
) {
  return {
    ...f.source,
    record: {
      ...f.source.record,
      observation: {
        ...f.source.record.observation,
        callId,
        providerResponseId: responseId,
      },
    },
  };
}
async function retrieval(
  f: Fixture,
  callId = "retrieve",
  responseId = "response-1",
) {
  const input = f.intent(callId);
  await f.store().recordModelCall({
    ...input,
    record: {
      ...input.record,
      observation: {
        ...input.record.observation,
        operation: "retrieve",
        providerResponseId: responseId,
      },
    },
  });
}
const rows = (f: Fixture) =>
  f.store().listModelUsage({ ...f.source.record, afterOrder: 0, limit: 128 });
async function sql(f: Fixture, backend: "sqlite" | "postgres", query: string) {
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
for (const backend of ["memory", "sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15000,
  };
  test(
    `${backend}: first usage recovered after Goal replacement retains the original generation and cache enrichment`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend);
      await f.store().recordModelCall(f.intent("generate"));
      const goal = (await f.rows())[0]!.record.goalAttribution;
      await f.store().recordModelCall(finish(f, "generate"));
      await f.changeGoal(null);
      const replacement = (await f.changeGoal("replacement goal")).goalState!;
      await f.reopen();
      await retrieval(f);
      const input = usage(f, "retrieve");
      const weak = {
        ...input,
        record: {
          ...input.record,
          observation: {
            ...input.record.observation,
            usage: {
              ...input.record.observation.usage,
              cachedInputTokens: 0,
              cachedInputTokensReported: false,
            },
          },
        },
      };
      assert.equal(await f.store().recordModelUsage(weak), "recorded");
      assert.deepEqual((await rows(f))[0]!.record.generation, {
        callId: "generate",
        goalAttribution: goal,
      });
      assert.equal(await f.store().recordModelUsage(input), "enriched");
      const snapshot = await rows(f);
      await f.reopen();
      for (let n = 0; n < 20; n++)
        assert.equal(await f.store().recordModelUsage(input), "replayed");
      assert.deepEqual(await rows(f), snapshot);
      assert.equal(snapshot[0]!.record.observation.callId, "retrieve");
      assert.equal(
        (await f
          .store()
          .loadThreadGoal({ ...f.source.record, threadId: "thread-1" }))!
          .goalId,
        replacement.goalId,
      );
      const report = reportModelUsageObservations(f.source.record, snapshot);
      assert.deepEqual(report.generationAttribution, {
        goalAttributedReports: 1,
        unboundGoalReports: 0,
        unknownGoalReports: 0,
        unknownGenerationReports: 0,
      });
      assert.equal(report.total.inputTokens, 100);
      assert.equal(report.total.reportedCachedInputTokens, 80);
    },
  );
  test(
    `${backend}: delayed direct usage keeps dispatch attribution and another known generation cannot reuse its response charge`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend);
      await f.store().recordModelCall(f.intent("first"));
      const originalGoal = (await f.rows())[0]!.record.goalAttribution;
      await f.changeGoal("edited while generating");
      const input = usage(f, "first");
      await f.store().recordModelUsage(input);
      assert.deepEqual((await rows(f))[0]!.record.generation, {
        callId: "first",
        goalAttribution: originalGoal,
      });
      await assert.rejects(
        f.store().recordModelUsage({
          ...input,
          record: {
            ...input.record,
            generation: { callId: "forged", goalAttribution: null },
          },
        }),
        { code: "model_usage_generation_conflict" },
      );
      await f.store().recordModelCall(f.intent("second"));
      await assert.rejects(f.store().recordModelUsage(usage(f, "second")), {
        code: "model_usage_generation_conflict",
      });
      assert.equal((await rows(f)).length, 1);
      assert.equal(await f.store().recordModelUsage(input), "replayed");
    },
  );
  test(
    `${backend}: unknown origins are not invented from current Goal, missing calls, or later replay`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend);
      await retrieval(f, "orphan");
      const orphan = usage(f, "orphan");
      await f.store().recordModelUsage(orphan);
      assert.equal((await rows(f))[0]!.record.generation, undefined);
      // New evidence must not silently reinterpret a legacy/unknown usage row.
      await f.store().recordModelCall(f.intent("late-evidence"));
      await f.store().recordModelCall(finish(f, "late-evidence"));
      await f.changeGoal("new goal revision");
      await f.reopen();
      assert.equal(await f.store().recordModelUsage(orphan), "replayed");
      assert.equal((await rows(f))[0]!.record.generation, undefined);
      await assert.rejects(
        f.store().recordModelUsage({
          ...usage(f, "missing", "response-missing"),
          record: {
            ...usage(f, "missing", "response-missing").record,
            generation: { callId: "late-evidence", goalAttribution: null },
          },
        }),
        { code: "model_usage_generation_conflict" },
      );
      assert.equal((await rows(f)).length, 1);
    },
  );
  test(
    `${backend}: ambiguous generation response identity remains unknown after replay and reopen`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend);
      for (const id of ["one", "two"]) {
        await f.store().recordModelCall(f.intent(id));
        await f.store().recordModelCall(finish(f, id));
      }
      await f.store().recordModelCall(finish(f, "one"));
      await f.reopen();
      await retrieval(f);
      await f.store().recordModelUsage(usage(f, "retrieve"));
      assert.equal((await rows(f))[0]!.record.generation, undefined);
      assert.equal((await f.rows()).length, 3);
    },
  );
  test(
    `${backend}: generation attribution rejects model scope mismatch and preserves confirmed unbound calls`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend);
      await f.changeGoal(null);
      await f.store().recordModelCall(f.intent("unbound"));
      const input = usage(f, "unbound");
      await assert.rejects(
        f.store().recordModelUsage({
          ...input,
          record: {
            ...input.record,
            observation: {
              ...input.record.observation,
              modelId: "different-model",
            },
          },
        }),
        { code: "model_usage_conflict" },
      );
      await f.store().recordModelUsage(input);
      assert.deepEqual((await rows(f))[0]!.record.generation, {
        callId: "unbound",
        goalAttribution: null,
      });
    },
  );
  if (backend !== "memory") {
    test(
      `${backend}: known generation with legacy unknown Goal remains distinct from unbound`,
      options,
      async (t) => {
        const f = await modelCallGoalFixture(t, backend);
        await f.store().recordModelCall(f.intent("legacy-goal"));
        await f.eraseLegacyAttribution();
        await f.changeGoal("new objective");
        await f.reopen();
        await f.store().recordModelUsage(usage(f, "legacy-goal"));
        const saved = await rows(f);
        assert.deepEqual(saved[0]!.record.generation, {
          callId: "legacy-goal",
        });
        const report = reportModelUsageObservations(f.source.record, saved);
        assert.deepEqual(report.generationAttribution, {
          goalAttributedReports: 0,
          unboundGoalReports: 0,
          unknownGoalReports: 1,
          unknownGenerationReports: 0,
        });
        await f.reopen();
        await f.store().recordModelUsage(usage(f, "legacy-goal"));
        assert.deepEqual(await rows(f), saved);
      },
    );
    test(
      `${backend}: a missing current response authority is rejected without recreating an empty ledger`,
      options,
      async (t) => {
        const f = await modelCallGoalFixture(t, backend);
        await f.store().close();
        await sql(f, backend, "DROP TABLE model_generation_responses");
        await assert.rejects(f.reopen());
        const present = await sql(
          f,
          backend,
          backend === "sqlite"
            ? "SELECT name FROM sqlite_schema WHERE name='model_generation_responses'"
            : "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='model_generation_responses'",
        );
        assert.equal(present.length, 0);
      },
    );
    test(
      `${backend}: migration leaves historical calls byte-identical and builds response links only on authorized completion`,
      options,
      async (t) => {
        const f = await modelCallGoalFixture(t, backend);
        await f.store().recordModelCall(f.intent("old"));
        await f.store().recordModelCall(finish(f, "old"));
        const calls = await sql(
          f,
          backend,
          "SELECT record_json FROM model_call_observations ORDER BY call_order",
        );
        await f.store().close();
        await sql(f, backend, "DROP TABLE model_generation_responses");
        await sql(
          f,
          backend,
          backend === "sqlite"
            ? "PRAGMA user_version=40"
            : "UPDATE schema_migrations SET version=11 WHERE component='execution_authority'",
        );
        await f.reopen();
        assert.deepEqual(
          await sql(
            f,
            backend,
            "SELECT record_json FROM model_call_observations ORDER BY call_order",
          ),
          calls,
        );
        assert.equal(
          Number(
            (
              await sql(
                f,
                backend,
                "SELECT count(*) n FROM model_generation_responses",
              )
            )[0]!.n,
          ),
          0,
        );
        await retrieval(f);
        await f.store().recordModelUsage(usage(f, "retrieve"));
        assert.equal((await rows(f))[0]!.record.generation, undefined);
        await f.store().recordModelCall(finish(f, "old"));
        assert.equal(
          Number(
            (
              await sql(
                f,
                backend,
                "SELECT count(*) n FROM model_generation_responses",
              )
            )[0]!.n,
          ),
          1,
        );
        await f.store().recordModelUsage(usage(f, "retrieve"));
        assert.equal((await rows(f))[0]!.record.generation, undefined);
      },
    );
    test(
      `${backend}: response lookup uses bounded primary-key seeks and failed link write rolls back completion`,
      options,
      async (t) => {
        const f = await modelCallGoalFixture(t, backend);
        await f.store().recordModelCall(f.intent("original"));
        const before = await f.rows();
        if (backend === "sqlite")
          await sql(
            f,
            backend,
            "CREATE TRIGGER fail_generation_link BEFORE INSERT ON model_generation_responses BEGIN SELECT RAISE(ABORT,'link_failed'); END",
          );
        else {
          await sql(
            f,
            backend,
            "CREATE FUNCTION fail_generation_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'link_failed'; END $$",
          );
          await sql(
            f,
            backend,
            "CREATE TRIGGER fail_generation_link BEFORE INSERT ON model_generation_responses FOR EACH ROW EXECUTE FUNCTION fail_generation_link()",
          );
        }
        await assert.rejects(f.store().recordModelCall(finish(f, "original")));
        assert.deepEqual(await f.rows(), before);
        await sql(
          f,
          backend,
          backend === "sqlite"
            ? "DROP TRIGGER fail_generation_link"
            : "DROP TRIGGER fail_generation_link ON model_generation_responses",
        );
        await f.store().recordModelCall(finish(f, "original"));
        const linkVersion = () =>
          sql(
            f,
            backend,
            backend === "sqlite"
              ? "SELECT response_key,call_key,ambiguous FROM model_generation_responses"
              : "SELECT response_key,call_key,ambiguous,xmin::text AS version FROM model_generation_responses",
          );
        const stableLink = await linkVersion();
        if (backend === "sqlite")
          await sql(
            f,
            backend,
            "CREATE TRIGGER forbid_link_update BEFORE UPDATE ON model_generation_responses BEGIN SELECT RAISE(ABORT,'redundant_update'); END",
          );
        for (let i = 0; i < 25; i++)
          await f.store().recordModelCall(finish(f, "original"));
        assert.deepEqual(await linkVersion(), stableLink);
        const key = generationResponseKey((await f.rows())[0]!.record)!;
        await sql(
          f,
          backend,
          backend === "sqlite"
            ? "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000) INSERT INTO model_call_observations(call_key,tenant_id,run_id,record_json) SELECT 'noise-call-'||x,tenant_id,run_id,record_json FROM n CROSS JOIN (SELECT tenant_id,run_id,record_json FROM model_call_observations ORDER BY call_order LIMIT 1) c"
            : "INSERT INTO model_call_observations(call_key,tenant_id,run_id,record_json) SELECT 'noise-call-'||n,tenant_id,run_id,record_json FROM generate_series(1,5000) n CROSS JOIN (SELECT tenant_id,run_id,record_json FROM model_call_observations ORDER BY call_order LIMIT 1) c",
        );
        if (backend === "postgres")
          await sql(f, backend, "ANALYZE model_call_observations");
        const query = generationCallQuery(backend === "postgres", "", true);
        // Parameters below are generated fixed SHA-256 values, not user-supplied SQL.
        const plan = JSON.stringify(
          await sql(
            f,
            backend,
            (backend === "sqlite" ? "EXPLAIN QUERY PLAN " : "EXPLAIN ") +
              query.replace(backend === "sqlite" ? "?" : "$1", `'${key}'`),
          ),
        );
        if (backend === "sqlite") {
          assert.match(plan, /SEARCH g USING INDEX/);
          assert.match(plan, /SEARCH c USING INDEX/);
        } else {
          // Populate realistic noise before asking PostgreSQL to choose an index.
          await sql(
            f,
            backend,
            "INSERT INTO model_generation_responses(response_key,call_key,ambiguous) SELECT md5(n::text)||md5(n::text),call_key,0 FROM generate_series(1,5000) n CROSS JOIN (SELECT call_key FROM model_generation_responses LIMIT 1) c",
          );
          await sql(f, backend, "ANALYZE model_generation_responses");
          const largePlan = JSON.stringify(
            await sql(f, backend, "EXPLAIN " + query.replace("$1", `'${key}'`)),
          );
          assert.match(
            largePlan,
            /Index Scan.*model_generation_responses_pkey/,
          );
        }
        await retrieval(f);
        await f.store().recordModelUsage(usage(f, "retrieve"));
        assert.equal((await rows(f))[0]!.record.generation!.callId, "original");
      },
    );
  }
}
