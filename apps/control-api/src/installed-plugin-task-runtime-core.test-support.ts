import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ExtensionConfigurationApplicationService,
  ExtensionTaskApplicationService,
  PluginUiApplicationService,
  type ActorContext,
  type CommitExtensionTurnResult,
  type PluginUiJsonValue,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import { LocalPluginUiPackageReader } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import { InstalledPluginConfigurationMetadata } from "./installed-plugin-configuration-metadata.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { createInstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import {
  actor,
  commandInput,
  creditScope,
  ownedActionFixture,
  scope,
} from "./installed-plugin-task-action-owner.test-support.ts";
import {
  generationAction,
  installedGenerationFixture,
} from "./installed-plugin-project-generation-owner.test-support.ts";
import {
  installedProjectQueryFixture,
  queryAction,
} from "./installed-plugin-project-query-owner.test-support.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

export { actor, creditScope, scope };
export type CoreFixtureMode = "task" | "generation" | "query";

/** Real installed Node/UI bytes, original SQLite Application transactions and personal
 * credits. Identity, profile, peer readiness, policy and quote are named offline fixtures;
 * this never grants Native Main opt-in, supplier execution or real funding. */
export async function taskRuntimeCoreFixture(
  t: TestContext,
  options: Readonly<{ mode?: CoreFixtureMode; metadataOnly?: boolean }> = {},
) {
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  let core:
    | Awaited<ReturnType<typeof createInstalledPluginTaskRuntimeCore>>
    | undefined;
  let requests: InstalledPluginRequestOwner | undefined;
  let metadata: InstalledPluginConfigurationMetadata | undefined;
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of [
      () => core?.close(),
      () => requests?.close(),
      () => metadata?.close(),
      ...cleanup,
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "task_core_fixture_cleanup_failed");
  });
  const context = new Proxy(t, {
    get(target, key) {
      if (key === "after")
        return (close: () => unknown | Promise<unknown>) => cleanup.push(close);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const mode = options.mode ?? "task";
  const storage =
    mode === "generation"
      ? await installedGenerationFixture(context, "sqlite")
      : mode === "query"
        ? await installedProjectQueryFixture(context, "sqlite")
        : await ownedActionFixture(context, { backend: "sqlite" });
  assert.ok(storage.first.parent instanceof SqliteRunStore);
  // Retire the fixture's previous owners. Every exercised owner and opaque issuer below is created by core.
  await storage.owner.close();
  if ("taskOwner" in storage) await storage.taskOwner.close();
  const source = "source" in storage ? storage.source : storage.installed;
  const executionPackage =
    "target" in storage ? storage.target : storage.installed;
  const nodeState = "nodeState" in storage ? storage.nodeState : storage.state;
  const state = {
    profile: { ...storage.profile },
    denyUi: false,
    denyPackage: false,
    quoteCalls: 0,
    poolId: creditScope.poolId as string,
    quoteGate: null as Promise<void> | null,
    quoteEntered: null as (() => void) | null,
    peerCalls: 0,
    metadataCalls: 0,
    accepted: [] as CommitExtensionTurnResult[],
    afterCommit: null as
      | ((value: CommitExtensionTurnResult) => Promise<void>)
      | null,
    afterConfigurationRead: null as (() => Promise<void>) | null,
  };
  const token = "named-shared-core-native-session-" + "s".repeat(32);
  const csrf = "named-shared-core-native-csrf-" + "c".repeat(32);
  const origin = "http://127.0.0.1:18479";
  const identity = new StandaloneIdentity({
    actor,
    sessionToken: token,
    csrfToken: csrf,
    allowedOrigins: [origin],
  });
  const profiles = {
    resolve: async (current: ActorContext) => {
      assert.equal(
        extensionCanonicalJson(current),
        extensionCanonicalJson(actor),
      );
      return { ...state.profile };
    },
  };
  const host = {
    ...storage.taskDependencies.host,
    taskAdmissionMode: () => "installed" as const,
  };
  const queryHost =
    "generationReads" in storage
      ? storage.taskInputs.pluginQueryHost
      : {
          async resolveRegistration() {
            throw new Error("named_shared_core_query_not_configured");
          },
          async evaluate() {
            throw new Error("named_shared_core_query_not_configured");
          },
        };
  const preparedPeer = {
    catalog: storage.taskDependencies.catalog,
    host,
    pluginQueryHost: queryHost,
  };
  metadata = new InstalledPluginConfigurationMetadata({
    installRoot: storage.installRoot,
    installations: storage.ledger,
    maximumPackages: 8,
    authorizeRead: async () => (state.denyPackage ? "deny" : "allow"),
  });
  requests = new InstalledPluginRequestOwner({
    identity: {
      resolveCurrentActor: async (request, signal) => {
        signal?.throwIfAborted();
        return identity.resolveActor(request);
      },
    },
    profiles,
    metadata: options.metadataOnly
      ? metadata
      : {
          // Named historical peer metadata fixture; it supplies no task or opaque receipt.
          prepare: async (_input, { signal }) => {
            signal.throwIfAborted();
            state.metadataCalls++;
            return { catalog: preparedPeer.catalog, host: preparedPeer.host };
          },
        },
    ...(options.metadataOnly
      ? {}
      : {
          peer: {
            prepare: async (
              input: { actor: ActorContext; scope: typeof storage.profile },
              { signal }: { signal?: AbortSignal },
            ) => {
              signal?.throwIfAborted();
              assert.equal(
                extensionCanonicalJson(input.actor),
                extensionCanonicalJson(actor),
              );
              assert.equal(
                extensionCanonicalJson(input.scope),
                extensionCanonicalJson(storage.profile),
              );
              state.peerCalls++;
              return preparedPeer;
            },
          },
        }),
  });
  const publications = [
    {
      pluginId: source.descriptor.pluginId,
      packageDigest: source.packageDigest,
    },
  ];
  const creativeProjects =
    "generationReads" in storage
      ? await prepareCreativeProjects(storage.first.parent, {
          authorization: { authorize: async () => ({ outcome: "allow" }) },
          generationReads: { version: "crewon.project-generation-read.v1" },
          pluginQueries: { publications: [storage.publication] },
        })
      : "publication" in storage
        ? await prepareCreativeProjects(storage.first.parent, {
            authorization: { authorize: async () => ({ outcome: "allow" }) },
            pluginGenerations: { publications: [storage.publication] },
          })
        : undefined;
  const coreInput: Parameters<typeof createInstalledPluginTaskRuntimeCore>[0] =
    {
      store: storage.first.parent,
      requests,
      installRoot: storage.installRoot,
      maximumPackages: 8,
      publications,
      profiles,
      businessAuthorization: storage.taskDependencies.authorization,
      uiAuthorization: {
        authorize: async () =>
          state.denyUi
            ? { outcome: "deny", reasonCode: "named_shared_core_ui_denied" }
            : {
                outcome: "allow",
                authorityEpoch: "named-shared-core-source-epoch",
              },
      },
      authorizePackage: async (_input, signal) => {
        signal.throwIfAborted();
        return state.denyPackage ? "deny" : "allow";
      },
      creditQuotes: {
        quoteGeneration: async () => {
          state.quoteCalls++;
          state.quoteEntered?.();
          await state.quoteGate;
          return {
            poolId: state.poolId,
            priceRevision: 1,
            quotedCredits: "30",
          };
        },
      },
      clock: storage.dependencies.clock,
      ids: { nextId: () => randomUUID() },
      digester: extensionStoreDigester,
      ...(creativeProjects === undefined ? {} : { creativeProjects }),
    };
  // Observe only the original actual paid transaction, including its physical result after COMMIT.
  const originalTask =
    ExtensionTaskApplicationService.prototype.createTaskFromPlugin;
  t.mock.method(
    ExtensionTaskApplicationService.prototype,
    "createTaskFromPlugin",
    async function (
      this: ExtensionTaskApplicationService,
      ...args: Parameters<typeof originalTask>
    ) {
      const result = await Reflect.apply(originalTask, this, args);
      if (this === core?.extensionTasks) {
        state.accepted.push(result);
        await state.afterCommit?.(result);
      }
      return result;
    },
  );
  const originalGeneration =
    ExtensionTaskApplicationService.prototype
      .createPublishedProjectTaskFromPlugin;
  t.mock.method(
    ExtensionTaskApplicationService.prototype,
    "createPublishedProjectTaskFromPlugin",
    async function (
      this: ExtensionTaskApplicationService,
      ...args: Parameters<typeof originalGeneration>
    ) {
      const result = await Reflect.apply(originalGeneration, this, args);
      if (this === core?.extensionTasks) {
        state.accepted.push(result);
        await state.afterCommit?.(result);
      }
      return result;
    },
  );
  const originalQuery =
    ExtensionTaskApplicationService.prototype
      .createPublishedProjectQueryTaskFromPlugin;
  t.mock.method(
    ExtensionTaskApplicationService.prototype,
    "createPublishedProjectQueryTaskFromPlugin",
    async function (
      this: ExtensionTaskApplicationService,
      ...args: Parameters<typeof originalQuery>
    ) {
      const result = await Reflect.apply(originalQuery, this, args);
      if (this === core?.extensionTasks) {
        state.accepted.push(result);
        await state.afterCommit?.(result);
      }
      return result;
    },
  );
  const originalConfiguration =
    ExtensionConfigurationApplicationService.prototype.getConfiguration;
  t.mock.method(
    ExtensionConfigurationApplicationService.prototype,
    "getConfiguration",
    async function (
      this: ExtensionConfigurationApplicationService,
      ...args: Parameters<typeof originalConfiguration>
    ) {
      const result = await Reflect.apply(originalConfiguration, this, args);
      if (this === core?.extensions) await state.afterConfigurationRead?.();
      return result;
    },
  );
  core = await createInstalledPluginTaskRuntimeCore(coreInput);
  const runtime = core;
  const borrowed = requests;
  const ui = new PluginUiApplicationService({
    store: storage.ledger,
    profiles,
    authorization: coreInput.uiAuthorization,
    packages: new LocalPluginUiPackageReader({
      profile: storage.profile,
      installRoot: storage.installRoot,
      authorizePublication: async () => ["ui.mjs"],
    }),
    clock: storage.dependencies.clock,
    ids: { nextId: () => randomBytes(32).toString("base64url") },
    actions: (
      runtime.projectQueries ??
      runtime.projectGenerations ??
      runtime.owner
    ).actions,
    committedTasks: runtime.owner.committedTasks,
  });
  const request = (
    headers: ControlApiRequestContext["headers"] = {},
  ): ControlApiRequestContext => ({
    method: "POST",
    url: "/api/v1/plugins/ui/mounts/named-shared-core/actions",
    remoteAddress: "127.0.0.1",
    headers: {
      "authorization": `Bearer ${token}`,
      origin,
      "x-csrf-token": csrf,
      ...headers,
    },
  });
  const lease = await borrowed.run(
    { request: request(), actor, preparation: "configuration" },
    async () => {
      const selection = await storage.ledger.loadSelection({
        scope: storage.profile,
        pluginId: source.descriptor.pluginId,
      });
      assert.ok(selection?.selectedPackageDigest);
      return ui.openMount(actor, {
        pluginId: source.descriptor.pluginId,
        contributionId: "workbench",
        expectedSelectionRevision: selection.revision,
        expectedPackageDigest: selection.selectedPackageDigest,
      });
    },
  );
  const command = {
    action:
      mode === "generation"
        ? generationAction
        : mode === "query"
          ? queryAction
          : "image.generate",
    input: ("request" in storage
      ? storage.request
      : commandInput) as PluginUiJsonValue,
  };
  const invoke = (
    options: Readonly<{
      request?: ControlApiRequestContext;
      actor?: ActorContext;
      signal?: AbortSignal;
    }> = {},
  ) =>
    borrowed.run(
      {
        request: options.request ?? request(),
        actor: options.actor ?? actor,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      () =>
        ui.invoke(options.actor ?? actor, {
          mountRef: lease.mountRef,
          ...command,
        }),
    );
  const effects = async () => ({
    counts: await storage.counts(),
    wallet: await storage.credits.getAccount(creditScope),
  });
  return {
    storage,
    mode,
    source,
    executionPackage,
    nodeState,
    state,
    core: runtime,
    requests: borrowed,
    identity,
    ui,
    metadata,
    coreInput,
    creativeProjects,
    lease,
    command,
    request,
    invoke,
    effects,
  };
}
