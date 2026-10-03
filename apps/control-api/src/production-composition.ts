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
  WorkspaceOperationQueryService,
  ThreadRollbackApplicationService,
  ToolApprovalApplicationService,
  TurnApplicationService,
  ThreadCompactionApplicationService,
  ModelProviderSettingsApplicationService,
  OfficeApplicationService,
  WorkflowVersionApplicationService,
  isPluginCreativeProjectActionOwner,
  type ArtifactStorePort,
  type AutomationAuthorizationPort,
  type AutomationStore,
  type AuthorizationPort,
  type DomainStore,
  type ModelProviderSettingsStore,
} from "@crewon/application";
import { PostgresDomainStore } from "@crewon/store";

import { buildControlApi } from "./control-api.ts";
import {
  composeProjectGenerationReadService,
  prepareProjectGenerationReadStore,
} from "./project-generation-read-composition.ts";
import { AutomationScheduler } from "./automation-scheduler.ts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import {
  ProductionAgentVersionRunRouteResolver,
  ProductionStoreReadiness,
} from "./production-adapters.ts";
import { RunEventHub } from "./run-event-hub.ts";
import {
  NodeSha256ContentDigester,
  StoreBackedAgentVersionAdmission,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";
import type { StandaloneControlApiRuntime } from "./standalone-composition.ts";
import {
  ControlProviderProbeService,
  TenantRoutedProviderProbeWorker,
  UnavailableTenantProviderProbeWorkerRegistry,
  type TenantProviderProbeWorkerRegistry,
} from "./provider-probe-worker-client.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import {
  captureProductionPluginUiActions,
  createProductionPluginUiRuntime,
  type ProductionPluginUiConfig,
  type ProductionPluginUiRuntime,
} from "./production-plugin-ui-composition.ts";
import { isInstalledPluginTaskActionOwner } from "./installed-plugin-task-action-owner.ts";
import { isInstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";
import { validateProductionConfig } from "./production-configuration-validation.ts";
import { assertProjectGenerationExecutionComposition } from "./project-generation-plugin-configuration.ts";
import {
  parseProductionPluginInstallationConfiguration,
  type ProductionPluginInstallationConfiguration,
} from "./production-plugin-installation-environment.ts";
import {
  createProductionPluginSourceRegistry,
  type ProductionPluginSourceRegistry,
} from "./production-plugin-source-registry.ts";
import {
  createProductionPluginInstallationRuntime,
  type ProductionPluginInstallationRuntime,
} from "./production-plugin-installation-runtime.ts";
import { type InstalledPluginTaskConfiguration } from "./installed-plugin-task-environment.ts";
import {
  createInstalledPluginTaskRuntime,
  type InstalledPluginTaskRuntime,
} from "./installed-plugin-task-composition.ts";
import { type InstalledPluginConfigurationConfig } from "./installed-plugin-configuration-environment.ts";
import {
  createInstalledPluginConfigurationRuntime,
  type InstalledPluginConfigurationRuntime,
} from "./installed-plugin-configuration-composition.ts";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";
import {
  captureCreativeProjectCompositionConfig,
  prepareCreativeProjects,
  type CreativeProjectCompositionConfig,
} from "./creative-project-composition.ts";
import { assertCreativeProjectPluginPublications } from "./creative-project-plugin-ui-composition.ts";
import {
  createProductionCreativeProjectPluginRuntime,
  type ProductionCreativeProjectPluginRuntime,
} from "./production-creative-project-plugin-runtime.ts";

export type ProductionPostgresControlApiConfig = Readonly<{
  storageAdmission?: StorageAdmissionPort;
  localStoragePaths?: readonly string[];
  connectionString: string;
  schema?: string;
  maxPoolSize?: number;
  statementTimeoutMs?: number;
  identity: ControlApiIdentityPort;
  authorization: AuthorizationPort & AutomationAuthorizationPort;
  heartbeatIntervalMs?: number | null;
  outboxScanIntervalMs?: number | null;
  outboxRetention?: OutboxRetentionPolicy | null;
  artifactRetention?: ArtifactRetentionPolicy | null;
  automationScanIntervalMs?: number | null;
  artifactStore: ArtifactStorePort;
  artifactEncryptionKeyId: string;
  providerProbeWorkers?: TenantProviderProbeWorkerRegistry;
  creativeProjects?: CreativeProjectCompositionConfig;
  pluginUi?: ProductionPluginUiConfig;
  pluginConfiguration?: Readonly<{
    configuration: InstalledPluginConfigurationConfig;
  }>;
  pluginTasks?: Readonly<{ configuration: InstalledPluginTaskConfiguration }>;
  pluginInstallation?: Readonly<{
    configuration: ProductionPluginInstallationConfiguration;
  }>;
}>;

/**
 * Composes the PostgreSQL Team/Cloud API with request-scoped identity and policy.
 * Missing production authorities fail before the database is opened.
 */
export async function createProductionPostgresControlApi(
  config: ProductionPostgresControlApiConfig,
): Promise<StandaloneControlApiRuntime> {
  const ownedTaskActions = config.pluginUi?.ownedTaskActions;
  const ownedProjectGenerationActions =
    config.pluginUi?.ownedProjectGenerationActions;
  const ownedCreativeProjectActions =
    config.pluginUi?.ownedCreativeProjectActions;
  let store: PostgresDomainStore | undefined;
  try {
    validateProductionConfig(config);
    const creativeProjects = captureCreativeProjectCompositionConfig(
      config.creativeProjects,
    );
    assertCreativeProjectPluginPublications(
      creativeProjects?.pluginUi,
      config.pluginUi?.configuration.publications,
    );
    assertProjectGenerationExecutionComposition({
      generations: creativeProjects?.pluginGenerations,
      publications: config.pluginUi?.configuration.publications,
      taskConfiguration: config.pluginTasks,
      uiConfiguration: config.pluginUi,
      ownedActions: ownedProjectGenerationActions,
    });
    if (
      creativeProjects?.pluginUi !== undefined &&
      ownedCreativeProjectActions !== undefined
    )
      throw new Error("creative_project_plugin_actions_conflict");
    // Capture the pure deployment settings before PostgreSQL's asynchronous open.
    const actions = config.pluginUi?.actions;
    const actionSnapshot =
      actions === undefined
        ? undefined
        : Object.freeze({ invoke: actions.invoke.bind(actions) });
    const committedTasks = config.pluginUi?.committedTasks;
    const committedSnapshot =
      committedTasks === undefined
        ? undefined
        : Object.freeze({
            isOutcome: committedTasks.isOutcome.bind(committedTasks),
            verify: committedTasks.verify.bind(committedTasks),
          });
    const pluginInstallation =
      config.pluginInstallation === undefined
        ? undefined
        : Object.freeze({
            configuration: parseProductionPluginInstallationConfiguration(
              config.pluginInstallation.configuration,
            ),
          });
    const productionConfig = Object.freeze({
      ...config,
      creativeProjects,
      ...(config.pluginConfiguration === undefined
        ? {}
        : {
            pluginConfiguration: Object.freeze({
              configuration: config.pluginConfiguration.configuration,
            }),
          }),
      ...(config.pluginTasks === undefined
        ? {}
        : {
            pluginTasks: Object.freeze({
              configuration: config.pluginTasks.configuration,
            }),
          }),
      ...(pluginInstallation === undefined ? {} : { pluginInstallation }),
      ...(config.pluginUi === undefined
        ? {}
        : {
            pluginUi: Object.freeze({
              configuration: parseProductionPluginUiConfiguration(
                config.pluginUi.configuration,
              ),
              ...(actionSnapshot === undefined
                ? {}
                : { actions: actionSnapshot }),
              ...(committedSnapshot === undefined
                ? {}
                : { committedTasks: committedSnapshot }),
              ...(ownedTaskActions === undefined ? {} : { ownedTaskActions }),
              ...(ownedProjectGenerationActions === undefined
                ? {}
                : { ownedProjectGenerationActions }),
              ...(ownedCreativeProjectActions === undefined
                ? {}
                : { ownedCreativeProjectActions }),
            }),
          }),
    });
    const registry =
      pluginInstallation === undefined
        ? undefined
        : await createProductionPluginSourceRegistry(
            pluginInstallation.configuration,
          );
    store = await PostgresDomainStore.open({
      connectionString: config.connectionString,
      schema: config.schema,
      maxPoolSize: config.maxPoolSize,
      statementTimeoutMs: config.statementTimeoutMs,
    });
    return await composeProductionControlApi(store, productionConfig, registry);
  } catch (error) {
    const failures: unknown[] = [];
    if (isInstalledPluginProjectGenerationOwner(ownedProjectGenerationActions))
      try {
        await ownedProjectGenerationActions.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    if (isInstalledPluginTaskActionOwner(ownedTaskActions))
      try {
        await ownedTaskActions.close();
      } catch (failure) {
        failures.push(failure);
      }
    if (isPluginCreativeProjectActionOwner(ownedCreativeProjectActions))
      try {
        await ownedCreativeProjectActions.close();
      } catch (failure) {
        failures.push(failure);
      }
    try {
      await store?.close();
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "production_plugin_ui_startup_cleanup_failed",
      );
    throw error;
  }
}

async function composeProductionControlApi(
  store: PostgresDomainStore,
  config: ProductionPostgresControlApiConfig,
  registry: ProductionPluginSourceRegistry | undefined,
): Promise<StandaloneControlApiRuntime> {
  const storageCapacity = createLocalStorageAdmissionOwner({
    configured: config.storageAdmission,
    paths: config.localStoragePaths ?? [],
  });
  const eventHub = new RunEventHub();
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
  let artifactMaintenance: ArtifactRetentionMaintenance | undefined;
  let pluginUiRuntime: ProductionPluginUiRuntime | undefined;
  let pluginTaskRuntime: InstalledPluginTaskRuntime | undefined;
  let pluginConfigurationRuntime:
    | InstalledPluginConfigurationRuntime
    | undefined;
  let pluginInstallationRuntime:
    | ProductionPluginInstallationRuntime
    | undefined;
  let projectPluginRuntime: ProductionCreativeProjectPluginRuntime | undefined;
  try {
    artifactMaintenance = new ArtifactRetentionMaintenance(
      config.artifactStore.retention,
      store,
      config.artifactRetention,
    );
    const clock = new SystemApplicationClock();
    const digester = new NodeSha256ContentDigester();
    const creativeProjects = await prepareCreativeProjects(
      store,
      config.creativeProjects,
    );
    if (
      creativeProjects?.pluginUi !== undefined &&
      config.pluginUi !== undefined
    )
      projectPluginRuntime = createProductionCreativeProjectPluginRuntime({
        projects: creativeProjects,
        ui: config.pluginUi.configuration,
        identity: config.identity as ProductionControlApiIdentity,
      });
    if (
      config.pluginUi !== undefined ||
      config.pluginInstallation !== undefined
    ) {
      const ledger = store.pluginInstallationStore();
      // Plugin installation history has an explicit independent schema version.
      await ledger.migrate();
      // The actual generation dispatcher must exist before installation recovery validates its declared Host service.
      if (config.pluginTasks !== undefined && config.pluginUi !== undefined) {
        pluginTaskRuntime = await createInstalledPluginTaskRuntime(
          {
            configuration: config.pluginTasks.configuration,
            uiConfiguration: config.pluginUi.configuration,
          },
          {
            store,
            identity: config.identity as ProductionControlApiIdentity,
            authorization: config.authorization,
            clock,
            ids,
            digester,
            ...(creativeProjects === undefined ? {} : { creativeProjects }),
            ...(projectPluginRuntime === undefined
              ? {}
              : {
                  metadataHostUiServices: projectPluginRuntime.hostUiServices,
                }),
          },
        );
      }
      const hostUiServices =
        pluginTaskRuntime?.projectGenerations?.hostUiServices ??
        projectPluginRuntime?.hostUiServices;
      if (config.pluginInstallation !== undefined) {
        if (registry === undefined)
          throw new Error("production_plugin_source_registry_required");
        pluginInstallationRuntime =
          await createProductionPluginInstallationRuntime(
            {
              configuration: config.pluginInstallation.configuration,
              registry,
            },
            {
              ledger,
              clock,
              digester,
              ...(hostUiServices === undefined ? {} : { hostUiServices }),
            },
          );
      }
      if (config.pluginUi !== undefined)
        pluginUiRuntime = createProductionPluginUiRuntime(
          {
            ...config.pluginUi,
            ...(pluginTaskRuntime === undefined
              ? {}
              : { ownedTaskActions: pluginTaskRuntime.owner }),
            ...(pluginTaskRuntime?.projectGenerations === undefined
              ? {}
              : {
                  ownedProjectGenerationActions:
                    pluginTaskRuntime.projectGenerations,
                }),
            ...(projectPluginRuntime === undefined
              ? {}
              : { ownedCreativeProjectActions: projectPluginRuntime.owner }),
          },
          {
            ledger,
            clock,
          },
        );
    }
    if (config.pluginConfiguration !== undefined) {
      pluginConfigurationRuntime =
        await createInstalledPluginConfigurationRuntime(
          config.pluginConfiguration.configuration,
          {
            store,
            identity: config.identity as ProductionControlApiIdentity,
            authorization: config.authorization,
            clock,
            digester,
          },
        );
    }
    const workflowVersionStore = store.workflowVersionStore(digester);
    await workflowVersionStore.migrate();
    const application = new RunApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
    });
    const offices = new OfficeApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
      digester,
    });
    const threads = new ThreadApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
      digester,
    });
    const officeThreads = new OfficeThreadApplicationService({
      store,
      offices,
      threads,
      authorization: config.authorization,
      clock,
      ids,
      digester,
    });
    const taskChanges = new ThreadTaskChangeQueryService({ store, threads });
    const turns = new TurnApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
      digester,
    });
    const compactions = new ThreadCompactionApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
    });
    const rollbacks = new ThreadRollbackApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
    });
    const approvals = new ToolApprovalApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
    });
    const agentVersions = new AgentVersionApplicationService({
      store,
      authorization: config.authorization,
    });
    const workflowVersions = new WorkflowVersionApplicationService({
      store: workflowVersionStore,
      agentVersions: store,
      authorization: config.authorization,
      digester,
      now: () => clock.now(),
    });
    const routeResolver = new ProductionAgentVersionRunRouteResolver({
      agentVersions,
      releases: store,
      digester,
      admission: new StoreBackedAgentVersionAdmission(store),
    });
    const automations = new AutomationApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
      digester,
      routeResolver,
    });
    const automationScheduler = new AutomationScheduler(
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
      authorization: config.authorization,
      clock,
      ids,
      digester,
      routeResolver,
    });
    const agentVersionCatalogs = new AgentVersionCatalogApplicationService({
      store,
      authorization: config.authorization,
    });
    const artifacts = new ArtifactApplicationService({
      store: config.artifactStore,
      authorization: config.authorization,
      clock,
      ids,
      digester,
      encryptionKeyId: config.artifactEncryptionKeyId,
    });
    const providerSettings = new ModelProviderSettingsApplicationService({
      store,
      authorization: config.authorization,
      digester,
    });
    const providerProbes = new ControlProviderProbeService({
      settings: providerSettings,
      workers: new TenantRoutedProviderProbeWorker(
        // The tenant registry remains a private vertical foundation. Public
        // Team probing stays unavailable until the production coordinator,
        // approved tenant egress policy, and authenticated Worker transport
        // are deployed as one authority boundary.
        new UnavailableTenantProviderProbeWorkerRegistry(),
      ),
    });
    const workspaceQueries = new WorkspaceOperationQueryService({
      store,
      authorization: config.authorization,
    });
    const pluginUiService: PluginUiControlService | undefined =
      pluginUiRuntime === undefined
        ? undefined
        : createProductionPluginUiRequestService({
            ui: pluginUiRuntime.service,
            taskRequests: pluginTaskRuntime?.requests,
            projects: projectPluginRuntime,
            projectGenerations: pluginTaskRuntime?.projectGenerations,
          });
    const extensionReads =
      pluginTaskRuntime?.extensionReads ??
      pluginConfigurationRuntime?.extensionReads;
    const generationReadStore =
      creativeProjects?.generationReadStore ??
      (creativeProjects?.pluginGenerations === undefined
        ? undefined
        : await prepareProjectGenerationReadStore(store));
    const projectGenerationReads = composeProjectGenerationReadService({
      projects: creativeProjects,
      extensions: generationReadStore,
      tasks: extensionReads,
      digester,
    });
    const app = buildControlApi({
      creativeProjects: creativeProjects?.service,
      projectGenerationReads,
      pluginUi: pluginUiService,
      extensions:
        pluginTaskRuntime?.extensions ?? pluginConfigurationRuntime?.extensions,
      extensionTasks: pluginTaskRuntime?.extensionTasks,
      extensionReads,
      pluginInstallation: pluginInstallationRuntime?.service,
      pluginSources: pluginInstallationRuntime?.service,
      application,
      offices,
      officeThreads,
      threads,
      taskChanges,
      goals,
      turns,
      compactions,
      rollbacks,
      approvals,
      agentVersions,
      workflowVersions,
      agentVersionCatalogs,
      artifacts,
      automations,
      workspaceLists: null,
      workspaceQueries,
      providerSettings,
      modelPricing: new ModelPricingApplicationService({
        store,
        authorization: config.authorization,
      }),
      modelSpending: new ModelSpendingApplicationService({
        store,
        authorization: config.authorization,
      }),
      providerProbes,
      // Team remains fail closed until its coordinator, tenant egress policy,
      // and authenticated Worker transport are deployed together.
      providerRuntimeAvailability: "unavailable",
      agentVersionDigester: digester,
      workflowVersionDigester: digester,
      clock,
      identity: config.identity,
      routeResolver,
      readiness: new ProductionStoreReadiness(store),
      eventHub,
      outboxWakeup: outboxDispatcher,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      storageAdmission: storageCapacity.admission,
    });
    outboxDispatcher.start();
    automationScheduler.start();
    artifactMaintenance.start();
    app.addHook("onClose", async () => {
      await closeResources([
        () => projectPluginRuntime?.close(),
        () => pluginTaskRuntime?.close(),
        () => pluginConfigurationRuntime?.close(),
        () => pluginUiRuntime?.close(),
        () => pluginInstallationRuntime?.close(),
        () => storageCapacity.close(),
        () => artifactMaintenance!.close(),
        () => automationScheduler.close(),
        () => outboxDispatcher.close(),
        () => eventHub.close(),
        () => config.artifactStore.close(),
        () => store.close(),
      ]);
    });
    return {
      app,
      eventHub,
      outboxDispatcher,
      artifactMaintenance,
      automationScheduler,
      providerProbes,
      workspaceLists: null,
      workspaceQueries,
    };
  } catch (error) {
    try {
      await closeResources([
        () => projectPluginRuntime?.close(),
        () => pluginTaskRuntime?.close(),
        () => pluginConfigurationRuntime?.close(),
        () => pluginUiRuntime?.close(),
        () => pluginInstallationRuntime?.close(),
        () => storageCapacity.close(),
        () => artifactMaintenance?.close(),
        () => outboxDispatcher.close(),
        () => eventHub.close(),
        () => config.artifactStore.close(),
      ]);
    } catch (failure) {
      throw new AggregateError(
        [error, failure],
        "production_control_api_startup_cleanup_failed",
      );
    }
    throw error;
  }
}

async function closeResources(
  tasks: readonly (() => void | Promise<void> | undefined)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const task of tasks)
    try {
      await task();
    } catch (failure) {
      failures.push(failure);
    }
  if (failures.length)
    throw new AggregateError(failures, "production_control_api_cleanup_failed");
}

import { ArtifactRetentionMaintenance } from "./artifact-retention-maintenance.ts";
import type { ArtifactRetentionPolicy } from "@crewon/application";
