import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: compact progress preserves real HTTP model input, history and cache accounting with fewer stored bytes`,
    options,
    async (context) => {
      const legacy = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        legacyProgressStore: true,
      });
      const compact = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
      });
      assert.equal((await legacy.worker().wake()).kind, "completed");
      assert.equal((await compact.worker().wake()).kind, "completed");
      assert.deepEqual(compact.requests, legacy.requests);
      assert.deepEqual(await compact.history(), await legacy.history());
      const events = async (fixture: typeof compact) =>
        (await fixture.events()).map(({ type, data }) => ({ type, data }));
      assert.deepEqual(await events(compact), await events(legacy));
      const accounting = await compact.accountingReport();
      assert.deepEqual(
        accounting.total,
        (await legacy.accountingReport()).total,
      );
      assert.equal(accounting.total.calls.intents, 2);
      assert.equal(accounting.total.calls.missingUsage, 0);
      assert.deepEqual(
        (await compact.usageRecords()).map(({ record }) => ({
          cachedInputTokens: record.observation.usage.cachedInputTokens,
          reported: record.observation.usage.cachedInputTokensReported,
        })),
        [
          { cachedInputTokens: 1024, reported: true },
          { cachedInputTokens: 1024, reported: true },
        ],
      );
      const before = await legacy.receiptStorageSummary(),
        after = await compact.receiptStorageSummary();
      assert.equal(before.fullCount - after.fullCount, 4);
      assert.equal(after.compactCount - before.compactCount, 4);
      const savedBytes =
        before.fullBytes +
        before.compactBytes -
        after.fullBytes -
        after.compactBytes;
      assert.ok(
        savedBytes > 4000,
        `receipt fields only, excludes row keys/indexes/WAL: ${savedBytes}`,
      );
      context.diagnostic(JSON.stringify({ before, after, savedBytes }));
    },
  );
  test(
    `${backend}: old progress receipts resume with compact progress after a committed tool sample without repeated generation`,
    options,
    async (context) => {
      const configuration = {
        backend,
        storeResponses: true,
        crashAfterCommit: true,
        legacyProgressStore: true,
      };
      const fixture = await createFixture(context, configuration);
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal(fixture.requests.length, 1);
      const before = await fixture.receiptStorageSummary();
      configuration.legacyProgressStore = false;
      await fixture.reopen();
      await fixture.makeDue();
      assert.equal((await fixture.worker().wake()).kind, "completed");
      assert.equal(fixture.executions(), 1);
      assert.equal(fixture.requests.length, 2);
      assert.equal(fixture.requests[1]?.previous_response_id, "resp-tools");
      assert.deepEqual(fixture.requests[1]?.input, [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "tool-result",
        },
      ]);
      assert.ok(
        (await fixture.receiptStorageSummary()).compactCount >
          before.compactCount,
      );
      const accounting = await fixture.accountingReport();
      assert.equal(accounting.total.calls.intents, 2);
      assert.equal(accounting.total.calls.missingUsage, 0);
    },
  );
}
