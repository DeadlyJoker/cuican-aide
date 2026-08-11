import {
  AgentVersionApplicationService,
  AgentVersionCatalogApplicationService,
  ArtifactApplicationService,
  AutomationApplicationService,
  RunApplicationService,
  ThreadApplicationService,
  ThreadGoalApplicationService,
  ThreadRollbackApplicationService,
  ToolApprovalApplicationService,
  TurnApplicationService,
  ThreadCompactionApplicationService,
  ModelProviderSettingsApplicationService,
  WorkspaceListApplicationService,
  WorkspaceOperationQueryService,
  type ActorContext,
  type ArtifactStorePort,
  type AutomationStore,
  type DomainStore,
  type ModelProviderSettingsStore,
} from "@crewon/application";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { FastifyInstance } from "fastify";

import { buildControlApi } from "./control-api.ts";
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

type ControlApiCompositionConfig = Readonly<{
  actor: ActorContext;
  defaultAgentVersionId: string;
  sessionToken: string;
  csrfToken: string;
  allowedOrigins: readonly string[];
  heartbeatIntervalMs?: number | null;
  outboxScanIntervalMs?: number | null;
  artifactStore: ArtifactStorePort;
  artifactEncryptionKeyId: string;
  providerProbeWorkers?: TenantProviderProbeWorkerRegistry;
  activationGate?: ProcessLocalActivationGate;
  workspaceWorker?: Readonly<{
    origin: string;
    token: string;
    deadlineMs?: number;
  }>;
}>;

export type StandaloneControlApiConfig = ControlApiCompositionConfig &
  Readonly<{ databasePath: string }>;

export type PostgresControlApiConfig = ControlApiCompositionConfig &
  Readonly<{
    connectionString: string;
    schema?: string;
    maxPoolSize?: number;
    statementTimeoutMs?: number;
  }>;

export type StandaloneControlApiRuntime = Readonly<{
  app: FastifyInstance;
  eventHub: RunEventHub;
  outboxDispatcher: OutboxDispatcher;
  providerProbes: ControlProviderProbeService;
  workspaceLists: WorkspaceListApplicationService | null;
  workspaceQueries: WorkspaceOperationQueryService;
}>;

export function createStandaloneControlApi(
  config: StandaloneControlApiConfig,
): StandaloneControlApiRuntime {
  const store = new SqliteRunStore(config.databasePath);
  return composeControlApi(store, config);
}

export async function createPostgresControlApi(
  config: PostgresControlApiConfig,
): Promise<StandaloneControlApiRuntime> {
  const store = await PostgresDomainStore.open({
    connectionString: config.connectionString,
    schema: config.schema,
    maxPoolSize: config.maxPoolSize,
    statementTimeoutMs: config.statementTimeoutMs,
  });
  try {
    return composeControlApi(store, config);
  } catch (error) {
    await store.close();
    throw error;
  }
}

function composeControlApi(
  store: DomainStore & ModelProviderSettingsStore & AutomationStore,
  config: ControlApiCompositionConfig,
): StandaloneControlApiRuntime {
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
  let workspaceWorker: LoopbackRuntimeWorkspaceWorkerClient | null = null;
  try {
    const authorization = new StandaloneAuthorization(config.actor);
    const clock = new SystemApplicationClock();
    const digester = new NodeSha256ContentDigester();
    const application = new RunApplicationService({
      store,
      authorization,
      clock,
      ids,
    });
    const threads = new ThreadApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
    });
    const turns = new TurnApplicationService({
      store,
      authorization,
      clock,
      ids,
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
      threads,
      goals,
      turns,
      compactions,
      rollbacks,
      approvals,
      agentVersions,
      agentVersionCatalogs,
      artifacts,
      automations,
      workspaceLists,
      workspaceQueries,
      providerSettings,
      providerProbes,
      providerRuntimeAvailability:
        config.providerProbeWorkers === undefined ? "unavailable" : "available",
      agentVersionDigester: digester,
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
    });
    outboxDispatcher.start();
    app.addHook("onClose", async () => {
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
      providerProbes,
      workspaceLists,
      workspaceQueries,
    };
  } catch (error) {
    void outboxDispatcher.close();
    eventHub.close();
    void workspaceWorker?.close();
    void config.artifactStore.close();
    void store.close();
    throw error;
  }
}
