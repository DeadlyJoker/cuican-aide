import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import type { AuthorizationPort } from "@crewon/application";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import {
  InstalledPluginQueryHost,
  type InstalledPluginExecutionConfig,
} from "./index.ts";
import {
  actor,
  businessExecutionFixture,
  digester,
  scope,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";

type Fixture = Awaited<ReturnType<typeof businessExecutionFixture>>;
const authorization: AuthorizationPort = {
  async authorize({ actor: candidate, resource }) {
    assert.deepEqual(candidate, actor);
    assert.equal(resource.tenantId, actor.tenantId);
    return { outcome: "allow" };
  },
};
function queryConfig(f: Fixture): InstalledPluginExecutionConfig {
  return {
    installRoot: f.pkg.input.installRoot,
    authorization,
    resolveActor: async () => actor,
    authorizePackage: async ({ candidate, scope: selected, purpose }) => {
      assert.deepEqual(selected, scope);
      assert.equal(
        candidate.packageDigest,
        f.entry.registration.identity.packageDigest,
      );
      assert.equal(purpose, "observe");
      return "allow";
    },
    historicalQuery: { scope, resolveProfile: async () => scope },
  };
}
async function paidSource(f: Fixture) {
  const request = await f.prepareTask("composition-source"),
    original = await request.create(),
    admission = await f.extensions.loadPluginTaskAdmission(original.binding),
    operationId = randomUUID();
  assert.ok(admission);
  // Deterministic provider record. This test never calls a model or external supplier.
  await f.operations.reserveExternalOperation({
    tenantId: actor.tenantId,
    runId: original.binding.runId,
    bindingDigest: original.binding.bindingDigest,
    operationId,
    executionId: "composition-op",
    idempotencyKey: "composition-op",
    actionDigest: digester.sha256("action"),
    requestDigest: digester.sha256("request"),
    correlationId: operationId,
    createdAt: new Date().toISOString(),
  });
  return { admission, binding: original.binding, operationId };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 60000,
  };
  test(
    `${backend}: explicit composition owns the actual historical query host and captures profile before storage opens`,
    options,
    async (t) => {
      const f = await businessExecutionFixture(t, backend),
        source = await paidSource(f),
        newer = await f.upgrade();
      const historicalQuery = {
        scope: { ...scope },
        resolveProfile: async () => scope,
      };
      const config = { ...queryConfig(f), historicalQuery };
      let allowOpen!: () => void;
      let opened!: () => void;
      const entered = new Promise<void>((yes) => {
        opened = yes;
      });
      const gate = new Promise<void>((yes) => {
        allowOpen = yes;
      });
      if (backend === "postgres") {
        const originalOpen = PostgresDomainStore.open;
        t.mock.method(
          PostgresDomainStore,
          "open",
          async (input: Parameters<typeof originalOpen>[0]) => {
            opened();
            await gate;
            return originalOpen.call(PostgresDomainStore, input);
          },
        );
      }
      const opening = f.openWorker({ installedPluginExecution: config });
      if (backend === "postgres") await entered;
      // Deployment values and function identities are captured before the first storage await.
      historicalQuery.scope.profileId = "mutated-profile";
      historicalQuery.resolveProfile = async () => {
        throw new Error("mutated-profile-resolver");
      };
      config.authorizePackage = async () => {
        throw new Error("mutated-package-authority");
      };
      allowOpen();
      const runtime = await opening;
      assert.ok(runtime.pluginQueryHost instanceof InstalledPluginQueryHost);
      const host = runtime.pluginQueryHost,
        registration = await host.resolveRegistration({ actor, source });
      assert.ok(registration);
      assert.equal(
        registration.implementationDigest,
        f.entry.registration.implementationDigest,
      );
      assert.notEqual(
        registration.implementationDigest,
        newer.implementationDigest,
      );
      assert.deepEqual(
        await host.evaluate({
          actor,
          source,
          registration,
          configuration: f.entry.configuration,
          expectedTarget: source.binding.target,
        }),
        { outcome: "ready", target: source.binding.target },
      );
      assert.equal(f.controls.factories.length, 0);
      assert.equal(f.controls.models.length, 0);
      assert.equal(f.controls.executes.length, 0);
      let closes = 0;
      const close = host.close.bind(host);
      t.mock.method(host, "close", () => {
        closes++;
        return close();
      });
      await Promise.all([runtime.close(), runtime.close()]);
      await f.closeWorker();
      assert.equal(closes, 1);
      await assert.rejects(
        host.resolveRegistration({ actor, source }),
        /host_closed/u,
      );
    },
  );

  test(
    `${backend}: default composition does not acquire installed metadata or query owners`,
    options,
    async (t) => {
      const f = await businessExecutionFixture(t, backend);
      const prototype =
        backend === "sqlite"
          ? SqliteRunStore.prototype
          : PostgresDomainStore.prototype;
      for (const method of [
        "pluginInstallationStore",
        "externalOperationStore",
        "extensionStore",
      ] as const)
        t.mock.method(prototype, method, () => {
          throw new Error(`unexpected-${method}`);
        });
      const runtime = await f.openWorker({
        installedPluginExecution: undefined,
      });
      assert.equal(runtime.pluginQueryHost, null);
      assert.equal(f.controls.factories.length, 0);
      await f.closeWorker();
      t.mock.restoreAll();
    },
  );

  test(
    `${backend}: query and execution IO opt-ins explicitly migrate the owned operation store`,
    options,
    async (t) => {
      const f = await businessExecutionFixture(t, backend),
        prototype = Object.getPrototypeOf(f.operations) as {
          migrate(): Promise<void>;
        },
        migrate = prototype.migrate;
      let migrations = 0;
      t.mock.method(prototype, "migrate", function (this: typeof prototype) {
        migrations++;
        return migrate.call(this);
      });
      await f.openWorker({ installedPluginExecution: queryConfig(f) });
      assert.equal(migrations, 1);
      await f.closeWorker();
      const { historicalQuery: _query, ...executionOnly } = queryConfig(f);
      await f.openWorker({
        installedPluginExecution: {
          ...executionOnly,
          executionIo: { resolveNetwork: async () => null },
        },
      });
      assert.equal(migrations, 2);
      await f.closeWorker();
    },
  );

  test(
    `${backend}: historical profile from another tenant fails before opening composition storage`,
    options,
    async (t) => {
      const f = await businessExecutionFixture(t, backend),
        prototype =
          backend === "sqlite"
            ? SqliteRunStore.prototype
            : PostgresDomainStore.prototype;
      let metadata = 0;
      t.mock.method(prototype, "pluginInstallationStore", () => {
        metadata++;
        throw new Error("unexpected-installed-metadata");
      });
      if (backend === "postgres")
        t.mock.method(PostgresDomainStore, "open", () => {
          throw new Error("unexpected-open");
        });
      await assert.rejects(
        f.openWorker({
          installedPluginExecution: {
            ...queryConfig(f),
            historicalQuery: {
              scope: { ...scope, tenantId: "another-tenant" },
              resolveProfile: async () => scope,
            },
          },
        }),
        /installed_plugin_query_tenant_mismatch/u,
      );
      assert.equal(metadata, 0);
      t.mock.restoreAll();
    },
  );

  test(
    `${backend}: close waits for query borrowers before closing the runtime resolver and Store`,
    options,
    async (t) => {
      const f = await businessExecutionFixture(t, backend),
        source = await paidSource(f);
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((yes) => {
          entered = yes;
        }),
        gate = new Promise<void>((yes) => {
          release = yes;
        });
      const runtime = await f.openWorker({
        installedPluginExecution: queryConfig(f),
      });
      const host = runtime.pluginQueryHost;
      assert.ok(host);
      const registration = await host.resolveRegistration({ actor, source });
      assert.ok(registration);
      const order: string[] = [],
        queryClose = host.close.bind(host),
        acquire = StoreBackedAgentVersionRuntimeResolver.prototype.acquire,
        resolverClose = StoreBackedAgentVersionRuntimeResolver.prototype.close,
        storePrototype = Object.getPrototypeOf(f.store) as {
          close(): void | Promise<void>;
        },
        storeClose = storePrototype.close;
      t.mock.method(
        StoreBackedAgentVersionRuntimeResolver.prototype,
        "acquire",
        async function (
          this: StoreBackedAgentVersionRuntimeResolver,
          locator: Parameters<typeof acquire>[0],
        ) {
          // The original resolver obtains a real prepared runtime lease before the test gate.
          const lease = await acquire.call(this, locator);
          assert.ok(lease);
          assert.equal(
            lease.resource.version.agentVersionId,
            source.binding.target.agentVersionId,
          );
          entered();
          await gate;
          return lease;
        },
      );
      t.mock.method(host, "close", async () => {
        order.push("query:start");
        await queryClose();
        order.push("query:end");
      });
      t.mock.method(
        StoreBackedAgentVersionRuntimeResolver.prototype,
        "close",
        function (this: StoreBackedAgentVersionRuntimeResolver) {
          order.push("resolver");
          return resolverClose.call(this);
        },
      );
      t.mock.method(
        storePrototype,
        "close",
        function (this: typeof storePrototype) {
          order.push("store");
          return storeClose.call(this);
        },
      );
      const evaluating = host.evaluate({
        actor,
        source,
        registration,
        configuration: f.entry.configuration,
        expectedTarget: source.binding.target,
      });
      // Observe rejection immediately so the abort does not become an unhandled rejection.
      const rejected = assert.rejects(evaluating);
      await waiting;
      const closing = runtime.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(order, ["query:start"]);
      release();
      await Promise.all([rejected, closing]);
      assert.deepEqual(order, [
        "query:start",
        "query:end",
        "resolver",
        "store",
      ]);
      await f.closeWorker();
      t.mock.restoreAll();
    },
  );

  test(
    `${backend}: startup failure closes its query host once and preserves the published Store`,
    options,
    async (t) => {
      const f = await businessExecutionFixture(t, backend),
        source = await paidSource(f),
        server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      t.after(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const close = InstalledPluginQueryHost.prototype.close;
      let closes = 0;
      t.mock.method(
        InstalledPluginQueryHost.prototype,
        "close",
        function (this: InstalledPluginQueryHost) {
          closes++;
          return close.call(this);
        },
      );
      await assert.rejects(
        f.openWorker({
          installedPluginExecution: queryConfig(f),
          extensionHost: {
            port: address.port,
            token: "composition-query-private-token-0001",
            resolveActor: async () => actor,
            authorization,
          },
        }),
        /EADDRINUSE/u,
      );
      assert.equal(closes, 1);
      assert.deepEqual(
        await f.extensions.loadExtensionRunBinding(source.binding),
        source.binding,
      );
      assert.equal(f.controls.models.length, 0);
    },
  );
}
