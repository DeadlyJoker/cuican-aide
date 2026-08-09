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
} from "@crewon/application";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { GovernedContextBundle } from "@crewon/context";
import { InMemoryToolBroker, type ToolRuntimePort } from "@crewon/tool-broker";

import { RuntimeWorker, type RuntimeWorkerConfig } from "./runtime-worker.ts";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import {
  AgentVersionRuntimeError,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";
import type { AgentVersionRuntimeFactoryPort } from "./durable-agent-version-runtime-loader.ts";
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
  close(): Promise<void>;
}>;

export async function createStandaloneRuntimeWorker(
  config: StandaloneRuntimeWorkerConfig,
): Promise<StandaloneRuntimeWorker> {
  const releasePlan = compileRuntimeAgentVersionRelease(config);
  let store: SqliteRunStore;
  try {
    store = new SqliteRunStore(config.databasePath);
  } catch (error) {
    await config.artifactStore?.close();
    throw error;
  }
  try {
    return await composeRuntimeWorker(store, config, releasePlan);
  } catch (error) {
    await Promise.allSettled([store.close(), config.artifactStore?.close()]);
    throw error;
  }
}

export async function createPostgresRuntimeWorker(
  config: PostgresRuntimeWorkerConfig,
): Promise<StandaloneRuntimeWorker> {
  const releasePlan = compileRuntimeAgentVersionRelease(config);
  let store: PostgresDomainStore;
  try {
    store = await PostgresDomainStore.open({
      connectionString: config.connectionString,
      schema: config.schema,
      maxPoolSize: config.maxPoolSize,
      statementTimeoutMs: config.statementTimeoutMs,
    });
  } catch (error) {
    await config.artifactStore?.close();
    throw error;
  }
  try {
    return await composeRuntimeWorker(store, config, releasePlan);
  } catch (error) {
    await Promise.allSettled([store.close(), config.artifactStore?.close()]);
    throw error;
  }
}

async function composeRuntimeWorker(
  store: DomainStore & ModelProviderSettingsStore,
  config: RuntimeWorkerCompositionConfig,
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
  await verifyRuntimeAgentVersionRelease({
    tenantId: config.runtimeTenantId,
    store,
    plan: releasePlan,
    digester,
  });
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
  const toolRuntime: ToolRuntimePort =
    config.toolRuntime ?? new InMemoryToolBroker();
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
  const execution = new RunExecutionService({
    store,
    clock,
    ids,
    digester,
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
  } catch (error) {
    await Promise.allSettled([
      worker.close(),
      agentVersionRegistry.close(),
      artifactStore?.close() ?? Promise.resolve(),
      store.close(),
    ]);
    throw error;
  }
  let closed = false;
  return {
    worker,
    agentVersion,
    agentVersionRegistry,
    providerProbeOrigin: providerProbeServer?.origin ?? null,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await providerProbeServer?.close();
      await worker.close();
      const results = await Promise.allSettled([
        agentVersionRegistry.close(),
        artifactStore?.close() ?? Promise.resolve(),
        store.close(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "runtime_close_failed");
      }
    },
  };
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
      return {
        version,
        kernel,
        policy: new PinnedRunExecutionPolicy({
          ...config.route,
          runtimeGeneration: version.runtimeGeneration,
          agentVersionId: version.agentVersionId,
          policySnapshotId: version.policySnapshotId,
        }),
        toolRuntime,
        contextCompactor: new KernelContextCompactor(kernel),
        ...(config.governedContext === undefined
          ? {}
          : { governedContext: config.governedContext }),
      };
    },
  };
}
