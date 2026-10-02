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
  type ArtifactStorePort,
  type AutomationAuthorizationPort,
  type AutomationStore,
  type AuthorizationPort,
  type DomainStore,
  type ModelProviderSettingsStore,
} from "@crewon/application";
import { PostgresDomainStore } from "@crewon/store";

import { buildControlApi } from "./control-api.ts";
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
  createProductionPluginUiRuntime,
  type ProductionPluginUiConfig,
  type ProductionPluginUiRuntime,
} from "./production-plugin-ui-composition.ts";

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
  pluginUi?: ProductionPluginUiConfig;
}>;

/**
 * Composes the PostgreSQL Team/Cloud API with request-scoped identity and policy.
 * Missing production authorities fail before the database is opened.
 */
export async function createProductionPostgresControlApi(
  config: ProductionPostgresControlApiConfig,
): Promise<StandaloneControlApiRuntime> {
  validateProductionConfig(config);
  // Capture the pure deployment settings before PostgreSQL's asynchronous open.
  const actions = config.pluginUi?.actions;
  const actionSnapshot =
    actions === undefined
      ? undefined
      : Object.freeze({ invoke: actions.invoke.bind(actions) });
  const productionConfig =
    config.pluginUi === undefined
      ? config
      : {
          ...config,
          pluginUi: Object.freeze({
            configuration: parseProductionPluginUiConfiguration(
              config.pluginUi.configuration,
            ),
            ...(actionSnapshot === undefined
              ? {}
              : { actions: actionSnapshot }),
          }),
        };
  const store = await PostgresDomainStore.open({
    connectionString: config.connectionString,
    schema: config.schema,
    maxPoolSize: config.maxPoolSize,
    statementTimeoutMs: config.statementTimeoutMs,
  });
  try {
    return await composeProductionControlApi(store, productionConfig);
  } catch (error) {
    await store.close();
    throw error;
  }
}

async function composeProductionControlApi(
  store: PostgresDomainStore,
  config: ProductionPostgresControlApiConfig,
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
  try {
    artifactMaintenance = new ArtifactRetentionMaintenance(
      config.artifactStore.retention,
      store,
      config.artifactRetention,
    );
    const clock = new SystemApplicationClock();
    const digester = new NodeSha256ContentDigester();
    if (config.pluginUi !== undefined) {
      const ledger = store.pluginInstallationStore();
      // Plugin installation history has an explicit independent schema version.
      await ledger.migrate();
      pluginUiRuntime = createProductionPluginUiRuntime(config.pluginUi, {
        ledger,
        clock,
      });
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
    const app = buildControlApi({
      pluginUi: pluginUiRuntime?.service,
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
      pluginUiRuntime?.close();
      storageCapacity.close();
      await artifactMaintenance!.close();
      await automationScheduler.close();
      await outboxDispatcher.close();
      eventHub.close();
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
      workspaceLists: null,
      workspaceQueries,
    };
  } catch (error) {
    pluginUiRuntime?.close();
    storageCapacity.close();
    void artifactMaintenance?.close();
    void outboxDispatcher.close();
    eventHub.close();
    void config.artifactStore.close();
    void store.close();
    throw error;
  }
}

function validateProductionConfig(
  config: ProductionPostgresControlApiConfig,
): void {
  requireMethod(
    config.identity,
    "resolveActor",
    "production_identity_required",
  );
  requireMethod(
    config.authorization,
    "authorize",
    "production_authorization_required",
  );
  requireMethod(config.artifactStore, "close", "artifact_store_required");
  if (config.pluginUi !== undefined) {
    if (!(config.identity instanceof ProductionControlApiIdentity))
      throw new Error("production_plugin_ui_identity_required");
    parseProductionPluginUiConfiguration(config.pluginUi.configuration);
    if (config.pluginUi.actions !== undefined)
      requireMethod(
        config.pluginUi.actions,
        "invoke",
        "production_plugin_ui_actions_invalid",
      );
  }
  if (config.providerProbeWorkers !== undefined) {
    requireMethod(
      config.providerProbeWorkers,
      "resolve",
      "production_provider_probe_registry_invalid",
    );
  }
  requireBounded(
    config.connectionString,
    8 * 1_024,
    "production_database_url_invalid",
  );
  requireBounded(
    config.artifactEncryptionKeyId,
    512,
    "artifact_encryption_key_id_invalid",
  );
}

function requireMethod(value: unknown, method: string, code: string): void {
  if (
    value === null ||
    typeof value !== "object" ||
    !(method in value) ||
    typeof (value as Record<string, unknown>)[method] !== "function"
  ) {
    throw new Error(code);
  }
}

function requireBounded(value: unknown, maximum: number, code: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new Error(code);
  }
}
import { ArtifactRetentionMaintenance } from "./artifact-retention-maintenance.ts";
import type { ArtifactRetentionPolicy } from "@crewon/application";
