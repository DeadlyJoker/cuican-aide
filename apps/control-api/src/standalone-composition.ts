import { ModelPricingApplicationService } from "@crewon/application";
import { ModelSpendingApplicationService } from "@crewon/application";
import { OfficeThreadApplicationService } from "@crewon/application";
import type { StorageAdmissionPort } from "@crewon/application";
import { createLocalStorageAdmissionOwner } from "@crewon/store";
import type { OutboxRetentionPolicy } from "@crewon/application";
import {
  AgentVersionApplicationService,
  AgentVersionCatalogApplicationService,
  ArtifactApplicationService,
  AutomationApplicationService,
  RunApplicationService,
  ThreadApplicationService,
  ThreadTaskChangeQueryService,
  ThreadGoalApplicationService,
  ThreadRollbackApplicationService,
  ToolApprovalApplicationService,
  TurnApplicationService,
  ThreadCompactionApplicationService,
  ModelProviderSettingsApplicationService,
  OfficeApplicationService,
  WorkspaceListApplicationService,
  WorkspaceOperationQueryService,
  WorkflowVersionApplicationService,
  type ActorContext,
  type ArtifactStorePort,
  type AutomationStore,
  type DomainStore,
  type ModelProviderSettingsStore,
  type ExtensionCatalogPort,
  type ExtensionStore,
  type ExternalOperationStore,
  type ExternalOperationQueryStore,
  type PluginQueryHostPort,
} from "@crewon/application";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { FastifyInstance } from "fastify";
import {
  createDesktopPluginRuntime,
  type DesktopPluginRuntime,
} from "./desktop-plugin-runtime.ts";
import {
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import {
  composeStandaloneExtensionServices,
  type DesktopPluginNamespaceMembership,
} from "./desktop-plugin-extension-composition.ts";

import { buildControlApi } from "./control-api.ts";
import { AutomationScheduler } from "./automation-scheduler.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { RunEventHub } from "./run-event-hub.ts";
import {
  AdmittedAgentVersionRunRouteResolver,
  StoreBackedAgentVersionAdmission,
  StandaloneAuthorization,
  StandaloneIdentity,
  StoreReadiness,
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";
import {
  ControlProviderProbeService,
  TenantRoutedProviderProbeWorker,
  UnavailableTenantProviderProbeWorkerRegistry,
  type TenantProviderProbeWorkerRegistry,
} from "./provider-probe-worker-client.ts";
import { LoopbackRuntimeWorkspaceWorkerClient } from "./workspace-runtime-worker-client.ts";
import type { ProcessLocalActivationGate } from "./paused-admission.ts";
import type { ThreadSandboxPort } from "./pim-sandbox-client.ts";
import {
  ExtensionHostRouter,
  parseExtensionWorkerRouterConfig,
  type ExtensionWorkerRouterConfig,
} from "./extension-host-router.ts";

type ExtensionWorkerConfig = ExtensionWorkerRouterConfig;
type PreparedControlExtensions = {
  client: ExtensionHostRouter;
  catalog: ExtensionCatalogPort;
  extensions: ExtensionStore;
  operations: ExternalOperationStore & ExternalOperationQueryStore;
  failureCleanup?: Promise<void>;
  earlyFailureCleanup?: () => Promise<void>;
};
type PreparedControlPlugins = {
  runtime: DesktopPluginRuntime;
  identity: StandaloneIdentity;
  approvedPluginIds: readonly string[];
  ownsNamespace: DesktopPluginNamespaceMembership;
  failureCleanup?: Promise<void>;
};

type ControlApiCompositionConfig = Readonly<{
  storageAdmission?: StorageAdmissionPort;
  localStoragePaths?: readonly string[];
  actor: ActorContext;
  defaultAgentVersionId: string;
  sessionToken: string;
  csrfToken: string;
  allowedOrigins: readonly string[];
  heartbeatIntervalMs?: number | null;
  outboxScanIntervalMs?: number | null;
  outboxRetention?: OutboxRetentionPolicy | null;
  artifactRetention?: ArtifactRetentionPolicy | null;
  automationScanIntervalMs?: number | null;
  artifactStore: ArtifactStorePort;
  artifactEncryptionKeyId: string;
  providerProbeWorkers?: TenantProviderProbeWorkerRegistry;
  sandbox?: ThreadSandboxPort;
  activationGate?: ProcessLocalActivationGate;
  workspaceWorker?: Readonly<{
    origin: string;
    token: string;
    deadlineMs?: number;
  }>;
  /** Borrowed authority port, supplied explicitly by its installed historical runtime owner. */
  pluginQueryHost?: PluginQueryHostPort;
}>;

export type StandaloneControlApiConfig = ControlApiCompositionConfig &
  Readonly<{ databasePath: string }>;

export type PostgresControlApiConfig = ControlApiCompositionConfig &
  Readonly<{
    connectionString: string;
    schema?: string;
    maxPoolSize?: number;
    statementTimeoutMs?: number;
    extensionWorker?: ExtensionWorkerConfig;
  }>;

export type StandaloneControlApiRuntime = Readonly<{
  app: FastifyInstance;
  eventHub: RunEventHub;
  outboxDispatcher: OutboxDispatcher;
  artifactMaintenance: ArtifactRetentionMaintenance;
  automationScheduler: AutomationScheduler;
  providerProbes: ControlProviderProbeService;
  workspaceLists: WorkspaceListApplicationService | null;
  workspaceQueries: WorkspaceOperationQueryService;
}>;

export function createStandaloneControlApi(
  config: StandaloneControlApiConfig,
): StandaloneControlApiRuntime {
  if (config.pluginQueryHost !== undefined)
    throw new Error("installed_plugin_query_requires_extensions");
  const store = new SqliteRunStore(config.databasePath);
  try {
    return composeControlApi(store, {
      ...config,
      localStoragePaths: [
        config.databasePath,
        ...(config.localStoragePaths ?? []),
      ],
    });
  } catch (error) {
    void store.close();
    throw error;
  }
}

/** Explicit async opt-in; the existing synchronous creator keeps plugins unavailable. */
export async function createStandaloneControlApiWithExtensions(
  config: StandaloneControlApiConfig &
    Readonly<{ extensionWorker: ExtensionWorkerConfig }>,
): Promise<StandaloneControlApiRuntime> {
  const pinned = pinExtensionCompositionConfig(config);
  const store = new SqliteRunStore(pinned.databasePath);
  return composeExtensionControlApi(
    store,
    {
      ...pinned,
      localStoragePaths: [
        pinned.databasePath,
        ...(pinned.localStoragePaths ?? []),
      ],
    },
    pinned.extensionWorker,
  );
}

/** Native-approved SQLite opt-in; the old synchronous/default path performs no plugin I/O. */
export async function createStandaloneControlApiWithPlugins(
  config: StandaloneControlApiConfig &
    Readonly<{
      desktopPlugins: DesktopPluginConfiguration;
      extensionWorker?: ExtensionWorkerConfig;
    }>,
): Promise<StandaloneControlApiRuntime> {
  const configuration = parseDesktopPluginConfiguration(config.desktopPlugins);
  if (
    JSON.stringify(configuration.actor) !==
    JSON.stringify({
      principalId: config.actor.principalId,
      actorId: config.actor.actorId,
      tenantId: config.actor.tenantId,
      spaceId: config.actor.spaceId,
    })
  )
    throw new Error("desktop_plugin_owner_mismatch");
  const pinned = pinExtensionCompositionConfig(config);
  const store = new SqliteRunStore(pinned.databasePath);
  let prepared: PreparedControlPlugins | undefined;
  try {
    const identity = new StandaloneIdentity({
      actor: pinned.actor,
      sessionToken: pinned.sessionToken,
      csrfToken: pinned.csrfToken,
      allowedOrigins: pinned.allowedOrigins,
    });
    const runtime = await createDesktopPluginRuntime(
      { configuration },
      {
        store,
        identity,
        clock: new SystemApplicationClock(),
        digester: new NodeSha256ContentDigester(),
      },
    );
    const namespaces = new Set(
      configuration.sources.map((source) => source.pluginId),
    );
    prepared = {
      identity,
      approvedPluginIds: [...namespaces],
      runtime,
      ownsNamespace: async (actor, pluginId) =>
        namespaces.has(pluginId) ||
        (await runtime.installation.getSelection(actor, { pluginId })) !== null,
    };
    const composed = {
      ...pinned,
      localStoragePaths: [
        pinned.databasePath,
        configuration.installRoot,
        ...(pinned.localStoragePaths ?? []),
      ],
    };
    return pinned.extensionWorker === undefined
      ? composeControlApi(store, composed, undefined, prepared)
      : await composeExtensionControlApi(
          store,
          composed,
          pinned.extensionWorker,
          prepared,
        );
  } catch (error) {
    await closeOwners(
      [
        () => prepared?.failureCleanup ?? prepared?.runtime.close(),
        () => config.artifactStore.close(),
        () => store.close(),
      ],
      [error],
    );
    throw error;
  }
}

export async function createPostgresControlApi(
  config: PostgresControlApiConfig,
): Promise<StandaloneControlApiRuntime> {
  if (
    config.pluginQueryHost !== undefined &&
    config.extensionWorker === undefined
  )
    throw new Error("installed_plugin_query_requires_extensions");
  const pinned =
    config.extensionWorker === undefined
      ? config
      : pinExtensionCompositionConfig(config);
  const store = await PostgresDomainStore.open({
    connectionString: pinned.connectionString,
    schema: pinned.schema,
    maxPoolSize: pinned.maxPoolSize,
    statementTimeoutMs: pinned.statementTimeoutMs,
  });
  if (pinned.extensionWorker !== undefined)
    return composeExtensionControlApi(store, pinned, pinned.extensionWorker);
  try {
    return composeControlApi(store, config);
  } catch (error) {
    await store.close();
    throw error;
  }
}

function pinExtensionCompositionConfig<
  T extends ControlApiCompositionConfig & {
    extensionWorker?: ExtensionWorkerConfig;
  },
>(config: T): T {
  return {
    ...config,
    actor: structuredClone(config.actor),
    allowedOrigins: [...config.allowedOrigins],
    localStoragePaths:
      config.localStoragePaths === undefined
        ? undefined
        : [...config.localStoragePaths],
    extensionWorker:
      config.extensionWorker === undefined
        ? undefined
        : parseExtensionWorkerRouterConfig(config.extensionWorker),
    ...(config.pluginQueryHost === undefined
      ? {}
      : { pluginQueryHost: capturePluginQueryHost(config.pluginQueryHost) }),
  };
}
function capturePluginQueryHost(
  port: PluginQueryHostPort,
): PluginQueryHostPort {
  if (
    port === null ||
    typeof port !== "object" ||
    typeof port.resolveRegistration !== "function" ||
    typeof port.evaluate !== "function"
  )
    throw new Error("installed_plugin_query_configuration_invalid");
  return Object.freeze({
    resolveRegistration: port.resolveRegistration.bind(port),
    evaluate: port.evaluate.bind(port),
  });
}

async function composeExtensionControlApi(
  store: SqliteRunStore | PostgresDomainStore,
  config: ControlApiCompositionConfig,
  worker: ExtensionWorkerConfig,
  preparedPlugins?: PreparedControlPlugins,
): Promise<StandaloneControlApiRuntime> {
  let client: ExtensionHostRouter | null = null;
  let prepared: PreparedControlExtensions | undefined;
  try {
    client = new ExtensionHostRouter(worker);
    const catalog = await client.loadCatalog(config.actor);
    if (preparedPlugins !== undefined) {
      for (const entry of catalog.list()) {
        if (
          await preparedPlugins.ownsNamespace(
            config.actor,
            entry.manifest.pluginId,
          )
        )
          throw new Error("desktop_plugin_extension_namespace_conflict");
      }
    }
    const extensions = store.extensionStore();
    await extensions.migrate();
    const operations = store.externalOperationStore();
    await operations.migrate();
    prepared = { client, catalog, extensions, operations };
    return composeControlApi(store, config, prepared, preparedPlugins);
  } catch (error) {
    await closeOwners(
      [
        () =>
          prepared?.failureCleanup ??
          prepared?.earlyFailureCleanup?.() ??
          config.artifactStore.close(),
        () => preparedPlugins?.runtime.close(),
        () => client?.close(),
        () => store.close(),
      ],
      [error],
    );
    throw error;
  }
}

/** Complete cleanup in order even if an owner rejects; startup failures remain visible. */
async function closeOwners(
  owners: readonly (() => void | Promise<void>)[],
  initialErrors: readonly unknown[] = [],
): Promise<void> {
  const errors = [...initialErrors];
  for (const close of owners) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "extension_control_cleanup_failed");
}

function composeControlApi(
  store: SqliteRunStore | PostgresDomainStore,
  config: ControlApiCompositionConfig,
  preparedExtensions?: PreparedControlExtensions,
  preparedPlugins?: PreparedControlPlugins,
): StandaloneControlApiRuntime {
  const storageCapacity = createLocalStorageAdmissionOwner({
    configured: config.storageAdmission,
    paths: config.localStoragePaths ?? [],
  });
  const eventHub = new RunEventHub();
  if (preparedExtensions !== undefined) {
    preparedExtensions.earlyFailureCleanup = () =>
      closeOwners([
        () => preparedPlugins?.runtime.close(),
        () => storageCapacity.close(),
        () => eventHub.close(),
        () => config.artifactStore.close(),
      ]);
  }
  const ids = new UuidV7ApplicationIdGenerator();
  const outboxDispatcher = new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: `outbox:${ids.nextId("outboxLease")}`,
      nextLeaseId: () => ids.nextId("outboxLease"),
      scanIntervalMs: config.outboxScanIntervalMs,
      retention: config.outboxRetention,
    },
  );
  let workspaceWorker: LoopbackRuntimeWorkspaceWorkerClient | null = null;
  let artifactMaintenance: ArtifactRetentionMaintenance | undefined;
  let automationScheduler: AutomationScheduler | undefined;
  try {
    artifactMaintenance = new ArtifactRetentionMaintenance(
      config.artifactStore.retention,
      store,
      config.artifactRetention,
    );
    const authorization = new StandaloneAuthorization(config.actor);
    const clock = new SystemApplicationClock();
    const digester = new NodeSha256ContentDigester();
    const application = new RunApplicationService({
      store,
      authorization,
      clock,
      ids,
    });
    const offices = new OfficeApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
    });
    const threads = new ThreadApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
    });
    const officeThreads = new OfficeThreadApplicationService({
      store,
      offices,
      threads,
      authorization,
      clock,
      ids,
      digester,
    });
    const taskChanges = new ThreadTaskChangeQueryService({ store, threads });
    const turns = new TurnApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
    });
    const { extensions, extensionTasks, extensionReads } =
      composeStandaloneExtensionServices({
        store,
        legacy: preparedExtensions,
        native:
          preparedPlugins === undefined
            ? undefined
            : {
                installed: preparedPlugins.runtime.configuration,
                approvedPluginIds: preparedPlugins.approvedPluginIds,
                ownsNamespace: preparedPlugins.ownsNamespace,
              },
        authorization,
        clock,
        digester,
        ids,
        ...(config.pluginQueryHost === undefined
          ? {}
          : { pluginQueryHost: config.pluginQueryHost }),
      });
    const compactions = new ThreadCompactionApplicationService({
      store,
      authorization,
      clock,
      ids,
    });
    const rollbacks = new ThreadRollbackApplicationService({
      store,
      authorization,
      clock,
      ids,
    });
    const approvals = new ToolApprovalApplicationService({
      store,
      authorization,
      clock,
      ids,
    });
    const agentVersions = new AgentVersionApplicationService({
      store,
      authorization,
    });
    const workflowVersions = new WorkflowVersionApplicationService({
      store: store.workflowVersionStore(digester),
      agentVersions: store,
      authorization,
      digester,
      now: () => clock.now(),
    });
    const routeResolver = new AdmittedAgentVersionRunRouteResolver({
      actor: config.actor,
      defaultAgentVersionId: config.defaultAgentVersionId,
      agentVersions,
      digester,
      admission: new StoreBackedAgentVersionAdmission(store),
    });
    const automations = new AutomationApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
      routeResolver,
    });
    automationScheduler = new AutomationScheduler(
      {
        storageAdmission: storageCapacity.admission,
        automations,
        store,
        threads,
        now: () => clock.now(),
      },
      { scanIntervalMs: config.automationScanIntervalMs },
    );
    const goals = new ThreadGoalApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
      routeResolver,
    });
    const agentVersionCatalogs = new AgentVersionCatalogApplicationService({
      store,
      authorization,
    });
    const artifacts = new ArtifactApplicationService({
      store: config.artifactStore,
      authorization,
      clock,
      ids,
      digester,
      encryptionKeyId: config.artifactEncryptionKeyId,
    });
    const providerSettings = new ModelProviderSettingsApplicationService({
      store,
      authorization,
      digester,
    });
    const providerProbes = new ControlProviderProbeService({
      settings: providerSettings,
      workers: new TenantRoutedProviderProbeWorker(
        config.providerProbeWorkers ??
          new UnavailableTenantProviderProbeWorkerRegistry(),
      ),
    });
    workspaceWorker =
      config.workspaceWorker === undefined
        ? null
        : new LoopbackRuntimeWorkspaceWorkerClient(config.workspaceWorker);
    const workspaceLists =
      workspaceWorker === null
        ? null
        : new WorkspaceListApplicationService({
            store,
            authorization,
            digester,
            commands: workspaceWorker,
            dispatcher: workspaceWorker,
            deliveryOwnerId: `workspace-delivery:${ids.nextId("outboxLease")}`,
            deliveryLeaseDurationMs: Math.max(
              35_000,
              (config.workspaceWorker?.deadlineMs ?? 40_000) + 5_000,
            ),
          });
    const workspaceQueries = new WorkspaceOperationQueryService({
      store,
      authorization,
    });
    const app = buildControlApi({
      application,
      offices,
      officeThreads,
      threads,
      taskChanges,
      goals,
      turns,
      extensions,
      extensionTasks,
      extensionReads,
      pluginInstallation: preparedPlugins?.runtime.installation,
      pluginSources: preparedPlugins?.runtime.sources,
      pluginUi: preparedPlugins?.runtime.ui,
      compactions,
      rollbacks,
      approvals,
      agentVersions,
      workflowVersions,
      agentVersionCatalogs,
      artifacts,
      automations,
      workspaceLists,
      workspaceQueries,
      sandbox: config.sandbox,
      providerSettings,
      modelPricing: new ModelPricingApplicationService({
        store,
        authorization,
      }),
      modelSpending: new ModelSpendingApplicationService({
        store,
        authorization,
      }),
      providerProbes,
      providerRuntimeAvailability:
        config.providerProbeWorkers === undefined ? "unavailable" : "available",
      agentVersionDigester: digester,
      workflowVersionDigester: digester,
      clock,
      identity:
        preparedPlugins?.identity ??
        new StandaloneIdentity({
          actor: config.actor,
          sessionToken: config.sessionToken,
          csrfToken: config.csrfToken,
          allowedOrigins: config.allowedOrigins,
        }),
      routeResolver,
      readiness: new StoreReadiness(store, {
        tenantId: config.actor.tenantId,
        defaultAgentVersionId: config.defaultAgentVersionId,
      }),
      eventHub,
      outboxWakeup: outboxDispatcher,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      activationGate: config.activationGate,
      storageAdmission: storageCapacity.admission,
    });
    outboxDispatcher.start();
    automationScheduler.start();
    artifactMaintenance.start();
    app.addHook("onClose", async () => {
      if (preparedExtensions !== undefined || preparedPlugins !== undefined) {
        await closeOwners([
          () => preparedPlugins?.runtime.close(),
          () => storageCapacity.close(),
          () => artifactMaintenance!.close(),
          () => automationScheduler!.close(),
          () => outboxDispatcher.close(),
          () => eventHub.close(),
          () => workspaceWorker?.close(),
          () => preparedExtensions?.client.close(),
          () => config.artifactStore.close(),
          () => store.close(),
        ]);
        return;
      }
      storageCapacity.close();
      await artifactMaintenance!.close();
      await automationScheduler!.close();
      await outboxDispatcher.close();
      eventHub.close();
      await workspaceWorker?.close();
      await config.artifactStore.close();
      await store.close();
    });
    return {
      app,
      eventHub,
      outboxDispatcher,
      artifactMaintenance,
      automationScheduler,
      providerProbes,
      workspaceLists,
      workspaceQueries,
    };
  } catch (error) {
    if (preparedExtensions !== undefined || preparedPlugins !== undefined) {
      const failureCleanup = closeOwners([
        () => preparedPlugins?.runtime.close(),
        () => storageCapacity.close(),
        () => artifactMaintenance?.close(),
        () => automationScheduler?.close(),
        () => outboxDispatcher.close(),
        () => eventHub.close(),
        () => workspaceWorker?.close(),
        () => config.artifactStore.close(),
      ]);
      if (preparedExtensions !== undefined)
        preparedExtensions.failureCleanup = failureCleanup;
      if (preparedPlugins !== undefined)
        preparedPlugins.failureCleanup = failureCleanup;
      throw error;
    }
    storageCapacity.close();
    void artifactMaintenance?.close();
    void outboxDispatcher.close();
    eventHub.close();
    void workspaceWorker?.close();
    void config.artifactStore.close();
    void store.close();
    throw error;
  }
}
import { ArtifactRetentionMaintenance } from "./artifact-retention-maintenance.ts";
import type { ArtifactRetentionPolicy } from "@crewon/application";
