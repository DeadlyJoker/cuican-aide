import { productionPluginUiOwnerConfiguration } from "./production-plugin-ui-owner-configuration.ts";
import { createProductionProjectConversationRuntime } from "./production-project-conversation-runtime.ts";
import { closeResources } from "./production-control-resource-cleanup.ts";
import { createLocalStorageAdmissionOwner } from "@crewon/store";
import {
  ModelPricingApplicationService,
  ModelSpendingApplicationService,
  OfficeThreadApplicationService,
  type StorageAdmissionPort,
  type OutboxRetentionPolicy,
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
  type PluginCreditReadAuthorizationPort,
  type DomainStore,
  type ProjectGenerationReadApplicationService,
  type ModelProviderSettingsStore,
} from "@crewon/application";
import { PostgresDomainStore } from "@crewon/store";
import { isPluginProjectGenerationReadActionBridge } from "@crewon/plugin-host";

import { buildControlApi } from "./control-api.ts";
import { composePluginCreditReads } from "./plugin-credit-read-composition.ts";
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
import {
  captureProductionPluginUiOwnerConfiguration,
  closeProductionProjectQueryOwner,
} from "./project-query-plugin-composition.ts";
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
import { assertProductionProjectPluginUiComposition } from "./production-project-plugin-ui-configuration.ts";
import {
  createProductionProjectTextPluginRuntime,
  captureProductionProjectTextOwnerCleanup,
  type ProductionProjectTextPluginRuntime,
} from "./production-project-text-plugin-runtime.ts";
import {
  createProductionCreativeProjectPluginRuntime,
  type ProductionCreativeProjectPluginRuntime,
} from "./production-creative-project-plugin-runtime.ts";
import { type ProductionProjectGenerationReadPluginRuntime } from "./production-project-generation-read-plugin-runtime.ts";
import {
  closeProductionProjectSelectionOwner,
  composeOwnedProjectGenerationSelectionService,
} from "./project-generation-selection-composition.ts";
import type { ProductionProjectGenerationSelectionPluginRuntime } from "./production-project-generation-selection-plugin-runtime.ts";
import type { ProjectConceptSelectionApplicationService } from "@crewon/application";
import {
  assertProductionPluginUiRecoveryConfiguration,
  capturePluginUiRecoveryConfiguration,
  composeProductionPluginUiRecoveryHistory,
  type PluginUiRecoveryConfiguration,
  type ProductionPluginUiRecoveryRuntime,
} from "./plugin-ui-recovery-composition.ts";

export type ProductionPostgresControlApiConfig = Readonly<{
  storageAdmission?: StorageAdmissionPort;
  localStoragePaths?: readonly string[];
  connectionString: string;
  schema?: string;
  maxPoolSize?: number;
  statementTimeoutMs?: number;
  identity: ControlApiIdentityPort;
  authorization: AuthorizationPort & AutomationAuthorizationPort;
  pluginCreditAuthorization?: PluginCreditReadAuthorizationPort;
  heartbeatIntervalMs?: number | null;
  outboxScanIntervalMs?: number | null;
  outboxRetention?: OutboxRetentionPolicy | null;
  artifactRetention?: ArtifactRetentionPolicy | null;
  automationScanIntervalMs?: number | null;
  artifactStore: ArtifactStorePort;
  artifactEncryptionKeyId: string;
  providerProbeWorkers?: TenantProviderProbeWorkerRegistry;
  creativeProjects?: CreativeProjectCompositionConfig;
  uiRecovery?: PluginUiRecoveryConfiguration;
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
  const closeOwnedProjectTexts = captureProductionProjectTextOwnerCleanup(
    config.pluginUi,
  );
  const ownedProjectGenerationActions =
    config.pluginUi?.ownedProjectGenerationActions;
  const ownedCreativeProjectActions =
    config.pluginUi?.ownedCreativeProjectActions;
  const ownedProjectGenerationReadActions =
    config.pluginUi?.ownedProjectGenerationReadActions;
  let store: PostgresDomainStore | undefined;
  try {
    validateProductionConfig(config);
    const uiRecovery = capturePluginUiRecoveryConfiguration(config.uiRecovery);
    const creativeProjects = captureCreativeProjectCompositionConfig(
      config.creativeProjects,
    );
    assertProductionPluginUiRecoveryConfiguration(
      { ...config, creativeProjects },
      uiRecovery,
    );
    assertProductionProjectPluginUiComposition(config, creativeProjects);
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
      uiRecovery,
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
            pluginUi: captureProductionPluginUiOwnerConfiguration(
              config.pluginUi,
            ),
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
    try {
      await closeProductionProjectSelectionOwner(
        config.pluginUi?.ownedProjectSelectionActions,
      );
    } catch (failure) {
      failures.push(failure);
    }
    try {
      await closeProductionProjectQueryOwner(
        config.pluginUi?.ownedProjectQueryActions,
      );
    } catch (failure) {
      failures.push(failure);
    }
    if (
      isPluginProjectGenerationReadActionBridge(
        ownedProjectGenerationReadActions,
      )
    )
      try {
        await ownedProjectGenerationReadActions.close();
      } catch (failure) {
        failures.push(failure);
      }
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
      await closeOwnedProjectTexts();
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
  let conversations: ReturnType<
    typeof createProductionProjectConversationRuntime
  >;
  let initializePluginUi: (() => void) | undefined;
  let artifactMaintenance: ArtifactRetentionMaintenance | undefined;
  let pluginUiRuntime: ProductionPluginUiRuntime | undefined;
  let pluginUiRecovery: ProductionPluginUiRecoveryRuntime | undefined;
  let pluginTaskRuntime: InstalledPluginTaskRuntime | undefined;
  let pluginConfigurationRuntime:
    | InstalledPluginConfigurationRuntime
    | undefined;
  let pluginInstallationRuntime:
    | ProductionPluginInstallationRuntime
    | undefined;
  let projectPluginRuntime: ProductionCreativeProjectPluginRuntime | undefined;
  let projectTextPluginRuntime: ProductionProjectTextPluginRuntime | undefined;
  let projectGenerationReadPluginRuntime:
    | ProductionProjectGenerationReadPluginRuntime
    | undefined;
  let projectSelectionPluginRuntime:
    | ProductionProjectGenerationSelectionPluginRuntime
    | undefined;
  let projectSelections: ProjectConceptSelectionApplicationService | undefined;
  let projectGenerationReads:
    | ProjectGenerationReadApplicationService
    | undefined;
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
    if (creativeProjects?.textUi !== undefined && config.pluginUi !== undefined)
      projectTextPluginRuntime = createProductionProjectTextPluginRuntime({
        projects: creativeProjects,
        ui: config.pluginUi.configuration,
        identity: config.identity as ProductionControlApiIdentity,
        ...(projectPluginRuntime === undefined
          ? {}
          : { hostUiServices: projectPluginRuntime.hostUiServices }),
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
            ...((projectTextPluginRuntime?.hostUiServices ??
              projectPluginRuntime?.hostUiServices) === undefined
              ? {}
              : {
                  metadataHostUiServices:
                    (projectTextPluginRuntime?.hostUiServices ??
                      projectPluginRuntime?.hostUiServices)!,
                }),
          },
        );
      }
      if (
        creativeProjects?.conversationFoundation !== undefined &&
        config.pluginUi !== undefined
      )
        conversations = createProductionProjectConversationRuntime({
          projects: creativeProjects,
          store,
          ui: config.pluginUi.configuration,
          identity: config.identity as ProductionControlApiIdentity,
          registry,
          tasks: () => pluginTaskRuntime,
          clock,
          digester,
          ...((pluginTaskRuntime?.projectQueries?.hostUiServices ??
            pluginTaskRuntime?.projectGenerations?.hostUiServices ??
            projectTextPluginRuntime?.hostUiServices ??
            projectPluginRuntime?.hostUiServices) === undefined
            ? {}
            : {
                fallback: (pluginTaskRuntime?.projectQueries?.hostUiServices ??
                  pluginTaskRuntime?.projectGenerations?.hostUiServices ??
                  projectTextPluginRuntime?.hostUiServices ??
                  projectPluginRuntime?.hostUiServices)!,
              }),
        });
      const existingHostUiServices =
        conversations?.hostUiServices ??
        pluginTaskRuntime?.projectQueries?.hostUiServices ??
        pluginTaskRuntime?.projectGenerations?.hostUiServices ??
        projectTextPluginRuntime?.hostUiServices ??
        projectPluginRuntime?.hostUiServices;
      const history = await composeProductionPluginUiRecoveryHistory({
        config,
        store,
        projects: creativeProjects,
        ui: config.pluginUi?.configuration,
        taskRuntime: pluginTaskRuntime,
        configuration: config.pluginConfiguration?.configuration,
        identity: config.identity as ProductionControlApiIdentity,
        authorization: config.authorization,
        clock,
        digester,
        hostUiServices: existingHostUiServices,
      });
      pluginConfigurationRuntime = history.configurationRuntime;
      projectGenerationReads = history.reads;
      projectSelections = history.selections;
      projectGenerationReadPluginRuntime = history.readRuntime;
      projectSelectionPluginRuntime = history.selectionRuntime;
      pluginUiRecovery = history.recovery;
      const hostUiServices = history.hostUiServices;
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
        initializePluginUi = () => {
          pluginUiRuntime = createProductionPluginUiRuntime(
            productionPluginUiOwnerConfiguration({
              configuration: config.pluginUi!,
              conversations: conversations?.owner(),
              texts: projectTextPluginRuntime,
              recovery: pluginUiRecovery?.service,
              selection: projectSelectionPluginRuntime?.owner,
              tasks: pluginTaskRuntime,
              projects: projectPluginRuntime?.owner,
              generationReads: projectGenerationReadPluginRuntime?.owner,
            }),
            {
              ledger,
              clock,
            },
          );
        };
    }
    if (
      config.pluginConfiguration !== undefined &&
      pluginConfigurationRuntime === undefined
    ) {
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
    conversations?.bindThreads(threads);
    initializePluginUi?.();
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
            texts: projectTextPluginRuntime,
            conversations: conversations?.owner(),
            projectGenerations: pluginTaskRuntime?.projectGenerations,
            projectQueries: pluginTaskRuntime?.projectQueries,
            projectGenerationReads: projectGenerationReadPluginRuntime,
            projectSelections: projectSelectionPluginRuntime,
            recovery: pluginUiRecovery,
          });
    const extensionReads =
      pluginTaskRuntime?.extensionReads ??
      pluginConfigurationRuntime?.extensionReads;
    projectGenerationReads ??= pluginTaskRuntime?.projectGenerationReads;
    const generationReadStore =
      projectGenerationReads !== undefined
        ? undefined
        : (creativeProjects?.generationReadStore ??
          (creativeProjects?.pluginGenerations === undefined
            ? undefined
            : await prepareProjectGenerationReadStore(store)));
    projectGenerationReads ??= composeProjectGenerationReadService({
      projects: creativeProjects,
      extensions: generationReadStore,
      tasks: extensionReads,
      digester,
    });
    projectSelections ??= composeOwnedProjectGenerationSelectionService({
      projects: creativeProjects,
      generationReads: projectGenerationReads,
      owner: store,
      authorization: config.authorization,
      clock,
      digester,
    });
    const app = buildControlApi({
      pluginCreditReads: composePluginCreditReads(
        store.pluginCreditStore(),
        config.pluginCreditAuthorization,
      ),
      projectConceptSelections: projectSelections,
      creativeProjects: creativeProjects?.service,
      projectTexts: creativeProjects?.textService,
      projectConversations: conversations?.owner(),
      projectConversationRouting: store.projectConversationStore(),
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
        () => conversations?.close(),
        () => projectPluginRuntime?.close(),
        () => projectTextPluginRuntime?.close(),
        () => projectSelectionPluginRuntime?.close(),
        () => projectGenerationReadPluginRuntime?.close(),
        () => pluginTaskRuntime?.close(),
        () => pluginConfigurationRuntime?.close(),
        () => pluginUiRuntime?.close(),
        () => pluginUiRecovery?.close(),
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
        () => conversations?.close(),
        () => projectPluginRuntime?.close(),
        () => projectTextPluginRuntime?.close(),
        () => projectSelectionPluginRuntime?.close(),
        () => projectGenerationReadPluginRuntime?.close(),
        () => pluginTaskRuntime?.close(),
        () => pluginConfigurationRuntime?.close(),
        () => pluginUiRuntime?.close(),
        () => pluginUiRecovery?.close(),
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

import { ArtifactRetentionMaintenance } from "./artifact-retention-maintenance.ts";
import type { ArtifactRetentionPolicy } from "@crewon/application";
