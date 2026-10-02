import assert from "node:assert/strict";
import test from "node:test";
import { compositionFixture } from "./runtime-composition.test-support.ts";
import { deferred, until } from "./runtime-store-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15000,
  };

  test(
    `${backend}: installed execution owner closes once before storage and repeated shutdown joins it`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      await f.activate();
      f.observeStoreClose();
      const held = deferred();
      let closes = 0;
      const runtime = await f.create({
        installedPluginRuntimeResolver: {
          acquire: async () =>
            assert.fail("ordinary startup must not acquire a plugin"),
          close: async () => {
            closes++;
            assert.equal(f.counts.stores, 0);
            await held.promise;
          },
        },
      });
      try {
        const closing = runtime.close();
        assert.equal(runtime.close(), closing);
        await until(() => closes === 1);
        assert.equal(f.counts.stores, 0);
        held.resolve();
        await closing;
        await runtime.close();
        assert.equal(closes, 1);
        assert.equal(f.counts.stores, 1);
      } finally {
        held.resolve();
        await runtime.close().catch(() => {});
      }
    },
  );

  test(
    `${backend}: transferred installed execution owner closes even when storage cannot open`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      let closes = 0;
      await assert.rejects(
        f.create(
          {
            installedPluginRuntimeResolver: {
              acquire: async () =>
                assert.fail("failed startup must not acquire a plugin"),
              close: async () => {
                closes++;
              },
            },
          },
          { failOpen: true },
        ),
      );
      assert.equal(closes, 1);
      assert.equal(f.counts.tools, 1);
      assert.equal(f.counts.models, 1);
    },
  );

  test(
    `${backend}: failing installed owner cleanup preserves startup error and still closes storage`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      await f.activate();
      f.observeStoreClose();
      let closes = 0;
      await assert.rejects(
        f.create({
          leaseDurationMs: 0,
          installedPluginRuntimeResolver: {
            acquire: async () =>
              assert.fail("failed startup must not acquire a plugin"),
            close: async () => {
              closes++;
              throw new Error("fixture_installed_owner_cleanup_failed");
            },
          },
        }),
        /worker_lease_duration_invalid/,
      );
      assert.equal(closes, 1);
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
    },
  );
}
