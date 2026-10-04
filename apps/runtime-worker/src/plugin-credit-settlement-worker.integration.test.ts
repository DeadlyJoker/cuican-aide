import assert from "node:assert/strict";
import test from "node:test";
import { SqliteRunStore, PostgresDomainStore } from "@crewon/store";
import { compositionFixture } from "./runtime-composition.test-support.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import { deferred } from "./runtime-store-access.test-support.ts";
import type {
  PluginCreditSettlementLocator,
  PluginCreditSettlementRecoveryPage,
  PluginCreditSettlementRecoveryStore,
} from "@crewon/application";
import { financialWorkerFixture } from "./plugin-credit-settlement-worker-integration.test-support.ts";
import { maintenanceFixture } from "./plugin-credit-settlement-maintenance.test-support.ts";
import { createPluginCreditSettlementMaintenance } from "./plugins/plugin-credit-settlement-maintenance.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 30_000,
    skip:
      backend === "postgres" &&
      process.env.CREWON_TEST_POSTGRES_URL === undefined,
  };

  test(
    `${backend}: ordinary Worker composition without financial config never acquires a settlement Store`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      await f.activate();
      let reads = 0;
      t.mock.method(
        backend === "sqlite"
          ? SqliteRunStore.prototype
          : PostgresDomainStore.prototype,
        "pluginCreditSettlementStore",
        () => {
          reads++;
          throw new Error("unexpected_financial_store");
        },
      );
      const runtime = await f.create();
      try {
        assert.equal((await runtime.worker.wake()).kind, "idle");
        assert.equal(reads, 0);
      } finally {
        await runtime.close();
      }
      assert.equal(reads, 0);
    },
  );

  test(
    `${backend}: actual financial coordinator joins a held fixture scan while ordinary streaming and Tool continuation remain unchanged`,
    options,
    async (t) => {
      const held = deferred<PluginCreditSettlementRecoveryPage>(),
        entered = deferred();
      // The financial Store/authority are named fixtures; the coordinator and ordinary Worker are real.
      const financial = maintenanceFixture({
        scan: async () => {
          entered.resolve();
          return held.promise;
        },
      });
      const maintenance = await createPluginCreditSettlementMaintenance({
        config: financial.config({ migrate: false }),
        storeFactory: financial.factory,
      });
      t.after(async () => {
        held.resolve({ items: [], nextRunId: null });
        await maintenance.close();
      });
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        pluginCreditSettlement: maintenance,
      });
      const outcome = await f.worker().wake();
      await entered.promise;
      assert.equal(outcome.kind, "completed");
      assert.equal(financial.scans.length, 1);
      assert.equal(maintenance.snapshot().pending, true);
      assert.equal(f.requests.length, 2);
      assert.equal(f.executions(), 1);
      assert.equal((await f.receipts())[0]?.status, "completed");
      const history = await f.history(),
        events = await f.events();
      await f.nextUserTurn();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(f.requests[2]?.previous_response_id, "resp-answer");
      assert.deepEqual(f.requests[2]?.input, [
        { role: "user", content: "next user turn" },
      ]);
      const closing = f.worker().close();
      assert.equal(maintenance.snapshot().closed, true);
      assert.equal(financial.state.current, false);
      assert.equal(financial.scans.length, 1);
      assert.equal(f.worker().close(), closing);
      let finished = false;
      void closing.then(() => {
        finished = true;
      });
      await new Promise<void>((done) => setImmediate(done));
      assert.equal(finished, false);
      assert.equal((await f.worker().wake()).kind, "idle");
      held.resolve({ items: [], nextRunId: null });
      await closing;
      assert.equal(f.executions(), 1);
      assert.ok((await f.history()).length >= history.length);
      assert.deepEqual(await f.events(), events);
    },
  );

  test(
    `${backend}: original Worker schedules real indexed paid settlement, then cold composition reads the immutable decision without a new charge`,
    options,
    async (t) => {
      const f = await financialWorkerFixture(t, backend);
      const runtime = await f.create();
      try {
        assert.equal((await runtime.worker.wake()).kind, "idle");
        const deadline = performance.now() + 10_000;
        while ((await f.read.getFinalization(f.fixture.locator)) === null) {
          assert.ok(
            performance.now() < deadline,
            "actual Worker financial round did not finalize",
          );
          await new Promise<void>((done) => setTimeout(done, 5));
        }
        const finalization = await f.read.getFinalization(f.fixture.locator);
        assert.ok(finalization);
        assert.equal(finalization.reservation.state, "settled");
        assert.equal(finalization.reservation.settledCredits, "18");
        assert.equal(finalization.account.availableCredits, "82");
        assert.equal(finalization.account.reservedCredits, "0");
        assert.equal(finalization.account.spentCredits, "18");
        assert.equal(f.counts.decisions, 1);
        assert.deepEqual(
          await f.fixture.parent.listRunEvents(f.fixture.locator, 0, 100),
          f.originalEvents,
        );
        await runtime.close();
        assert.equal(f.counts.closes, 1);
        const coldRead = deferred<unknown>();
        const prototype =
          backend === "sqlite"
            ? SqliteRunStore.prototype
            : PostgresDomainStore.prototype;
        const originalFactory = prototype.pluginCreditSettlementStore;
        t.mock.method(
          prototype,
          "pluginCreditSettlementStore",
          function (
            this: SqliteRunStore | PostgresDomainStore,
            owner: Readonly<{ assertCurrent(): void }> | undefined,
          ) {
            const store = Reflect.apply(originalFactory, this, [
              owner,
            ]) as PluginCreditSettlementRecoveryStore;
            const originalGet = store.getFinalization;
            t.mock.method(
              store,
              "getFinalization",
              async (locator: PluginCreditSettlementLocator) => {
                const saved = await originalGet.call(store, locator);
                if (locator.runId === f.fixture.locator.runId && saved !== null)
                  coldRead.resolve(saved);
                return saved;
              },
            );
            return store;
          },
        );
        let coldDecisions = 0;
        const restarted = f.restartConfig();
        const cold = await f.create({
          ...restarted,
          authority: {
            ...restarted.authority,
            async decide() {
              coldDecisions++;
              throw new Error("unexpected_second_financial_decision");
            },
          },
        });
        try {
          assert.equal((await cold.worker.wake()).kind, "idle");
          assert.deepEqual(await coldRead.promise, finalization);
        } finally {
          await cold.close();
        }
        assert.deepEqual(
          await f.read.getFinalization(f.fixture.locator),
          finalization,
        );
        assert.equal(f.counts.decisions, 1);
        assert.equal(coldDecisions, 0);
        const current = await f.fixture.credits.getAccount(
          f.fixture.admission.reservation.scope,
        );
        assert.deepEqual(current, finalization.account);
      } finally {
        await runtime.close();
      }
    },
  );

  test(
    `${backend}: outer financial getters fail before opening a Store while transferred resources close`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      f.observeStoreClose();
      let getterCalls = 0;
      const overrides = Object.defineProperty({}, "pluginCreditSettlement", {
        enumerable: true,
        get() {
          getterCalls++;
          throw new Error("unexpected_getter");
        },
      });
      // Passing a field on the composition object itself preserves the accessor for the actual entrypoint.
      const config = {
        ...f.config,
        ...(backend === "sqlite"
          ? { databasePath: `${f.root}/control.sqlite` }
          : {
              connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
              schema: "fixture_financial_getter",
            }),
      };
      Object.defineProperty(
        config,
        "pluginCreditSettlement",
        Object.getOwnPropertyDescriptor(overrides, "pluginCreditSettlement")!,
      );
      const { createStandaloneRuntimeWorker, createPostgresRuntimeWorker } =
        await import("./standalone-composition.ts");
      await assert.rejects(
        backend === "sqlite"
          ? createStandaloneRuntimeWorker(
              config as Parameters<typeof createStandaloneRuntimeWorker>[0],
            )
          : createPostgresRuntimeWorker(
              config as Parameters<typeof createPostgresRuntimeWorker>[0],
            ),
        /plugin_credit_settlement_configuration_invalid/u,
      );
      assert.equal(getterCalls, 0);
      assert.equal(f.counts.stores, 0);
      assert.equal(f.counts.models, 1);
      assert.equal(f.counts.tools, 1);
    },
  );

  test(
    `${backend}: financial tenant mismatch fails before Store open or authority IO`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      f.observeStoreClose();
      let requests = 0,
        closes = 0;
      let closing: Promise<void> | undefined;
      await assert.rejects(
        f.create({
          pluginCreditSettlement: {
            scope: {
              tenantId: "other-financial-tenant",
              spaceId: "explicit-space",
              profileId: "explicit-profile",
            },
            batchSize: 1,
            intervalMs: 1,
            maxRoundMs: 1000,
            migrate: false,
            authority: {
              async authorize() {
                requests++;
                throw new Error("unexpected_financial_request");
              },
              assertCurrent() {},
              async decide(): Promise<never> {
                requests++;
                throw new Error("unexpected_financial_request");
              },
              close() {
                if (closing === undefined) {
                  closes++;
                  closing = Promise.resolve();
                }
                return closing;
              },
            },
          },
        }),
        /plugin_credit_settlement_tenant_mismatch/u,
      );
      assert.equal(requests, 0);
      assert.equal(closes, 1);
      assert.equal(f.counts.stores, 0);
      assert.equal(f.counts.models, 1);
      assert.equal(f.counts.tools, 1);
    },
  );
}
