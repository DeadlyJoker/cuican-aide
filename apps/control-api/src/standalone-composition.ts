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
  ExtensionConfigurationApplicationService,
  ExtensionTaskApplicationService,
  ExtensionReadApplicationService,
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
): Promise<StandaloneControlApiRuntime> {
  let client: ExtensionHostRouter | null = null;
  let prepared: PreparedControlExtensions | undefined;
  try {
    client = new ExtensionHostRouter(worker);
    const catalog = await client.loadCatalog(config.actor);
    const extensions = store.extensionStore();
    await extensions.migrate();
    const operations = store.externalOperationStore();
    await operations.migrate();
    prepared = { client, catalog, extensions, operations };
    return composeControlApi(store, config, prepared);
  } catch (error) {
    await closeOwners(
      [
        () =>
          prepared?.failureCleanup ??
          prepared?.earlyFailureCleanup?.() ??
          config.artifactStore.close(),
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
): StandaloneControlApiRuntime {
  const storageCapacity = createLocalStorageAdmissionOwner({
    configured: config.storageAdmission,
    paths: config.localStoragePaths ?? [],
  });
  const eventHub = new RunEventHub();
  if (preparedExtensions !== undefined) {
    preparedExtensions.earlyFailureCleanup = () =>
      closeOwners([
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
    const extensions =
      preparedExtensions === undefined
        ? undefined
        : new ExtensionConfigurationApplicationService({
            store: preparedExtensions.extensions,
            catalog: preparedExtensions.catalog,
            host: preparedExtensions.client,
            authorization,
            clock,
            digester,
          });
    const extensionTasks =
      preparedExtensions === undefined
        ? undefined
        : new ExtensionTaskApplicationService({
            store,
            extensions: preparedExtensions.extensions,
            operations: preparedExtensions.operations,
            catalog: preparedExtensions.catalog,
            host: preparedExtensions.client,
            queryHost: preparedExtensions.client.queryHost,
            ...(config.pluginQueryHost === undefined
              ? {}
              : { pluginQueryHost: config.pluginQueryHost }),
            authorization,
            clock,
            ids,
            digester,
          });
    const extensionReads =
      preparedExtensions === undefined
        ? undefined
        : new ExtensionReadApplicationService({
            runs: store,
            agentVersions: store,
            extensions: preparedExtensions.extensions,
            operations: preparedExtensions.operations,
            catalog: preparedExtensions.catalog,
            host: preparedExtensions.client,
            authorization,
            digester,
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
      identity: new StandaloneIdentity({
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
      if (preparedExtensions !== undefined) {
        await closeOwners([
          () => storageCapacity.close(),
          () => artifactMaintenance!.close(),
          () => automationScheduler!.close(),
          () => outboxDispatcher.close(),
          () => eventHub.close(),
          () => workspaceWorker?.close(),
          () => preparedExtensions.client.close(),
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
    if (preparedExtensions !== undefined) {
      preparedExtensions.failureCleanup = closeOwners([
        () => storageCapacity.close(),
        () => artifactMaintenance?.close(),
        () => automationScheduler?.close(),
        () => outboxDispatcher.close(),
        () => eventHub.close(),
        () => workspaceWorker?.close(),
        () => config.artifactStore.close(),
      ]);
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
