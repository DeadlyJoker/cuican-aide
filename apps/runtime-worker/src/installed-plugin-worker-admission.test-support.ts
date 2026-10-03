import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ExtensionConfigurationApplicationService,
  ExtensionTaskApplicationService,
  ThreadApplicationService,
  TurnApplicationService,
  type AuthorizationPort,
} from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { InstalledPluginExtensionHost } from "./plugins/installed-plugin-extension-host.ts";
import {
  installedPluginReleaseDigester as digester,
  type InstalledPluginReleaseDocument,
} from "./plugins/installed-plugin-release-document.ts";
import {
  loadInstalledPluginRelease,
  verifyInstalledPluginRelease,
} from "./plugins/installed-plugin-release-loader.ts";
import { resolveRuntimeBootstrapRoute } from "./runtime-bootstrap-defaults.ts";
import {
  installedProcessActor as actor,
  installedProcessScope as scope,
  type InstalledWorkerProcessFixture,
} from "./installed-plugin-worker-process.test-support.ts";

/** Named test authority and test funding are confined to admission setup; the actual child has neither port. */
export async function prepareInstalledProcessTasks(
  fixture: InstalledWorkerProcessFixture,
  document: InstalledPluginReleaseDocument,
  count: 1 | 2 = 2,
) {
  const store = new SqliteRunStore(fixture.databasePath);
  const extensions = store.extensionStore(),
    installations = store.pluginInstallationStore();
  await extensions.migrateCredits();
  await extensions.migratePluginAdmissions();
  const credits = store.pluginCreditStore();
  await credits.migrate();
  const operations = store.externalOperationStore();
  await operations.migrate();
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "explicit-process-fixture-funds",
  };
  await credits.grant({
    scope: creditScope,
    grantId: "explicit-process-fixture-grant",
    credits: "1000",
  });
  const authorization: AuthorizationPort = {
    async authorize(input) {
      assert.deepEqual(input.actor, actor);
      assert.equal(input.resource.tenantId, actor.tenantId);
      return { outcome: "allow" };
    },
  };
  const loaded = await loadInstalledPluginRelease({
    document,
    installRoot: fixture.installRoot,
    environment: fixture.environment,
    authorizeRead: async () => "allow",
  });
  await verifyInstalledPluginRelease({ release: loaded, store });
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    registry,
    factory: loaded.factory,
    digester,
  });
  const host = new InstalledPluginExtensionHost({
    scope,
    registrations: loaded.registrations,
    installRoot: fixture.installRoot,
    installations,
    authorization,
    resolveActor: async () => actor,
    resolveProfile: async () => scope,
    authorizePackage: async (input) => {
      assert.deepEqual(input.scope, scope);
      assert.ok(
        document.entries.some(
          (entry) =>
            entry.packageIdentity.packageDigest ===
            input.candidate.packageDigest,
        ),
      );
      return "allow";
    },
    runtimeResolver: resolver,
    deployments: store,
  });
  const clock = { now: () => new Date().toISOString() },
    ids = { nextId: () => randomUUID() };
  let quotes = 0;
  const catalog = {
    list: () => loaded.registrations,
    resolve: (identity: { pluginId: string; pluginVersion: string }) =>
      loaded.registrations.find(
        (registration) =>
          registration.identity.pluginId === identity.pluginId &&
          registration.identity.version === identity.pluginVersion,
      ) ?? null,
  };
  const configurationService = new ExtensionConfigurationApplicationService({
    store: extensions,
    catalog,
    host,
    authorization,
    clock,
    digester,
  });
  const threads = new ThreadApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester,
  });
  const tasks = new ExtensionTaskApplicationService({
    store,
    extensions,
    operations,
    catalog,
    host,
    authorization,
    clock,
    ids,
    digester,
    creditQuotes: {
      async quoteGeneration(input) {
        quotes++;
        assert.deepEqual(input.actor, actor);
        return {
          poolId: creditScope.poolId,
          priceRevision: 1,
          quotedCredits: "30",
        };
      },
    },
  });
  const admitted = [];
  try {
    for (const [index, entry] of document.entries.slice(0, count).entries()) {
      const current = await installations.loadSelection({
        scope,
        pluginId: entry.packageIdentity.pluginId,
      });
      assert.ok(current);
      const selected = await installations.commitSelection({
        scope,
        actor,
        expectedSelectionRevision: current.revision,
        selection: {
          ...current,
          revision: current.revision + 1,
          state: "enabled",
          selectedPackageDigest: entry.packageIdentity.packageDigest,
          updatedAt: clock.now(),
          updatedByPrincipalId: actor.principalId,
          updatedByActorId: actor.actorId,
        },
        receipt: {
          idempotencyKey: `explicit-process-fixture-enable-${index}`,
          requestDigest: digester.sha256(`enable-${index}`),
        },
      });
      const activation = await extensions.loadExtensionActivation({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        pluginId: entry.packageIdentity.pluginId,
      });
      await configurationService.setActivation(actor, {
        pluginId: entry.packageIdentity.pluginId,
        configurationRevision: entry.configuration.revision,
        expectedRevision: activation?.revision ?? 0,
        idempotencyKey: `explicit-process-fixture-activate-${index}`,
        state: "enabled",
        agentVersionId: entry.version.agentVersionId,
      });
      const thread = await threads.createThread(actor, {
        kind: "thread.create",
        idempotencyKey: `explicit-process-fixture-thread-${index}`,
        title: null,
      });
      const pin = parsePluginTaskAdmissionPin({
        ...actor,
        ...scope,
        ...entry.packageIdentity,
        selectionRevision: selected.selection.revision,
        contributionId: "example.professional.workbench",
        action: "report.generate",
        authorityEpoch: "explicit-process-fixture-policy-v1",
      });
      const task = await tasks.createTaskFromPlugin(
        actor,
        {
          pluginId: entry.packageIdentity.pluginId,
          threadId: thread.state.threadId,
          expectedThreadRevision: thread.state.revision,
          idempotencyKey: `explicit-process-fixture-task-${index}`,
          intent: {
            kind: "generate",
            input: { subject: "Actual formal Worker fixture report" },
          },
        },
        pin,
        {
          async assertCurrent({ pin }) {
            const actual = await installations.loadSelection({
              scope,
              pluginId: pin.pluginId,
            });
            assert.equal(actual?.revision, pin.selectionRevision);
            assert.equal(actual?.state, "enabled");
            assert.equal(actual?.selectedPackageDigest, pin.packageDigest);
          },
        },
      );
      assert.deepEqual(task.binding.target, entry.target);
      admitted.push(task);
    }
    const thread = await threads.createThread(actor, {
      kind: "thread.create",
      idempotencyKey: "explicit-process-fixture-default-thread",
      title: null,
    });
    const original = await new TurnApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
    }).startTurn(actor, {
      kind: "turn.start",
      idempotencyKey: "explicit-process-fixture-default-turn",
      threadId: thread.state.threadId,
      expectedThreadRevision: thread.state.revision,
      content: "Use the unchanged default Agent.",
      requestedAgentVersionId: null,
      executionIntent: "none",
      route: resolveRuntimeBootstrapRoute(fixture.environment),
    });
    return { admitted, original, quotes };
  } finally {
    await host.close();
    resolver.close();
    await registry.close();
    await loaded.close();
    await store.close();
  }
}
