import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { processAgentRuntimeCapacity } from "./agent-runtime-capacity.ts";
import { compileRuntimeAgentVersion } from "./standalone-composition.ts";
import { sharedAgentVersionRuntimeFactory } from "./shared-agent-version-runtime-factory.ts";
import { compositionFixture } from "./runtime-composition.test-support.ts";
import { deferred, until } from "./runtime-store-access.test-support.ts";
import { DesktopProviderProbeEgressPolicy } from "./provider-probe-egress.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15000,
  };
  test(
    `${backend}: occupied probe port unwinds Worker, model, tools and Store`,
    options,
    async (t) => {
      const blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, "127.0.0.1", resolve);
      });
      t.after(
        () =>
          new Promise<void>((resolve, reject) =>
            blocker.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      const address = blocker.address();
      assert.ok(address !== null && typeof address !== "string");
      const f = compositionFixture(t, backend);
      await f.activate();
      f.observeStoreClose();
      const capacity = processAgentRuntimeCapacity.snapshot();
      await assert.rejects(
        f.create({
          providerProbe: {
            port: address.port,
            token: "runtime-worker-private-probe-token-32-bytes",
            runtimeBinding: {
              runtimeBindingId: "fixture",
              providerId: "fixture",
              endpoint: "http://127.0.0.1:9/v1",
              credentialKind: "none",
              environmentVariable: null,
            },
            secrets: { resolve: () => null },
            egressPolicy: new DesktopProviderProbeEgressPolicy(),
          },
        }),
        (error) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "EADDRINUSE",
      );
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
      assert.deepEqual(processAgentRuntimeCapacity.snapshot(), capacity);
    },
  );
  test(
    `${backend}: failed bootstrap compilation disposes every input and preserves the original error`,
    options,
    async (t) => {
      const original = new Error("catalog unavailable");
      const f = compositionFixture(t, backend, {
        toolClose: () => {
          throw new Error("tool close failed");
        },
      });
      f.observeStoreClose();
      f.config.toolRuntime.definitions = () => {
        throw original;
      };
      await assert.rejects(f.create(), (error) => error === original);
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 0 });
    },
  );
  test(
    `${backend}: Store-open failure still disposes transferred tool and model inputs`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      f.observeStoreClose();
      await assert.rejects(f.create({}, { failOpen: true }));
      assert.equal(f.counts.tools, 1);
      assert.equal(f.counts.models, 1);
    },
  );
  test(
    `${backend}: missing durable release closes inputs and the opened Store`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      f.observeStoreClose();
      await assert.rejects(f.create(), /runtime_release_bundle_missing/);
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
    },
  );
  test(
    `${backend}: binding failure after registry registration closes the registered owner and returns admission`,
    options,
    async (t) => {
      const original = new Error("shared binding failed");
      const f = compositionFixture(t, backend);
      const factory = {
        create: async () => assert.fail("creation not expected"),
        bindSharedToolRuntime: () => {
          throw original;
        },
      };
      const config = {
        agentVersionRuntimeFactory: factory,
        agentVersionDeployments: [],
      };
      await f.activate(config);
      f.observeStoreClose();
      const capacity = processAgentRuntimeCapacity.snapshot();
      await assert.rejects(f.create(config), (error) => error === original);
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
      assert.deepEqual(processAgentRuntimeCapacity.snapshot(), capacity);
    },
  );
  test(
    `${backend}: Worker constructor failure unwinds its already registered dependencies`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      await f.activate();
      f.observeStoreClose();
      const capacity = processAgentRuntimeCapacity.snapshot();
      await assert.rejects(
        f.create({ leaseDurationMs: 0 }),
        /worker_lease_duration_invalid/,
      );
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
      assert.deepEqual(processAgentRuntimeCapacity.snapshot(), capacity);
    },
  );
  test(
    `${backend}: close fences new work and waits for an active borrower and both slow disposers before Store close`,
    options,
    async (t) => {
      const tool = deferred(),
        model = deferred();
      const f = compositionFixture(t, backend, {
        toolClose: () => tool.promise,
        modelClose: () => model.promise,
      });
      await f.activate();
      f.observeStoreClose();
      const runtime = await f.create();
      const locator = {
        tenantId: f.config.runtimeTenantId,
        agentVersionId: runtime.agentVersion.agentVersionId,
      };
      const lease = runtime.agentVersionRegistry.acquire(locator)!;
      assert.ok(lease);
      try {
        const closing = runtime.close();
        assert.equal(runtime.close(), closing);
        assert.equal(runtime.agentVersionRegistry.acquire(locator), null);
        await new Promise<void>((done) => setImmediate(done));
        assert.deepEqual(f.counts, { tools: 0, models: 0, stores: 0 });
        lease.release();
        await until(() => f.counts.tools === 1 && f.counts.models === 1);
        assert.equal(f.counts.stores, 0);
        tool.resolve();
        await new Promise<void>((done) => setImmediate(done));
        assert.equal(f.counts.stores, 0);
        model.resolve();
        await closing;
        assert.equal(runtime.close(), closing);
        assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
      } finally {
        lease.release();
        tool.resolve();
        model.resolve();
        await runtime.close().catch(() => {});
      }
    },
  );
  test(
    `${backend}: synchronous tool shutdown error still waits for model and closes Store exactly once`,
    options,
    async (t) => {
      const model = deferred();
      const f = compositionFixture(t, backend, {
        toolClose: () => {
          throw new Error("tool close failed");
        },
        modelClose: () => model.promise,
      });
      await f.activate();
      f.observeStoreClose();
      const runtime = await f.create();
      try {
        const closing = runtime.close(),
          checked = assert.rejects(closing, /runtime_close_failed/);
        await until(() => f.counts.models === 1);
        assert.equal(runtime.close(), closing);
        assert.equal(f.counts.stores, 0);
        model.resolve();
        await checked;
        assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
      } finally {
        model.resolve();
        await runtime.close().catch(() => {});
      }
    },
  );
  test(
    `${backend}: aliased additional runtime closes once and an unused duplicate is disposed during startup`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      const route = { ...f.config.route, agentVersionId: "additional-version" };
      const version = compileRuntimeAgentVersion({ ...f.config, route });
      const base = await sharedAgentVersionRuntimeFactory(
        { route, transport: f.config.transport },
        new InMemoryToolBroker(),
      ).create({ tenantId: "tenant-1", version });
      let registeredCloses = 0,
        unusedCloses = 0;
      const registered = {
        ...base,
        close: async () => {
          registeredCloses++;
        },
      };
      const unused = {
        ...base,
        close: async () => {
          unusedCloses++;
        },
      };
      const additions = {
        additionalAgentVersionRuntimes: [
          { tenantId: "tenant-1", runtime: registered },
          { tenantId: "tenant-1", runtime: registered },
          { tenantId: "tenant-1", runtime: unused },
        ],
      };
      await f.activate(additions);
      f.observeStoreClose();
      const runtime = await f.create(additions);
      try {
        assert.equal(registeredCloses, 0);
        assert.equal(unusedCloses, 1);
        assert.equal(
          runtime.agentVersionRegistry.resolve({
            tenantId: "tenant-1",
            agentVersionId: version.agentVersionId,
          }),
          registered,
        );
      } finally {
        await runtime.close();
      }
      assert.equal(registeredCloses, 1);
      assert.equal(unusedCloses, 1);
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
    },
  );
}
