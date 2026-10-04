import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  ApplicationError,
  ExtensionConfigurationApplicationService,
  ExtensionReadApplicationService,
  ExtensionTaskApplicationService,
  type ActorContext,
  type AuthorizationPort,
  type ExtensionHostPort,
} from "@crewon/application";
import { extensionCanonicalJson, parseExtensionManifest } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { extensionManifestFixture } from "../../../packages/domain/src/extension-manifest.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { errorResponse } from "./control-api-errors.ts";
import { composeDesktopPluginExtensionServices } from "./desktop-plugin-extension-composition.ts";
import {
  actor,
  target,
  nativeTaskAuthorityFixture,
  nativeTaskDeferred,
  nativeTaskDigester as digester,
} from "./desktop-installed-plugin-task-authority.test-support.ts";
import { registerExtensionReadRoutes } from "./extension-read-route.ts";
import { projectExtensionTask } from "./extension-task-projection.ts";
import {
  createInstalledPluginTaskRuntimeCore,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";

const nativeOnly = { skip: process.platform === "win32", timeout: 20_000 };
const legacyPluginId = "test.mixed-legacy-reader";
const operationId = "77777777-2222-3333-4444-555555555555";
type PolicyRequest = Parameters<AuthorizationPort["authorize"]>[0];
type TaskArguments = Parameters<ExtensionReadApplicationService["getTask"]>;
type Observation = Readonly<{
  reader: ExtensionReadApplicationService;
  method: "getCatalog" | "getRuntime" | "getTask";
}>;

function observeOriginalReaders(t: TestContext, observations: Observation[]) {
  const catalog = ExtensionReadApplicationService.prototype.getCatalog;
  const runtime = ExtensionReadApplicationService.prototype.getRuntime;
  const task = ExtensionReadApplicationService.prototype.getTask;
  t.mock.method(
    ExtensionReadApplicationService.prototype,
    "getCatalog",
    function (
      this: ExtensionReadApplicationService,
      ...args: Parameters<typeof catalog>
    ) {
      observations.push({ reader: this, method: "getCatalog" });
      return catalog.apply(this, args);
    },
  );
  t.mock.method(
    ExtensionReadApplicationService.prototype,
    "getRuntime",
    function (
      this: ExtensionReadApplicationService,
      ...args: Parameters<typeof runtime>
    ) {
      observations.push({ reader: this, method: "getRuntime" });
      return runtime.apply(this, args);
    },
  );
  t.mock.method(
    ExtensionReadApplicationService.prototype,
    "getTask",
    function (
      this: ExtensionReadApplicationService,
      ...args: Parameters<typeof task>
    ) {
      observations.push({ reader: this, method: "getTask" });
      return task.apply(this, args);
    },
  );
}

/** Composition coverage only: real Native installation/request owner and actual shared
 * core, plus a separate SQLite legacy Application Run in the same explicit actor/space.
 * Readiness/PDP boundaries are named offline fixtures; Native Main task acceptance is
 * verified separately. Every reader observer delegates the original implementation. */
async function fixture(t: TestContext) {
  let core: InstalledPluginTaskRuntimeCore | undefined;
  let legacyStore: SqliteRunStore | undefined;
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await core?.close();
    await legacyStore?.close();
  });
  const native = await nativeTaskAuthorityFixture(t);
  const observations: Observation[] = [];
  observeOriginalReaders(t, observations);
  core = await createInstalledPluginTaskRuntimeCore({
    store: native.store,
    requests: native.owner.requests,
    installRoot: native.binding.configuration.installRoot,
    maximumPackages: native.binding.tasks.publication.maximumPackages,
    publications: native.binding.tasks.publication.uiPublications,
    profiles: native.owner.profiles,
    businessAuthorization: native.owner.businessAuthorization,
    uiAuthorization: native.owner.uiAuthorization,
    authorizePackage: native.owner.authorizePackage,
    creditQuotes: native.owner.creditQuotes,
    clock: native.clock,
    ids: { nextId: () => randomUUID() },
    digester,
  });
  const actualCore = core;
  assert.equal(actualCore.requests, native.installed.requests);
  legacyStore = new SqliteRunStore(
    join(native.root, "mixed-legacy-reader.sqlite"),
  );
  const store = legacyStore;
  const extensions = store.extensionStore();
  await extensions.migrate();
  const operations = store.externalOperationStore();
  await operations.migrate();
  const manifest = parseExtensionManifest(
    extensionManifestFixture(legacyPluginId),
  );
  const registration = {
    manifest,
    manifestDigest: digester.sha256(extensionCanonicalJson(manifest)),
    implementationDigest: digester.sha256(
      "named-offline-legacy-implementation",
    ),
  };
  const catalog = {
    list: () => [registration],
    resolve: (
      identity: Readonly<{ pluginId: string; pluginVersion: string }>,
    ) =>
      identity.pluginId === manifest.pluginId &&
      identity.pluginVersion === manifest.version
        ? registration
        : null,
  };
  const host: ExtensionHostPort = {
    validateConfiguration: async () => {},
    evaluate: async () => ({ outcome: "ready", target }),
  };
  const allow: AuthorizationPort = {
    authorize: async () => ({ outcome: "allow" }),
  };
  const configurationDependencies = {
    store: extensions,
    catalog,
    host,
    authorization: allow,
    clock: native.clock,
    digester,
  };
  const configurations = new ExtensionConfigurationApplicationService(
    configurationDependencies,
  );
  await configurations.saveConfiguration(actor, {
    pluginId: legacyPluginId,
    pluginVersion: manifest.version,
    expectedRevision: 0,
    idempotencyKey: "mixed-legacy-first-configuration",
    parameters: { format: "mp4" },
    credentialBindings: [
      {
        slotId: "provider",
        credentialBindingId: "named-offline-legacy-credential",
      },
    ],
  });
  await store.registerAgentVersion({
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId: actor.tenantId,
    agentVersionId: target.agentVersionId,
    contentDigest: target.agentVersionContentDigest,
    createdAt: native.clock.now(),
    definitionJson: JSON.stringify({
      schemaVersion: "crewon.agent-version.v0",
      agentVersionId: target.agentVersionId,
      runtimeGeneration: target.runtimeGeneration,
      policySnapshotId: target.policySnapshotId,
    }),
  });
  const releaseId = digester.sha256("named-offline-mixed-reader-release");
  await store.activateAgentVersionRelease({
    bundle: {
      schemaVersion: "crewon.agent-version-release-bundle.v0",
      tenantId: actor.tenantId,
      releaseId,
      manifestDigest: releaseId,
      defaultAgentVersionId: target.agentVersionId,
      deployments: [
        {
          schemaVersion: "crewon.agent-version-deployment.v0",
          tenantId: actor.tenantId,
          agentVersionId: target.agentVersionId,
          contentDigest: target.agentVersionContentDigest,
          materializationDigest: target.materializationDigest,
          authorityId: target.authorityId,
          workspaceBindingId: target.workspaceBindingId,
        },
      ],
    },
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: actor.tenantId,
      releaseId,
      activationId: "mixed-reader-legacy-release-activation",
      previousReleaseId: null,
      operator: {
        principalId: actor.principalId,
        actorId: actor.actorId,
        spaceId: actor.spaceId,
      },
      activatedAt: native.clock.now(),
    },
    expectedActiveReleaseId: null,
  });
  await configurations.setActivation(actor, {
    pluginId: legacyPluginId,
    configurationRevision: 1,
    expectedRevision: 0,
    idempotencyKey: "mixed-legacy-first-activation",
    state: "enabled",
    agentVersionId: target.agentVersionId,
  });
  const threadId = "mixed-reader-actual-legacy-thread";
  await seedThread(store, { ...actor, threadId });
  const admitted = await new ExtensionTaskApplicationService({
    ...configurationDependencies,
    store,
    extensions,
    operations,
    ids: { nextId: () => randomUUID() },
  }).createTask(actor, {
    pluginId: legacyPluginId,
    threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "mixed-reader-actual-legacy-task",
    intent: {
      kind: "generate",
      input: { prompt: "Named offline legacy read task" },
    },
  });
  await operations.reserveExternalOperation({
    tenantId: actor.tenantId,
    runId: admitted.binding.runId,
    bindingDigest: admitted.binding.bindingDigest,
    operationId,
    executionId: "mixed-reader-existing-tool",
    idempotencyKey: "mixed-reader-existing-operation",
    actionDigest: digester.sha256("mixed-reader-offline-action"),
    requestDigest: digester.sha256("mixed-reader-offline-request"),
    correlationId: operationId,
    createdAt: native.clock.now(),
  });
  const state = {
    policies: [] as PolicyRequest[],
    onPolicy: null as ((input: PolicyRequest) => Promise<void>) | null,
    onNamespace: null as
      | ((
          value: Readonly<{ actor: ActorContext; pluginId: string }>,
        ) => Promise<void>)
      | null,
    namespaceCalls: [] as Readonly<{ actor: ActorContext; pluginId: string }>[],
    activationReads: 0,
    onActivation: null as ((readNumber: number) => Promise<void>) | null,
  };
  const authorize: AuthorizationPort = {
    authorize: async (input) => {
      assert.deepEqual(input.actor, actor);
      assert.deepEqual(native.installed.requests.currentActor(), actor);
      state.policies.push(structuredClone(input));
      await state.onPolicy?.(input);
      return { outcome: "allow" };
    },
  };
  const originalActivation =
    extensions.loadExtensionActivation.bind(extensions);
  t.mock.method(
    extensions,
    "loadExtensionActivation",
    async (...args: Parameters<typeof originalActivation>) => {
      const result = await originalActivation(...args);
      state.activationReads++;
      await state.onActivation?.(state.activationReads);
      return result;
    },
  );
  const ownsNamespace = async (
    currentActor: ActorContext,
    pluginId: string,
  ) => {
    const captured = structuredClone({ actor: currentActor, pluginId });
    state.namespaceCalls.push(captured);
    await state.onNamespace?.(captured);
    assert.deepEqual(currentActor, actor);
    return (
      native.binding.configuration.sources.some(
        (source) => source.pluginId === pluginId,
      ) ||
      (await native.installation.service.getSelection(currentActor, {
        pluginId,
      })) !== null
    );
  };
  const services = composeDesktopPluginExtensionServices({
    installed: native.installed,
    tasks: actualCore,
    approvedPluginIds: [native.source.pluginId],
    ownsNamespace,
    legacyConfiguration: configurationDependencies,
    legacyReads: {
      runs: store,
      agentVersions: store,
      extensions,
      operations,
      catalog,
      host,
      authorization: authorize,
      digester,
    },
  });
  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });
  registerExtensionReadRoutes(app, {
    extensionReads: services.extensionReads,
    identity: native.identity,
  });
  const url = `/api/v1/extensions/${legacyPluginId}/tasks/${admitted.binding.runId}`;
  const headers = native.request().headers;
  const httpRead = (path = url) =>
    app.inject({ method: "GET", url: path, headers });
  /** The current Native writer accepts only its fixed approved sources, whose
   * namespaces are already reserved at startup. Unknown namespace installation
   * cannot legitimately race this reader. Withdraw the real authority instead;
   * its original verified installation and durable audit remain unchanged. */
  async function withdrawNativeAuthority() {
    const ledger = native.store.pluginInstallationStore();
    const selectionLocator = {
      scope: native.binding.configuration.scope,
      pluginId: native.source.pluginId,
    };
    const packageLocator = {
      scope: native.binding.configuration.scope,
      packageDigest: native.source.packageDigest,
    };
    const beforeSelection = await ledger.loadSelection(selectionLocator);
    const beforePackage = await ledger.loadPackage(packageLocator);
    assert.ok(beforeSelection);
    assert.ok(beforePackage);
    native.authority.withdraw();
    assert.deepEqual(
      await ledger.loadSelection(selectionLocator),
      beforeSelection,
    );
    assert.deepEqual(await ledger.loadPackage(packageLocator), beforePackage);
  }
  observations.length = 0;
  native.calls.length = 0;
  native.peerCalls.length = 0;
  return {
    native,
    core: actualCore,
    services,
    state,
    observations,
    admitted,
    httpRead,
    withdrawNativeAuthority,
  };
}

function assertNoNativeTaskFallback(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(
    f.observations.filter(
      ({ reader, method }) =>
        method === "getTask" &&
        (reader === f.core.extensionReads ||
          reader === f.native.installed.extensionReads),
    ).length,
    0,
  );
  assert.equal(f.native.calls.length, 0);
  assert.equal(f.native.peerCalls.length, 0);
}

test(
  "mixed reader keeps the actual SQLite legacy task projection under the signed Native configuration request owner",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    const response = await f.httpRead();
    assert.equal(response.statusCode, 200, response.body);
    const task = response.json().task;
    assert.equal(task.runId, f.admitted.binding.runId);
    assert.equal(task.pluginId, legacyPluginId);
    assert.equal(task.runStatus, "queued");
    assert.deepEqual(task.operations, [
      {
        operationId,
        sourceRunId: task.runId,
        status: "submitting",
        observedAt: f.native.clock.now(),
        images: [],
      },
    ]);
    assertNoNativeTaskFallback(f);
    assert.ok(
      f.state.policies.some(({ action }) => action === "extension:query"),
    );
  },
);

test(
  "mixed legacy task rejects actual Native authority withdrawal immediately after its pending extension query PDP without reading activation storage",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    const entered = nativeTaskDeferred(),
      release = nativeTaskDeferred();
    f.state.onPolicy = async ({ action }) => {
      if (action !== "extension:query") return;
      f.state.onPolicy = null;
      entered.resolve();
      await release.promise;
    };
    const pending = f.httpRead();
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("legacy_query_finished_before_pdp_gate");
        }),
      ]);
      await f.withdrawNativeAuthority();
      release.resolve();
      const response = await pending;
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(f.state.activationReads, 0);
      assertNoNativeTaskFallback(f);
    } finally {
      release.resolve();
      await pending;
    }
  },
);

test(
  "mixed legacy task rejects actual Native authority withdrawal after its final activation storage await within the signed owner scope without installed reader fallback",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    const entered = nativeTaskDeferred(),
      release = nativeTaskDeferred();
    f.state.onActivation = async (readNumber) => {
      if (readNumber !== 3) return;
      entered.resolve();
      await release.promise;
    };
    // Exercise routing's own final fence, rather than relying on the HTTP GET
    // wrapper's independent final identity/profile recheck to reject the read.
    const pending = f.native.run(async () => {
      await assert.rejects(
        f.services.extensionReads.getTask(actor, {
          pluginId: legacyPluginId,
          runId: f.admitted.binding.runId,
        }),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.category === "authorization",
      );
      return "reader_rejected_within_signed_owner_scope";
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("legacy_query_finished_before_last_activation_read");
        }),
      ]);
      await f.withdrawNativeAuthority();
      release.resolve();
      assert.equal(await pending, "reader_rejected_within_signed_owner_scope");
      assert.equal(f.state.activationReads, 3);
      assertNoNativeTaskFallback(f);
      await assert.rejects(
        f.native.run(async () => {
          throw new Error("withdrawn_owner_reached_new_callback");
        }),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.category === "authorization",
      );
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  },
);

test(
  "mixed reader captures actor plugin and Run before its first namespace await",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    const entered = nativeTaskDeferred(),
      release = nativeTaskDeferred();
    f.state.onNamespace = async () => {
      f.state.onNamespace = null;
      entered.resolve();
      await release.promise;
    };
    const callerActor = { ...actor };
    const input: TaskArguments[1] = {
      pluginId: legacyPluginId,
      runId: f.admitted.binding.runId,
    };
    const pending = f.native.run(() =>
      f.services.extensionReads.getTask(callerActor, input),
    );
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("legacy_query_finished_before_namespace_gate");
        }),
      ]);
      Object.assign(callerActor, {
        principalId: "changed-principal",
        actorId: "changed-actor",
        tenantId: "changed-tenant",
        spaceId: "changed-space",
      });
      Object.assign(input, {
        pluginId: f.native.source.pluginId,
        runId: "changed-run",
      });
      release.resolve();
      const task = projectExtensionTask(await pending).task;
      assert.equal(task.runId, f.admitted.binding.runId);
      assert.equal(task.pluginId, legacyPluginId);
      assert.ok(
        f.state.namespaceCalls.every(
          (call) =>
            call.pluginId === legacyPluginId &&
            extensionCanonicalJson(call.actor) ===
              extensionCanonicalJson(actor),
        ),
      );
      assertNoNativeTaskFallback(f);
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  },
);

test(
  "actual task reader applies only to getTask while catalog and runtime retain the Native metadata reader and no execution preparation",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    const catalog = await f.httpRead("/api/v1/extensions");
    assert.equal(catalog.statusCode, 200, catalog.body);
    assert.deepEqual(
      catalog
        .json()
        .extensions.map((entry: { pluginId: string }) => entry.pluginId)
        .sort(),
      [legacyPluginId, f.native.source.pluginId].sort(),
    );
    const runtime = await f.httpRead(
      `/api/v1/extensions/${f.native.source.pluginId}/runtime?agentVersionId=${target.agentVersionId}&configurationRevision=${f.native.configuration.revision}`,
    );
    assert.equal(runtime.statusCode, 403, runtime.body);
    assert.ok(
      f.observations.some(
        ({ reader, method }) =>
          reader === f.native.installed.extensionReads &&
          method === "getCatalog",
      ),
    );
    assert.ok(
      f.observations.some(
        ({ reader, method }) =>
          reader === f.native.installed.extensionReads &&
          method === "getRuntime",
      ),
    );
    assert.equal(
      f.observations.some(({ reader }) => reader === f.core.extensionReads),
      false,
    );
    assert.equal(f.native.calls.length, 0);
    assert.equal(f.native.peerCalls.length, 0);
    const missing = await f.httpRead(
      `/api/v1/extensions/${f.native.source.pluginId}/tasks/named-missing-native-run`,
    );
    assert.equal(missing.statusCode, 404, missing.body);
    assert.equal(
      f.observations.filter(
        ({ reader, method }) =>
          reader === f.core.extensionReads && method === "getTask",
      ).length,
      1,
    );
    assert.equal(
      f.observations.filter(
        ({ reader, method }) =>
          reader === f.native.installed.extensionReads && method === "getTask",
      ).length,
      0,
    );
    assert.ok(f.native.calls.some(({ role }) => role === "task"));
    assert.equal(
      f.native.calls.some(({ role }) => role === "quote" || role === "package"),
      false,
    );
    assert.equal(f.native.peerCalls.length, 0);
  },
);

test(
  "a reader call without the issued signed Native request scope remains denied",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.services.extensionReads.getTask(actor, {
        pluginId: legacyPluginId,
        runId: f.admitted.binding.runId,
      }),
      (error: unknown) =>
        error instanceof ApplicationError && error.category === "authorization",
    );
    assertNoNativeTaskFallback(f);
  },
);
