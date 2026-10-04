import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  TurnApplicationService,
  type AuthorizationPort,
} from "@crewon/application";
import { PluginExecutionPackage } from "@crewon/plugin-host";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import {
  captureInstalledPluginExecutionConfig,
  type InstalledPluginExecutionConfig,
} from "./plugins/installed-plugin-runtime-composition.ts";
import { InstalledPluginRuntimeResolver } from "./plugins/installed-plugin-runtime-resolver.ts";
import { compositionFixture } from "./runtime-composition.test-support.ts";
import { deferred, until } from "./runtime-store-access.test-support.ts";

function executionConfig(installRoot: string): InstalledPluginExecutionConfig {
  return {
    installRoot,
    authorization: {
      authorize: async () =>
        assert.fail("startup and ordinary Runs must not authorize plugins"),
    },
    resolveActor: async () =>
      assert.fail("startup and ordinary Runs must not resolve plugin actors"),
    authorizePackage: async () =>
      assert.fail("startup and ordinary Runs must not approve packages"),
  };
}

function rejectPostgresOpen(t: TestContext) {
  return t.mock.method(PostgresDomainStore, "open", async () =>
    assert.fail("invalid configuration must not open storage"),
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15000,
  };

  test(
    `${backend}: constructed installed execution owner closes once before storage`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      await f.activate();
      f.observeStoreClose();
      const held = deferred();
      const instances = new Set<InstalledPluginRuntimeResolver>();
      let closes = 0;
      const original = InstalledPluginRuntimeResolver.prototype.close;
      t.mock.method(
        InstalledPluginRuntimeResolver.prototype,
        "close",
        async function (this: InstalledPluginRuntimeResolver) {
          assert.ok(this instanceof InstalledPluginRuntimeResolver);
          instances.add(this);
          closes++;
          assert.equal(f.counts.stores, 0);
          await held.promise;
          await original.call(this);
        },
      );
      const runtime = await f.create({
        installedPluginExecution: executionConfig(f.root),
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
        assert.equal(instances.size, 1);
        assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
      } finally {
        held.resolve();
        await runtime.close().catch(() => {});
      }
    },
  );

  test(
    `${backend}: a failure after owner construction reclaims the real owner and preserves the startup error`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      await f.activate();
      f.observeStoreClose();
      let closes = 0;
      const original = InstalledPluginRuntimeResolver.prototype.close;
      t.mock.method(
        InstalledPluginRuntimeResolver.prototype,
        "close",
        async function (this: InstalledPluginRuntimeResolver) {
          assert.ok(this instanceof InstalledPluginRuntimeResolver);
          closes++;
          assert.equal(f.counts.stores, 0);
          await original.call(this);
          throw new Error("fixture_installed_cleanup_failed");
        },
      );
      await assert.rejects(
        f.create({
          installedPluginExecution: executionConfig(f.root),
          leaseDurationMs: 0,
        }),
        /worker_lease_duration_invalid/,
      );
      assert.equal(closes, 1);
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
    },
  );

  test(
    `${backend}: conflicting installed execution sources reject before opening storage and close transferred inputs`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      const open = backend === "postgres" ? rejectPostgresOpen(t) : null;
      f.observeStoreClose();
      let closes = 0;
      await assert.rejects(
        f.create({
          installedPluginExecution: executionConfig(f.root),
          installedPluginRuntimeResolver: {
            acquire: async () => assert.fail("conflicting owner was acquired"),
            close: async () => {
              closes++;
            },
          },
        }),
        /installed_plugin_execution_configuration_conflict/,
      );
      assert.equal(closes, 1);
      assert.equal(open?.mock.callCount() ?? 0, 0);
      assert.equal(existsSync(join(f.root, "control.sqlite")), false);
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 0 });
    },
  );

  test(
    `${backend}: invalid installed execution values reject before storage and reclaim transferred inputs`,
    options,
    async (t) => {
      const invalidValues: ReadonlyArray<{
        name: string;
        fields: Record<string, unknown>;
      }> = [
        { name: "relative install root", fields: { installRoot: "plugins" } },
        { name: "authorization method", fields: { authorization: {} } },
        { name: "actor resolver", fields: { resolveActor: undefined } },
        { name: "publisher approval", fields: { authorizePackage: undefined } },
        {
          name: "candidate publisher approval",
          fields: { authorizeCandidatePackage: "allow" },
        },
        { name: "zero capacity", fields: { maximumRuntimes: 0 } },
        { name: "excess capacity", fields: { maximumRuntimes: 33 } },
        { name: "fractional capacity", fields: { maximumRuntimes: 1.5 } },
      ];
      for (const { name, fields } of invalidValues)
        await t.test(name, async (child) => {
          const f = compositionFixture(child, backend);
          const open =
            backend === "postgres" ? rejectPostgresOpen(child) : null;
          f.observeStoreClose();
          await assert.rejects(
            f.create({
              installedPluginExecution: {
                ...executionConfig(f.root),
                ...fields,
              } as InstalledPluginExecutionConfig,
            }),
            /installed_plugin_execution_configuration_invalid/,
          );
          assert.equal(open?.mock.callCount() ?? 0, 0);
          assert.equal(existsSync(join(f.root, "control.sqlite")), false);
          assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 0 });
        });
    },
  );

  test(
    `${backend}: an ordinary Run completes without loading an installed package or consulting plugin authority`,
    options,
    async (t) => {
      const f = compositionFixture(t, backend);
      const transport = {
        ...f.config.transport,
        async *stream() {
          yield { type: "output.delta" as const, delta: "ordinary completed" };
          yield { type: "completed" as const, checkpoint: null };
        },
      };
      await f.activate({ transport });
      let postgresStore: PostgresDomainStore | undefined;
      if (backend === "postgres") {
        const original = PostgresDomainStore.open;
        t.mock.method(
          PostgresDomainStore,
          "open",
          async (input: Parameters<typeof PostgresDomainStore.open>[0]) => {
            postgresStore = await original.call(PostgresDomainStore, input);
            return postgresStore;
          },
        );
      }
      const packageOpen = t.mock.method(
        PluginExecutionPackage,
        "open",
        async () => assert.fail("ordinary Run must not load installed ESM"),
      );
      const runtime = await f.create({
        transport,
        installedPluginExecution: executionConfig(f.root),
      });
      const store =
        postgresStore ?? new SqliteRunStore(join(f.root, "control.sqlite"));
      try {
        const actor = {
          principalId: "principal-1",
          actorId: "actor-1",
          tenantId: f.config.runtimeTenantId,
          spaceId: "space-1",
        };
        await seedThread(store, { ...actor, threadId: "ordinary-thread" });
        const turns = new TurnApplicationService({
          store,
          authorization: {
            authorize: async () => ({ outcome: "allow" }),
          },
          clock: { now: () => "2026-08-09T00:00:00Z" },
          ids: { nextId: () => randomUUID() },
          digester: {
            sha256: (input: string) =>
              `sha256:${createHash("sha256").update(input).digest("hex")}`,
          },
        });
        const turn = await turns.startTurn(actor, {
          kind: "turn.start",
          idempotencyKey: "ordinary-turn",
          threadId: "ordinary-thread",
          expectedThreadRevision: 1,
          content: "ordinary request",
          requestedAgentVersionId: f.config.route.agentVersionId,
          executionIntent: "none",
          route: f.config.route,
        });
        assert.deepEqual(await runtime.worker.wake(), {
          kind: "completed",
          runId: turn.runState.runId,
        });
        assert.equal(packageOpen.mock.callCount(), 0);
        assert.equal(
          (await store.loadRunInSpace(turn.runState))?.status,
          "completed",
        );
      } finally {
        if (store !== postgresStore) store.close();
        await runtime.close();
      }
    },
  );
}

test("installed execution snapshot retains authority function identities and their receivers", async () => {
  const authorizationCalls: unknown[] = [];
  const actorCalls: unknown[] = [];
  const packageCalls: unknown[] = [];
  const candidatePackageCalls: unknown[] = [];
  const authorization: AuthorizationPort = {
    async authorize(input) {
      authorizationCalls.push(this, input);
      return { outcome: "deny", reasonCode: "fixture_denied" };
    },
  };
  const config = {
    installRoot: "/host/installed-plugins",
    authorization,
    maximumRuntimes: 3,
    async resolveActor(owner: unknown, signal: AbortSignal) {
      actorCalls.push(this, owner, signal);
      return null;
    },
    async authorizePackage(input: unknown, signal: AbortSignal) {
      packageCalls.push(this, input, signal);
      return "deny" as const;
    },
    async authorizeCandidatePackage(input: unknown, signal: AbortSignal) {
      candidatePackageCalls.push(this, input, signal);
      return "deny" as const;
    },
  };
  const captured = captureInstalledPluginExecutionConfig(config);
  config.installRoot = "changed-relative-root";
  config.maximumRuntimes = 0;
  authorization.authorize = async () => assert.fail("replacement authority");
  config.resolveActor = async () => assert.fail("replacement actor resolver");
  config.authorizePackage = async () => assert.fail("replacement publisher");
  config.authorizeCandidatePackage = async () =>
    assert.fail("replacement candidate publisher");
  const signal = new AbortController().signal;
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
  const request: Parameters<AuthorizationPort["authorize"]>[0] = {
    actor,
    action: "run:create",
    resource: {
      kind: "thread",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: "thread-1",
    },
  };
  assert.deepEqual(await captured.authorization.authorize(request), {
    outcome: "deny",
    reasonCode: "fixture_denied",
  });
  assert.equal(await captured.resolveActor(actor, signal), null);
  const packageInput = {} as Parameters<typeof captured.authorizePackage>[0];
  assert.equal(await captured.authorizePackage(packageInput, signal), "deny");
  assert.ok(captured.authorizeCandidatePackage);
  const candidateInput = {} as Parameters<
    typeof captured.authorizeCandidatePackage
  >[0];
  assert.equal(
    await captured.authorizeCandidatePackage(candidateInput, signal),
    "deny",
  );
  assert.deepEqual(authorizationCalls, [authorization, request]);
  assert.deepEqual(actorCalls, [config, actor, signal]);
  assert.deepEqual(packageCalls, [config, packageInput, signal]);
  assert.deepEqual(candidatePackageCalls, [config, candidateInput, signal]);
  assert.equal(captured.installRoot, "/host/installed-plugins");
  assert.equal(captured.maximumRuntimes, 3);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.authorization), true);
});

test(
  "postgres: real storage wait cannot replace captured installed execution roots or authority methods",
  {
    skip: !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15000,
  },
  async (t) => {
    const f = compositionFixture(t, "postgres");
    await f.activate();
    const config = {
      ...executionConfig(f.root),
      authorization: { ...executionConfig(f.root).authorization },
      maximumRuntimes: 1,
    };
    const opening = deferred();
    const opened = deferred();
    const original = PostgresDomainStore.open;
    const open = t.mock.method(
      PostgresDomainStore,
      "open",
      async (input: Parameters<typeof PostgresDomainStore.open>[0]) => {
        opened.resolve();
        await opening.promise;
        return original.call(PostgresDomainStore, input);
      },
    );
    const creating = f.create({ installedPluginExecution: config });
    try {
      await opened.promise;
      config.installRoot = "changed-relative-root";
      config.maximumRuntimes = 0;
      Object.assign(config.authorization, { authorize: undefined });
      Object.assign(config, {
        resolveActor: undefined,
        authorizePackage: undefined,
      });
      opening.resolve();
      const runtime = await creating;
      try {
        assert.equal(open.mock.callCount(), 1);
        assert.deepEqual(await runtime.worker.wake(), { kind: "idle" });
      } finally {
        await runtime.close();
      }
    } finally {
      opening.resolve();
      await creating.then((runtime) => runtime.close()).catch(() => {});
    }
  },
);
