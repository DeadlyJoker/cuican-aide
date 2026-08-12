import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  InMemoryAgentVersionRegistry,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import {
  ArtifactApplicationService,
  RunExecutionService,
  type AgentVersionDeploymentCandidate,
  type ArtifactStorePort,
  type DomainStore,
  type ModelProviderSettingsStore,
  type RunRoute,
  type WorkflowExecutionStore,
  type WorkflowRuntimeStore,
  type WorkflowVersionStore,
} from "@crewon/application";
import {
  PostgresDomainStore,
  PostgresWorkspaceReadFileStore,
  SqliteRunStore,
  SqliteWorkspaceReadFileStore,
} from "@crewon/store";
import type { GovernedContextBundle } from "@crewon/context";
import type {
  DeviceWorkspaceListCommandSignerPort,
  DeviceWorkspaceListDispatchClientPort,
} from "@crewon/device-dispatch";
import type { ToolRuntimePort } from "@crewon/tool-broker";

import { RuntimeWorker, type RuntimeWorkerConfig } from "./runtime-worker.ts";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import {
  AgentVersionRuntimeError,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";
import type { AgentVersionRuntimeFactoryPort } from "./durable-agent-version-runtime-loader.ts";
import { scopeToolRuntimeToAgentVersion } from "./agent-version-tool-runtime.ts";
import type { PriorModelCompactionResolverPort } from "./model-switch-compaction.ts";
import {
  NodeSha256ContentDigester,
  PinnedRunExecutionPolicy,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import {
  compileRuntimeAgentVersionRelease,
  verifyRuntimeAgentVersionRelease,
  type RuntimeAgentVersionReleasePlan,
} from "./agent-version-release.ts";
import {
  RuntimeProviderProbeService,
  type RuntimeProviderBinding,
  type RuntimeProviderSecretResolver,
} from "./provider-probe-service.ts";
import type { ProviderProbeEgressPolicy } from "./provider-probe-egress.ts";
import {
  startRuntimeProviderProbeServer,
  type RuntimeProviderProbeServer,
} from "./provider-probe-server.ts";
import {
  StoreBackedRuntimeWorkspaceAuthority,
  type RuntimeWorkspaceDispatchAuthority,
} from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceDispatchService } from "./runtime-workspace-dispatch-service.ts";
import { RuntimeWorkspaceFreezeService } from "./runtime-workspace-freeze-service.ts";
import {
  startRuntimeWorkspacePrivateServer,
  type RuntimeWorkspacePrivateServer,
} from "./runtime-workspace-private-server.ts";
import type { RuntimeWorkspaceExecutionIdGeneratorPort } from "./runtime-workspace-freeze-service.ts";
import {
  createRuntimeWorkspaceReadToolRuntime,
  validateRuntimeWorkspaceReadComposition,
  type NativeWorkspaceReadCatalog,
  type RuntimeWorkspaceReadFileConfig,
} from "./runtime-workspace-read-composition.ts";
import {
  SharedWorkflowAdmittedAgentExecutionEngine,
  WorkflowAgentRuntimeAdapter,
} from "./workflow-agent-runtime-adapter.ts";
import { ProductionWorkflowRuntimeDispatcher } from "./workflow-runtime-dispatcher.ts";

export { compileRuntimeAgentVersion } from "./agent-version-release.ts";

export type RuntimeWorkerCompositionConfig = Readonly<{
  runtimeTenantId: string;
  route: RunRoute;
  transport: ModelTransportPort;
  agentInstructions?: string | null;
  governedContext?: GovernedContextBundle;
  modelSwitchCompactionResolver?: PriorModelCompactionResolverPort;
  toolRuntime?: ToolRuntimePort;
  artifactStore?: ArtifactStorePort;
  artifactEncryptionKeyId?: string;
  ownerId?: string;
  leaseDurationMs?: number;
  streamMaxRetries?: number;
  retryAfterMs?: number;
  approvalRecheckMs?: number;
  approvalTtlMs?: number;
  maxToolRounds?: number;
  autoCompactAtTokens?: number | null;
  modelContextWindowTokens?: number;
  expectedAgentVersionDigest?: string | null;
  agentVersionRuntimeFactory?: AgentVersionRuntimeFactoryPort;
  agentVersionDeployments?: readonly AgentVersionDeploymentCandidate[];
  additionalAgentVersionRuntimes?: readonly Readonly<{
    tenantId: string | null;
    runtime: AgentVersionRuntime;
  }>[];
  scanIntervalMs?: number | null;
  cancellationPollIntervalMs?: number;
  afterRunStarted?: (() => Promise<void>) | undefined;
  afterAttemptStarted?: (() => Promise<void>) | undefined;
  afterToolDispatched?: RuntimeWorkerConfig["afterToolDispatched"];
  afterToolProviderResolved?: RuntimeWorkerConfig["afterToolProviderResolved"];
  afterToolReceiptCommitted?: RuntimeWorkerConfig["afterToolReceiptCommitted"];
  providerProbe?: Readonly<{
    port: number;
    token: string;
    runtimeBinding: RuntimeProviderBinding;
    secrets: RuntimeProviderSecretResolver;
    egressPolicy: ProviderProbeEgressPolicy;
    rateLimit?: number;
    rateWindowMs?: number;
    concurrencyLimit?: number;
  }>;
  workspacePrivate?: Readonly<{
    port: number;
    token: string;
    authority: RuntimeWorkspaceDispatchAuthority;
    ids: RuntimeWorkspaceExecutionIdGeneratorPort;
    signer: DeviceWorkspaceListCommandSignerPort;
    gateway: DeviceWorkspaceListDispatchClientPort;
    deadlineMs?: number;
  }>;
  workspaceReadFile?: RuntimeWorkspaceReadFileConfig;
  nativeWorkspaceReadCatalog?: NativeWorkspaceReadCatalog;
  workflowComposition?: WorkflowRuntimeCompositionCandidate;
}>;

export const WORKFLOW_RUNTIME_CAPABILITIES = [
  "receiptFirstAdmission",
  "exactNodeRuntimeAuthority",
  "durableModelDispatchEvidence",
  "atomicNodeSettlement",
  "durableHumanGate",
  "evidenceBasedReconciliation",
  "atomicCancellation",
] as const;

export type WorkflowRuntimeCompositionCandidate = Readonly<{
  certification: Readonly<{
    schemaVersion: "crewon.workflow-runtime-certification.v0";
    capabilities: typeof WORKFLOW_RUNTIME_CAPABILITIES;
  }>;
  versions: WorkflowVersionStore;
  store: WorkflowRuntimeStore & DomainStore & WorkflowExecutionStore;
  close(): Promise<void>;
}>;

export type StandaloneRuntimeWorkerConfig = RuntimeWorkerCompositionConfig &
  Readonly<{ databasePath: string }>;

export type PostgresRuntimeWorkerConfig = RuntimeWorkerCompositionConfig &
  Readonly<{
    connectionString: string;
    schema?: string;
    maxPoolSize?: number;
    statementTimeoutMs?: number;
  }>;

export type StandaloneRuntimeWorker = Readonly<{
  worker: RuntimeWorker;
  agentVersion: CompiledAgentVersion;
  agentVersionRegistry: InMemoryAgentVersionRuntimeRegistry;
  providerProbeOrigin: string | null;
  workspacePrivateOrigin: string | null;
  close(): Promise<void>;
}>;

export async function createStandaloneRuntimeWorker(
  config: StandaloneRuntimeWorkerConfig,
): Promise<StandaloneRuntimeWorker> {
  let releasePlan: RuntimeAgentVersionReleasePlan;
  let store: SqliteRunStore | undefined;
  let workspaceReadStore: SqliteWorkspaceReadFileStore | undefined;
  try {
    releasePlan = compileRuntimeAgentVersionRelease(config);
    store = config.workflowComposition?.store instanceof SqliteRunStore
      ? config.workflowComposition.store
      : new SqliteRunStore(config.databasePath);
    workspaceReadStore =
      config.workspaceReadFile === undefined
        ? undefined
        : SqliteWorkspaceReadFileStore.open(config.databasePath);
  } catch (error) {
    await Promise.allSettled([
      workspaceReadStore?.close() ?? Promise.resolve(),
      closeStandaloneRoots(config, store),
      closeStartupResources(config, false),
    ]);
    throw error;
  }
  try {
    return await composeRuntimeWorker(
      store,
      workspaceReadStore,
      config,
      releasePlan,
    );
  } catch (error) {
    await Promise.allSettled([
      workspaceReadStore?.close() ?? Promise.resolve(),
      closeStandaloneRoots(config, store),
      closeStartupResources(config, false),
    ]);
    throw error;
  }
}

export async function createPostgresRuntimeWorker(
  config: PostgresRuntimeWorkerConfig,
): Promise<StandaloneRuntimeWorker> {
  let releasePlan: RuntimeAgentVersionReleasePlan;
  let store: PostgresDomainStore | undefined;
  let workspaceReadStore: PostgresWorkspaceReadFileStore | undefined;
  try {
    releasePlan = compileRuntimeAgentVersionRelease(config);
    store = await PostgresDomainStore.open({
      connectionString: config.connectionString,
      schema: config.schema,
      maxPoolSize: config.maxPoolSize,
      statementTimeoutMs: config.statementTimeoutMs,
    });
    workspaceReadStore =
      config.workspaceReadFile === undefined
        ? undefined
        : await PostgresWorkspaceReadFileStore.open(
            config.connectionString,
            { schema: config.schema },
          );
  } catch (error) {
    await Promise.allSettled([
      workspaceReadStore?.close() ?? Promise.resolve(),
      store?.close() ?? Promise.resolve(),
      closeStartupResources(config),
    ]);
    throw error;
  }
  try {
    return await composeRuntimeWorker(
      store,
      workspaceReadStore,
      config,
      releasePlan,
    );
  } catch (error) {
    await Promise.allSettled([
      workspaceReadStore?.close() ?? Promise.resolve(),
      store.close(),
      closeStartupResources(config),
    ]);
    throw error;
  }
}

async function composeRuntimeWorker(
  store: DomainStore & ModelProviderSettingsStore,
  workspaceReadStore:
    | SqliteWorkspaceReadFileStore
    | PostgresWorkspaceReadFileStore
    | undefined,
  config: StandaloneRuntimeWorkerConfig | PostgresRuntimeWorkerConfig,
  releasePlan: RuntimeAgentVersionReleasePlan,
): Promise<StandaloneRuntimeWorker> {
  const ids = new UuidV7ApplicationIdGenerator();
  const digester = new NodeSha256ContentDigester();
  const clock = new SystemApplicationClock();
  const artifactStore = config.artifactStore;
  if (
    (config.agentVersionRuntimeFactory === undefined) !==
    (config.agentVersionDeployments === undefined)
  ) {
    throw new Error("runtime_deployment_configuration_incomplete");
  }
  if (
    (artifactStore === undefined) !==
    (config.artifactEncryptionKeyId === undefined)
  ) {
    throw new Error("runtime_artifact_configuration_incomplete");
  }
  validateWorkspaceDeployment(config);
  const toolRuntime = createRuntimeWorkspaceReadToolRuntime({
    store,
    workspaceReadStore,
    readFile: config.workspaceReadFile,
    deployment: config.workspacePrivate?.authority,
    digester,
    configuredRuntime: config.toolRuntime,
  });
  if (
    JSON.stringify(toolRuntime.definitions()) !==
    JSON.stringify(releasePlan.bootstrapVersion.tools)
  ) {
    await toolRuntime.close?.();
    throw new Error("runtime_release_tool_catalog_mismatch");
  }
  try {
    await verifyRuntimeAgentVersionRelease({
      tenantId: config.runtimeTenantId,
      store,
      plan: releasePlan,
      digester,
    });
  } catch (error) {
    await toolRuntime.close?.();
    throw error;
  }
  const artifacts =
    artifactStore === undefined
      ? undefined
      : new ArtifactApplicationService({
          store: artifactStore,
          authorization: {
            authorize: async () => ({
              outcome: "deny",
              reasonCode: "runtime_artifact_read_forbidden",
            }),
          },
          clock,
          ids,
          digester,
          encryptionKeyId: config.artifactEncryptionKeyId!,
        });
  const registry = new InMemoryAgentVersionRegistry();
  registry.register(releasePlan.bootstrapVersion);
  const agentVersion = registry.require(config.route.agentVersionId);
  const kernel = new CrewONAgentKernel({
    transport: config.transport,
    instructions: agentVersion.instructions,
    toolCatalog: { definitions: () => agentVersion.tools },
    streamMaxRetries: agentVersion.execution.streamMaxRetries,
  });
  const policy = new PinnedRunExecutionPolicy(config.route);
  const agentVersionRegistry = new InMemoryAgentVersionRuntimeRegistry(
    digester,
  );
  agentVersionRegistry.register({
    tenantId: config.runtimeTenantId,
    runtime: {
      version: agentVersion,
      kernel,
      policy,
      toolRuntime,
      contextCompactor: new KernelContextCompactor(kernel),
      ...(config.governedContext === undefined
        ? {}
        : { governedContext: config.governedContext }),
      close: async () => {
        await toolRuntime.close?.();
        await config.transport.close?.();
      },
    },
  });
  for (const additional of config.additionalAgentVersionRuntimes ?? []) {
    agentVersionRegistry.register(additional);
  }
  const runtimeResolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    digester,
    registry: agentVersionRegistry,
    factory:
      config.agentVersionRuntimeFactory ??
      staticAgentVersionRuntimeFactory(config, toolRuntime),
  });
  const workflow = certifyWorkflowComposition(config.workflowComposition, store);
  const execution = new RunExecutionService({
    store,
    clock,
    ids,
    digester,
    ...(workflow === null
      ? {}
      : { workflowExecutions: workflow.store }),
  });
  const workflowDispatcher =
    workflow === null
      ? undefined
      : new ProductionWorkflowRuntimeDispatcher({
          versions: workflow.versions,
          store: workflow.store,
          digester,
          agent: new WorkflowAgentRuntimeAdapter({
            runtimes: runtimeResolver,
            engine: new SharedWorkflowAdmittedAgentExecutionEngine({
              execution,
              store: workflow.store,
              leaseDurationMs: config.leaseDurationMs ?? 30_000,
            }),
          }),
          leaseDurationMs: config.leaseDurationMs ?? 30_000,
        });
  const worker = new RuntimeWorker(
    {
      store,
      execution,
      kernel,
      toolRuntime,
      artifacts,
      toolDefinitions: agentVersion.tools,
      governedContext: config.governedContext,
      modelSwitchCompactionResolver:
        config.modelSwitchCompactionResolver ??
        runtimeResolver.priorModelCompactionResolver(),
      agentVersionRuntimeResolver: runtimeResolver,
      workflowDispatcher,
      policy,
    },
    {
      ownerId: config.ownerId ?? `runtime-worker:${ids.nextId("outboxLease")}`,
      nextLeaseId: () => ids.nextId("outboxLease"),
      leaseDurationMs: config.leaseDurationMs,
      retryAfterMs: config.retryAfterMs,
      approvalRecheckMs: config.approvalRecheckMs,
      approvalTtlMs: config.approvalTtlMs,
      maxToolRounds: agentVersion.execution.maxToolRounds,
      autoCompactAtTokens: agentVersion.model.autoCompactAtTokens,
      modelContextWindowTokens: agentVersion.model.contextWindowTokens,
      scanIntervalMs: config.scanIntervalMs,
      cancellationPollIntervalMs: config.cancellationPollIntervalMs,
      afterRunStarted: config.afterRunStarted,
      afterAttemptStarted: config.afterAttemptStarted,
      afterToolDispatched: config.afterToolDispatched,
      afterToolProviderResolved: config.afterToolProviderResolved,
      afterToolReceiptCommitted: config.afterToolReceiptCommitted,
    },
  );
  let providerProbeServer: RuntimeProviderProbeServer | null = null;
  let workspacePrivateServer: RuntimeWorkspacePrivateServer | null = null;
  let workspaceDispatchService: RuntimeWorkspaceDispatchService | null = null;
  try {
    if (config.providerProbe !== undefined) {
      providerProbeServer = await startRuntimeProviderProbeServer({
        port: config.providerProbe.port,
        token: config.providerProbe.token,
        service: new RuntimeProviderProbeService(
          {
            store,
            tenantId: config.runtimeTenantId,
            runtimeBinding: config.providerProbe.runtimeBinding,
            secrets: config.providerProbe.secrets,
            egressPolicy: config.providerProbe.egressPolicy,
          },
          {
            rateLimit: config.providerProbe.rateLimit,
            rateWindowMs: config.providerProbe.rateWindowMs,
            concurrencyLimit: config.providerProbe.concurrencyLimit,
          },
        ),
      });
    }
    if (config.workspacePrivate !== undefined) {
      const workspaceAuthority = new StoreBackedRuntimeWorkspaceAuthority({
        store,
        authority: config.workspacePrivate.authority,
      });
      const freeze = new RuntimeWorkspaceFreezeService({
        bindings: workspaceAuthority,
        ids: config.workspacePrivate.ids,
        digester,
      });
      workspaceDispatchService = new RuntimeWorkspaceDispatchService({
        authority: workspaceAuthority,
        digester,
        signer: config.workspacePrivate.signer,
        gateway: config.workspacePrivate.gateway,
      });
      workspacePrivateServer = await startRuntimeWorkspacePrivateServer({
        port: config.workspacePrivate.port,
        authentication: {
          kind: "loopbackToken",
          token: config.workspacePrivate.token,
        },
        freeze,
        dispatch: workspaceDispatchService,
        deadlineMs: config.workspacePrivate.deadlineMs,
      });
    }
  } catch (error) {
    await Promise.allSettled([
      workspacePrivateServer?.close() ?? Promise.resolve(),
      providerProbeServer?.close() ?? Promise.resolve(),
      worker.close(),
      agentVersionRegistry.close(),
    ]);
    throw error;
  }
  let closed = false;
  return {
    worker,
    agentVersion,
    agentVersionRegistry,
    providerProbeOrigin: providerProbeServer?.origin ?? null,
    workspacePrivateOrigin: workspacePrivateServer?.origin ?? null,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      const results = await Promise.allSettled([
        workspacePrivateServer?.close() ?? Promise.resolve(),
        providerProbeServer?.close() ?? Promise.resolve(),
      ]);
      results.push(...(await Promise.allSettled([worker.close()])));
      results.push(
        ...(await Promise.allSettled([
          workspaceDispatchService?.close() ?? Promise.resolve(),
          config.workspaceReadFile?.gateway.close() ?? Promise.resolve(),
          agentVersionRegistry.close(),
          artifactStore?.close() ?? Promise.resolve(),
          workspaceReadStore?.close() ?? Promise.resolve(),
          closeRuntimeRoots(config, store),
        ])),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "runtime_close_failed");
      }
    },
  };
}

function certifyWorkflowComposition(
  candidate: WorkflowRuntimeCompositionCandidate | undefined,
  store: DomainStore & ModelProviderSettingsStore,
): WorkflowRuntimeCompositionCandidate | null {
  if (candidate === undefined) return null;
  if (
    !hasExactKeys(candidate, ["certification", "close", "store", "versions"]) ||
    !hasExactKeys(candidate.certification, ["capabilities", "schemaVersion"]) ||
    candidate.certification.schemaVersion !==
      "crewon.workflow-runtime-certification.v0" ||
    candidate.certification.capabilities.length !==
      WORKFLOW_RUNTIME_CAPABILITIES.length ||
    candidate.certification.capabilities.some(
      (capability, index) =>
        capability !== WORKFLOW_RUNTIME_CAPABILITIES[index],
    ) ||
    !Object.is(candidate.store, store)
  ) {
    throw new Error("workflow_runtime_composition_not_certified");
  }
  return candidate;
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function validateWorkspaceDeployment(
  config: RuntimeWorkerCompositionConfig,
): void {
  const authority = config.workspacePrivate?.authority;
  if (
    authority !== undefined &&
    (authority.tenantId !== config.runtimeTenantId ||
      authority.workspaceBindingId !== config.route.workspaceBindingId ||
      authority.runtimeBindingId !== config.route.runtimeGeneration ||
      authority.policySnapshotId !== config.route.policySnapshotId)
  ) {
    throw new Error("runtime_workspace_deployment_mismatch");
  }
  validateRuntimeWorkspaceReadComposition({
    catalog: config.nativeWorkspaceReadCatalog,
    readFile: config.workspaceReadFile,
    deployment: authority,
  });
}

async function closeStartupResources(
  config: RuntimeWorkerCompositionConfig,
  includeWorkflow = true,
): Promise<void> {
  await Promise.allSettled([
    config.workspacePrivate?.gateway.close() ?? Promise.resolve(),
    config.workspaceReadFile?.gateway.close() ?? Promise.resolve(),
    config.artifactStore?.close() ?? Promise.resolve(),
    includeWorkflow
      ? config.workflowComposition?.close() ?? Promise.resolve()
      : Promise.resolve(),
  ]);
}

async function closeStandaloneRoots(
  config: StandaloneRuntimeWorkerConfig,
  store: { close(): Promise<void> } | undefined,
): Promise<void> {
  const candidate = config.workflowComposition;
  const results = await Promise.allSettled([
    candidate?.close() ?? Promise.resolve(),
    store !== undefined && !Object.is(candidate?.store, store)
      ? store.close()
      : Promise.resolve(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0)
    throw new AggregateError(failures, "runtime_root_close_failed");
}

async function closeRuntimeRoots(
  config: StandaloneRuntimeWorkerConfig | PostgresRuntimeWorkerConfig,
  store: { close(): Promise<void> },
): Promise<void> {
  if ("databasePath" in config) return closeStandaloneRoots(config, store);
  const results = await Promise.allSettled([
    config.workflowComposition?.close() ?? Promise.resolve(),
    Object.is(config.workflowComposition?.store, store)
      ? Promise.resolve()
      : store.close(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0)
    throw new AggregateError(failures, "runtime_root_close_failed");
}

function staticAgentVersionRuntimeFactory(
  config: RuntimeWorkerCompositionConfig,
  toolRuntime: ToolRuntimePort,
): AgentVersionRuntimeFactoryPort {
  return {
    create: ({ version }) => {
      if (
        version.model.adapterName !== config.transport.adapterName ||
        version.model.adapterVersion !== config.transport.adapterVersion ||
        version.model.modelId !== config.transport.modelId
      ) {
        throw new AgentVersionRuntimeError(
          "agent_version_transport_not_configured",
        );
      }
      if (
        version.resources.workspaceRequired !==
        (config.route.workspaceBindingId !== null)
      ) {
        throw new AgentVersionRuntimeError(
          "agent_version_workspace_binding_mismatch",
        );
      }
      const kernel = new CrewONAgentKernel({
        transport: config.transport,
        instructions: version.instructions,
        toolCatalog: { definitions: () => version.tools },
        streamMaxRetries: version.execution.streamMaxRetries,
      });
      const versionToolRuntime = scopeToolRuntimeToAgentVersion(
        toolRuntime,
        version.tools,
      );
      return {
        version,
        kernel,
        policy: new PinnedRunExecutionPolicy({
          ...config.route,
          runtimeGeneration: version.runtimeGeneration,
          agentVersionId: version.agentVersionId,
          policySnapshotId: version.policySnapshotId,
        }),
        toolRuntime: versionToolRuntime,
        contextCompactor: new KernelContextCompactor(kernel),
        ...(config.governedContext === undefined
          ? {}
          : { governedContext: config.governedContext }),
      };
    },
  };
}
