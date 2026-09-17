import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import {
  deferred,
  storeAccessClock,
  until,
} from "./runtime-store-access.test-support.ts";
import { digester } from "./shared-agent-runtime-cache.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 30000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  for (const stored of [false, true]) {
    test(
      `${backend}: leased runtime recovery preserves HTTP model inputs and a single tool effect, stored=${stored}`,
      options,
      async (t) => {
        const normal = await createFixture(t, {
          backend,
          storeResponses: stored,
          crashAfterCommit: false,
        });
        assert.equal((await normal.worker().wake()).kind, "completed");
        const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
        let closes = 0,
          observedLeases = 0;
        t.after(() => registry.close());
        const recovered = await createFixture(t, {
          backend,
          storeResponses: stored,
          crashAfterCommit: false,
          crashAfterResolved: true,
          runtimeResolverFactory: (base) => {
            registry.register({
              tenantId: "tenant-1",
              runtime: {
                ...base,
                close: async () => {
                  closes++;
                },
              },
            });
            return registry;
          },
          afterToolProviderResolved: async () => {
            observedLeases = registry.resourceSnapshot().activeLeases;
            assert.ok(observedLeases > 0);
          },
        });
        assert.equal((await recovered.worker().wake()).kind, "retried");
        assert.equal(registry.resourceSnapshot().activeLeases, 0);
        assert.equal(recovered.executions(), 1);
        await recovered.reopen();
        assert.equal((await recovered.worker().wake()).kind, "completed");
        assert.equal(registry.resourceSnapshot().activeLeases, 0);
        assert.equal(recovered.executions(), 1);
        assert.deepEqual(recovered.requests, normal.requests);
        assert.ok(observedLeases > 0);
        assert.equal(closes, 0);
        await recovered.worker().close();
        await registry.close();
        assert.equal(closes, 1);
      },
    );
  }

  test(
    `${backend}: policy timeout does not release the runtime still used by its physical evaluation`,
    options,
    async (t) => {
      const clock = storeAccessClock(),
        entered = deferred(),
        held = deferred();
      const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
      let closes = 0;
      t.after(async () => {
        held.resolve();
        await registry.close();
      });
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        preflightTime: clock.time,
        runtimeResolverFactory: (base) => {
          registry.register({
            tenantId: "tenant-1",
            runtime: {
              ...base,
              close: async () => {
                closes++;
              },
            },
          });
          return registry;
        },
        policy: {
          evaluate: async () => {
            entered.resolve();
            await held.promise;
            return { outcome: "allow" };
          },
        },
      });
      const wake = f.worker().wake();
      await entered.promise;
      clock.advance(10000);
      assert.equal((await wake).kind, "leaseLost");
      assert.equal(registry.resourceSnapshot().activeLeases, 1);
      await f.worker().close();
      const closing = registry.close();
      assert.equal(closes, 0);
      held.resolve();
      await closing;
      assert.equal(closes, 1);
      assert.equal(registry.resourceSnapshot().activeLeases, 0);
      assert.equal(f.requests.length, 0);
      assert.equal(f.executions(), 0);
    },
  );

  test(
    `${backend}: late cold acquisition is released after Worker shutdown without executing the model`,
    options,
    async (t) => {
      const clock = storeAccessClock(),
        entered = deferred(),
        held = deferred();
      const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
      let closes = 0;
      t.after(async () => {
        held.resolve();
        await registry.close();
      });
      const f = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        preflightTime: clock.time,
        runtimeResolverFactory: (base) => {
          registry.register({
            tenantId: "tenant-1",
            runtime: {
              ...base,
              close: async () => {
                closes++;
              },
            },
          });
          return {
            resolve() {
              throw new Error("legacy lookup must not execute");
            },
            async acquire(locator) {
              const lease = registry.acquire(locator);
              entered.resolve();
              await held.promise;
              return lease;
            },
          };
        },
      });
      const wake = f.worker().wake();
      await entered.promise;
      clock.advance(10000);
      assert.equal((await wake).kind, "leaseLost");
      await f.worker().close();
      const closing = registry.close();
      assert.equal(closes, 0);
      held.resolve();
      await closing;
      await until(() => f.worker().preflightSnapshot().pendingRequests === 0);
      assert.equal(closes, 1);
      assert.equal(registry.resourceSnapshot().activeLeases, 0);
      assert.equal(f.requests.length, 0);
      assert.equal(f.executions(), 0);
    },
  );
}
