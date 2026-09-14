import { createStandaloneSkillHost } from "./standalone-skill-host.ts";
import type { StorageAdmissionPort } from "@crewon/application";
import type { DeliveryStorePort } from "@crewon/application";
import { composeDeliveries } from "./delivery-composition.ts";
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

type ControlApiCompositionConfig = Readonly<{
  deliveryStore?: DeliveryStorePort;
  skillDatabasePath?: string;
