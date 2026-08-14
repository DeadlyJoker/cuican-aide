import {
  AgentVersionApplicationService,
  AgentVersionCatalogApplicationService,
  ArtifactApplicationService,
  AutomationApplicationService,
  AutomationSchedulerApplicationService,
  CompatibleAutomationScheduleCalculator,
  OfficeApplicationService,
  OfficeDelegationApplicationService,
  RunApplicationService,
  ThreadApplicationService,
  ThreadGoalApplicationService,
  ThreadRollbackApplicationService,
  ToolApprovalApplicationService,
  TurnApplicationService,
  ThreadCompactionApplicationService,
  ModelProviderSettingsApplicationService,
  KnowledgeApplicationService,
  WorkspaceListApplicationService,
  WorkspaceOperationQueryService,
  WorkflowVersionApplicationService,
  WorkflowRunApplicationService,
  WorkflowHumanGateApplicationService,
  type ActorContext,
  type ApplicationClock,
  type ArtifactStorePort,
  type AutomationStore,
  type AutomationSchedulerStore,
  type DomainStore,
  type ModelProviderSettingsStore,
  type KnowledgeStore,
  type WorkflowVersionStore,
  type WorkflowRuntimeStore,
  type WorkflowHumanGatePublicationStore,
} from "@crewon/application";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { FastifyInstance } from "fastify";

import { buildControlApi } from "./control-api.ts";
import { AutomationSchedulerLoop } from "./automation-scheduler-loop.ts";
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
import { LocalSettingsStore } from "./local-settings-store.ts";

type ControlApiCompositionConfig = Readonly<{
  actor: ActorContext;
  defaultAgentVersionId: string;
  sessionToken: string;
  csrfToken: string;
  allowedOrigins: readonly string[];
  heartbeatIntervalMs?: number | null;
  outboxScanIntervalMs?: number | null;
  automationSchedulerIntervalMs?: number | null;
  artifactStore: ArtifactStorePort;
  artifactEncryptionKeyId: string;
  providerProbeWorkers?: TenantProviderProbeWorkerRegistry;
  activationGate?: ProcessLocalActivationGate;
  clock?: ApplicationClock;
  workspaceWorker?: Readonly<{
    origin: string;
    token: string;
    workspaceBindingId: string;
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
  automationScheduler: AutomationSchedulerLoop | null;
  providerProbes: ControlProviderProbeService;
  workspaceLists: WorkspaceListApplicationService | null;
  workspaceQueries: WorkspaceOperationQueryService;
}>;

type ControlDomainStore = DomainStore &
  WorkflowRuntimeStore &
  WorkflowHumanGatePublicationStore &
  AutomationStore &
  ModelProviderSettingsStore &
  KnowledgeStore &
  Readonly<{
    workflowVersionStore(
      digester: WorkflowContentDigester,
    ): WorkflowVersionStore;
  }>;

export function createStandaloneControlApi(
  config: StandaloneControlApiConfig,
): StandaloneControlApiRuntime {
  const store = new SqliteRunStore(config.databasePath, {
    workflowDigester: new NodeSha256ContentDigester(),
  });
  const localSettings = new LocalSettingsStore(config.databasePath);
  return composeControlApi(store, config, localSettings, store);
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
    return composeControlApi(store, config, null, store);
  } catch (error) {
    await store.close();
    throw error;
  }
}

function composeControlApi(
  store: ControlDomainStore,
  config: ControlApiCompositionConfig,
  localSettings: LocalSettingsStore | null = null,
  automationSchedulerStore: AutomationSchedulerStore | null = null,
): StandaloneControlApiRuntime {
  const eventHub = new RunEventHub();
  const ids = new UuidV7ApplicationIdGenerator();
  const outboxDispatcher = new OutboxDispatcher(
    { store, eventHub, gatePublications: store },
    {
      ownerId: `outbox:${ids.nextId("outboxLease")}`,
      nextLeaseId: () => ids.nextId("outboxLease"),
      scanIntervalMs: config.outboxScanIntervalMs,
    },
  );
  let automationScheduler: AutomationSchedulerLoop | null = null;
  let workspaceWorker: LoopbackRuntimeWorkspaceWorkerClient | null = null;
  try {
    const authorization = new StandaloneAuthorization(config.actor);
    const clock = config.clock ?? new SystemApplicationClock();
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
      knowledge: store,
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
    const officeDelegations = new OfficeDelegationApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
      routeResolver,
    });
    const scheduleCalculator = new CompatibleAutomationScheduleCalculator();
    const automations = new AutomationApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
      routeResolver,
      scheduleCalculator,
    });
    automationScheduler =
      automationSchedulerStore === null
        ? null
        : new AutomationSchedulerLoop(
            new AutomationSchedulerApplicationService({
              store: automationSchedulerStore,
              authorization,
              calculator: scheduleCalculator,
              preparer: automations,
              retryAfterMs: 1_000,
            }),
            {
              ownerId: `automation-scheduler:${ids.nextId("outboxLease")}`,
              nextLeaseId: () => ids.nextId("outboxLease"),
              now: () => clock.now(),
              scanIntervalMs: config.automationSchedulerIntervalMs ?? null,
            },
          );
    const knowledge = new KnowledgeApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
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
      localSettings,
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
        authorization,
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
          listPublishedWorkflowHumanGates: (input) =>
            store.listPublishedWorkflowHumanGates(input),
          recordWorkflowHumanGateDecision: (input) =>
            store.recordWorkflowHumanGateDecision(input),
        },
        authorization,
        digester,
      }),
      agentVersionCatalogs,
      artifacts,
      automations,
      knowledge,
      workspaceLists,
      workspaceReadonly:
        workspaceWorker === null || config.workspaceWorker === undefined
          ? null
          : {
              workspaceBindingId: config.workspaceWorker.workspaceBindingId,
              executeReadonly: (input, signal) =>
                workspaceWorker!.executeReadonly(input, signal),
            },
      workspaceQueries,
      providerSettings,
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
    });
    outboxDispatcher.start();
    if (config.automationSchedulerIntervalMs !== undefined) {
      automationScheduler?.start();
    }
    app.addHook("onClose", async () => {
      await automationScheduler?.close();
      await outboxDispatcher.close();
      eventHub.close();
      await workspaceWorker?.close();
      await config.artifactStore.close();
      await store.close();
      localSettings?.close();
    });
    return {
      app,
      eventHub,
      outboxDispatcher,
      automationScheduler,
      providerProbes,
      workspaceLists,
      workspaceQueries,
    };
  } catch (error) {
    void automationScheduler?.close();
    void outboxDispatcher.close();
    eventHub.close();
    void workspaceWorker?.close();
    void config.artifactStore.close();
    void store.close();
    throw error;
  }
}
