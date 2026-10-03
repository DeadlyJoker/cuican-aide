import assert from "node:assert/strict";
import test from "node:test";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { InstalledPluginExecutionReadinessOwner } from "./plugins/installed-plugin-execution-readiness.ts";
import { readinessCompositionFixture } from "./installed-plugin-execution-readiness-composition.test-support.ts";
import { deferred, until } from "./runtime-store-access.test-support.ts";
import { approval } from "./installed-plugin-execution-readiness.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 30_000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: actual composition only lends IO readiness for explicit executionIo and exposes no close authority`,
    options,
    async (t) => {
      const f = await readinessCompositionFixture(t, backend);
      for (const installedPluginExecution of [undefined, f.config]) {
        const runtime = await f.create({
          transport: f.transport,
          installedPluginExecution,
        });
        try {
          assert.equal(runtime.pluginExecutionReadiness, null);
          assert.equal((await runtime.worker.wake()).kind, "idle");
        } finally {
          await runtime.close();
        }
      }
      const runtime = await f.create({
        transport: f.transport,
        installedPluginExecution: {
          ...f.config,
          executionIo: f.metadata.config,
        },
      });
      try {
        const ready = runtime.pluginExecutionReadiness;
        assert.ok(ready);
        assert.deepEqual(Reflect.ownKeys(ready), ["assertReady"]);
        assert.equal(Object.isFrozen(ready), true);
        await ready.assertReady(f.metadata.input, new AbortController().signal);
        assert.equal(await f.countRuns(), 0);
        assert.equal(f.modelCalls(), 0);
        assert.equal(f.metadata.state.http, 0);
        assert.equal(f.metadata.state.dispatchResolution, 0);
        assert.equal(f.metadata.state.preflights, 1);
        await f.assertStoreLive();
      } finally {
        await runtime.close();
      }
    },
  );

  test(
    `${backend}: actual composition refuses absent preflight or denied current IO before any Model, HTTP or Run`,
    options,
    async (t) => {
      const f = await readinessCompositionFixture(t, backend);
      const legacy = { ...f.metadata.config };
      delete legacy.resolveReadinessNetwork;
      for (const executionIo of [
        legacy,
        { ...f.metadata.config, resolveReadinessNetwork: async () => null },
      ]) {
        const runtime = await f.create({
          transport: f.transport,
          installedPluginExecution: { ...f.config, executionIo },
        });
        try {
          assert.ok(runtime.pluginExecutionReadiness);
          await assert.rejects(
            runtime.pluginExecutionReadiness.assertReady(
              f.metadata.input,
              new AbortController().signal,
            ),
            /services_unavailable/u,
          );
          assert.equal(await f.countRuns(), 0);
          assert.equal(f.modelCalls(), 0);
          assert.equal(f.metadata.state.http, 0);
          assert.equal(f.metadata.state.dispatchResolution, 0);
        } finally {
          await runtime.close();
        }
      }
    },
  );

  test(
    `${backend}: composition captures preflight/DNS receivers before asynchronous storage and snapshots actual installed metadata`,
    options,
    async (t) => {
      const f = await readinessCompositionFixture(t, backend);
      let preflights = 0,
        dnsCalls = 0;
      const io = {
        ...f.metadata.config,
        async resolveReadinessNetwork(
          metadata: typeof f.metadata.input.metadata,
        ) {
          assert.equal(this, io);
          preflights++;
          assert.deepEqual(metadata, f.metadata.input.metadata);
          assert.equal(
            Object.isFrozen(metadata.configuration.parameters),
            true,
          );
          assert.equal(Object.hasOwn(metadata, "run"), false);
          assert.equal(Object.hasOwn(metadata, "command"), false);
          return approval;
        },
        dns: {
          async resolveAll(hostname: string) {
            assert.equal(this, io.dns);
            dnsCalls++;
            assert.equal(hostname, "readiness-fixture.example");
            return [{ address: "8.8.8.8", family: 4 as const }];
          },
        },
      };
      const opening = f.create({
        transport: f.transport,
        installedPluginExecution: { ...f.config, executionIo: io },
      });
      io.resolveReadinessNetwork = async () =>
        assert.fail("mutated preflight must not replace captured function");
      io.dns.resolveAll = async () =>
        assert.fail("mutated DNS must not replace captured method");
      const runtime = await opening;
      try {
        assert.ok(runtime.pluginExecutionReadiness);
        const input = structuredClone(f.metadata.input);
        const work = runtime.pluginExecutionReadiness.assertReady(
          input,
          new AbortController().signal,
        );
        Reflect.set(
          input.metadata.scope,
          "profileId",
          "caller-mutated-profile",
        );
        Reflect.set(
          input.metadata.identity,
          "packageDigest",
          "sha256:" + "1".repeat(64),
        );
        await work;
        assert.equal(preflights, 1);
        assert.equal(dnsCalls, 1);
        assert.equal(f.metadata.state.http, 0);
        assert.equal(await f.countRuns(), 0);
        assert.equal(f.modelCalls(), 0);
      } finally {
        await runtime.close();
      }
    },
  );

  for (const phase of ["callback", "dns"] as const)
    test(
      `${backend}: runtime.close joins physical IO readiness ${phase} before closing its actual parent Store`,
      options,
      async (t) => {
        const f = await readinessCompositionFixture(t, backend);
        const entered = deferred(),
          release = deferred();
        const io = {
          ...f.metadata.config,
          ...(phase === "callback"
            ? {
                async resolveReadinessNetwork() {
                  entered.resolve();
                  await release.promise;
                  await f.assertStoreLive();
                  return approval;
                },
              }
            : {
                dns: {
                  async resolveAll() {
                    entered.resolve();
                    await release.promise;
                    await f.assertStoreLive();
                    return [{ address: "8.8.8.8", family: 4 as const }];
                  },
                },
              }),
        };
        const runtime = await f.create({
          transport: f.transport,
          installedPluginExecution: { ...f.config, executionIo: io },
        });
        assert.ok(runtime.pluginExecutionReadiness);
        let closes = 0;
        const close = InstalledPluginExecutionReadinessOwner.prototype.close;
        t.mock.method(
          InstalledPluginExecutionReadinessOwner.prototype,
          "close",
          function (this: InstalledPluginExecutionReadinessOwner) {
            closes++;
            return close.call(this);
          },
        );
        const work = runtime.pluginExecutionReadiness.assertReady(
          f.metadata.input,
          new AbortController().signal,
        );
        void work.catch(() => {});
        try {
          await entered.promise;
          const closing = runtime.close();
          assert.equal(runtime.close(), closing);
          await until(() => closes === 1);
          await assert.rejects(work, /readiness_closed/u);
          assert.equal(f.counts.stores, 0);
          await f.assertStoreLive();
          assert.equal(await f.countRuns(), 0);
          release.resolve();
          await closing;
          await runtime.close();
          assert.equal(closes, 1);
          assert.equal(f.counts.stores, 1);
          assert.equal(f.counts.models, 1);
          assert.equal(f.counts.tools, 1);
          await assert.rejects(
            runtime.pluginExecutionReadiness.assertReady(
              f.metadata.input,
              new AbortController().signal,
            ),
            /closed/u,
          );
          await assert.rejects(f.assertStoreLive());
        } finally {
          release.resolve();
          await runtime.close().catch(() => {});
        }
      },
    );

  test(
    `${backend}: failed actual startup closes its real IO readiness owner once before the parent Store`,
    options,
    async (t) => {
      const f = await readinessCompositionFixture(t, backend);
      let closes = 0;
      const actualOwner: {
        value: InstalledPluginExecutionReadinessOwner | null;
      } = { value: null };
      const order: string[] = [];
      const close = InstalledPluginExecutionReadinessOwner.prototype.close;
      t.mock.method(
        InstalledPluginExecutionReadinessOwner.prototype,
        "close",
        function (this: InstalledPluginExecutionReadinessOwner) {
          actualOwner.value = this;
          closes++;
          order.push("ready:start");
          return f
            .assertStoreLive()
            .then(() => close.call(this))
            .then(() => {
              order.push("ready:end");
            });
        },
      );
      // Capture the actual backend prototype; delegate storage cleanup instead of replacing it.
      const storePrototype =
        backend === "sqlite"
          ? SqliteRunStore.prototype
          : PostgresDomainStore.prototype;
      const storeClose = storePrototype.close;
      t.mock.method(
        storePrototype,
        "close",
        function (this: SqliteRunStore | PostgresDomainStore) {
          order.push("store");
          return storeClose.call(this as never);
        },
      );
      await assert.rejects(
        f.create({
          transport: f.transport,
          leaseDurationMs: 0,
          installedPluginExecution: {
            ...f.config,
            executionIo: f.metadata.config,
          },
        }),
        /worker_lease_duration_invalid/u,
      );
      assert.equal(closes, 1);
      assert.deepEqual(order, ["ready:start", "ready:end", "store"]);
      assert.equal(f.counts.stores, 1);
      assert.equal(f.counts.models, 1);
      assert.equal(f.counts.tools, 1);
      assert.ok(actualOwner.value);
      await assert.rejects(
        actualOwner.value.assertReady(
          f.metadata.input,
          new AbortController().signal,
        ),
        /closed/u,
      );
      assert.equal(await f.countRuns(), 0);
      assert.equal(f.modelCalls(), 0);
      assert.equal(f.metadata.state.http, 0);
    },
  );
}
