import {
  AgentVersionApplicationService,
  AgentVersionCatalogApplicationService,
  ArtifactApplicationService,
  AutomationApplicationService,
  CompatibleAutomationScheduleCalculator,
  KnowledgeApplicationService,
  OfficeApplicationService,
  OfficeDelegationApplicationService,
  RunApplicationService,
  ThreadApplicationService,
  ThreadGoalApplicationService,
  WorkspaceOperationQueryService,
  ThreadRollbackApplicationService,
  ToolApprovalApplicationService,
  TurnApplicationService,
  ThreadCompactionApplicationService,
  ModelProviderSettingsApplicationService,
  WorkflowVersionApplicationService,
  WorkflowRunApplicationService,
  WorkflowHumanGateApplicationService,
  type ArtifactStorePort,
  type AutomationAuthorizationPort,
  type AutomationStore,
  type AuthorizationPort,
  type DomainStore,
  type ModelProviderSettingsStore,
} from "@crewon/application";
import { PostgresDomainStore } from "@crewon/store";

import { buildControlApi } from "./control-api.ts";
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

export type ProductionPostgresControlApiConfig = Readonly<{
  connectionString: string;
  schema?: string;
  maxPoolSize?: number;
  statementTimeoutMs?: number;
  identity: ControlApiIdentityPort;
  authorization: AuthorizationPort & AutomationAuthorizationPort;
  heartbeatIntervalMs?: number | null;
  outboxScanIntervalMs?: number | null;
  artifactStore: ArtifactStorePort;
  artifactEncryptionKeyId: string;
  providerProbeWorkers?: TenantProviderProbeWorkerRegistry;
}>;

/**
 * Composes the PostgreSQL Team/Cloud API with request-scoped identity and policy.
 * Missing production authorities fail before the database is opened.
 */
export async function createProductionPostgresControlApi(
  config: ProductionPostgresControlApiConfig,
): Promise<StandaloneControlApiRuntime> {
  validateProductionConfig(config);
  const store = await PostgresDomainStore.open({
    connectionString: config.connectionString,
    schema: config.schema,
    maxPoolSize: config.maxPoolSize,
    statementTimeoutMs: config.statementTimeoutMs,
  });
  try {
    return await composeProductionControlApi(store, config);
  } catch (error) {
    await store.close();
    throw error;
  }
}

async function composeProductionControlApi(
  store: PostgresDomainStore,
  config: ProductionPostgresControlApiConfig,
): Promise<StandaloneControlApiRuntime> {
  const eventHub = new RunEventHub();
  const ids = new UuidV7ApplicationIdGenerator();
  const outboxDispatcher = new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: `outbox:${ids.nextId("outboxLease")}`,
      nextLeaseId: () => ids.nextId("outboxLease"),
      scanIntervalMs: config.outboxScanIntervalMs,
    },
  );
  try {
    const clock = new SystemApplicationClock();
    const digester = new NodeSha256ContentDigester();
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
    });
    const threads = new ThreadApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
      digester,
    });
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
    const officeDelegations = new OfficeDelegationApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
      digester,
      routeResolver,
    });
    const automations = new AutomationApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
      digester,
      routeResolver,
      scheduleCalculator: new CompatibleAutomationScheduleCalculator(),
    });
    const knowledge = new KnowledgeApplicationService({
      store,
      authorization: config.authorization,
      clock,
      ids,
      digester,
    });
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
      application,
      offices,
      officeDelegations,
      threads,
      goals,
      turns,
      compactions,
      rollbacks,
      approvals,
      agentVersions,
      workflowVersions,
      workflowRuns: new WorkflowRunApplicationService({
        store,
        authorization: config.authorization,
        clock,
        ids,
        workflowDigester: digester,
        routeResolver,
      }),
      workflowHumanGates: new WorkflowHumanGateApplicationService({
        store: {
          async loadRun(input) {
            const run = await store.loadRun(input);
            if (run === null) return null;
            return {
              ...run,
              purpose: run.purpose ?? "turn",
              workflowVersionBinding: run.workflowVersionBinding ?? undefined,
            };
          },
          recordWorkflowHumanGateDecision: (input) =>
            store.recordWorkflowHumanGateDecision(input),
        },
        authorization: config.authorization,
        digester,
      }),
      agentVersionCatalogs,
      artifacts,
      automations,
      knowledge,
      workspaceLists: null,
      workspaceQueries,
      providerSettings,
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
    });
    outboxDispatcher.start();
    app.addHook("onClose", async () => {
      await outboxDispatcher.close();
      eventHub.close();
      await config.artifactStore.close();
      await store.close();
    });
    return {
      app,
      eventHub,
      outboxDispatcher,
      providerProbes,
      workspaceLists: null,
      workspaceQueries,
    };
  } catch (error) {
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
