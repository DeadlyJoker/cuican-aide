import { isDeepStrictEqual } from "node:util";
import {
  RuntimeCompositionLifetime,
  closeRuntimeResources,
  type RuntimeCleanupHandle,
} from "./runtime-composition-lifetime.ts";
import type { StorageAdmissionPort } from "@crewon/application";
import { createLocalStorageAdmissionOwner } from "@crewon/store";
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
  type RunRoute,
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
import { preparePluginTaskAdmissionProbe } from "./plugins/plugin-task-admission-probe.ts";
import type { InstalledPluginRunRuntimeResolverPort } from "./plugins/installed-plugin-run-runtime.ts";
import {
  captureInstalledPluginExecutionConfig,
  composeInstalledPluginRuntimeResolver,
  composeInstalledPluginQueryHost,
  composeInstalledPluginExecutionReadiness,
  type InstalledPluginExecutionConfig,
} from "./plugins/installed-plugin-runtime-composition.ts";
import type { InstalledPluginQueryHost } from "./plugins/installed-plugin-query-host.ts";
import type { InstalledPluginExecutionReadinessPort } from "./plugins/installed-plugin-execution-readiness.ts";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { type AgentVersionRuntime } from "./agent-version-runtime.ts";
import type { AgentVersionRuntimeFactoryPort } from "./durable-agent-version-runtime-loader.ts";
import { sharedAgentVersionRuntimeFactory } from "./shared-agent-version-runtime-factory.ts";
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
  composeRuntimeExtensions,
  prepareExtensionCompositionDeployments,
  type RuntimeExtensionCompositionConfig,
} from "./extensions/extension-runtime-composition.ts";
import { RuntimeExtensionHostService } from "./extensions/extension-host-service.ts";
import {
  startRuntimeExtensionHostServer,
  type RuntimeExtensionHostServer,
} from "./extensions/extension-host-server.ts";
import type { RuntimeExtensionHostConfig } from "./extensions/extension-process-environment.ts";
import {
  extensionWorkItemExecutionScope,
  preparedExtensionExecutionTargets,
  parseExtensionExecutionMode,
  type ExtensionExecutionMode,
} from "./extensions/extension-work-item-scope.ts";

export { compileRuntimeAgentVersion } from "./agent-version-release.ts";

/** Supplied closable resources transfer to this composition, including failed startup. */
export type RuntimeWorkerCompositionConfig = Readonly<{
  storageAdmission?: StorageAdmissionPort;
  localStoragePaths?: readonly string[];
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
  additionalAgentVersions?: readonly CompiledAgentVersion[];
  extensionRuntime?: RuntimeExtensionCompositionConfig;
  extensionHost?: RuntimeExtensionHostConfig;
  extensionExecutionMode?: ExtensionExecutionMode;
  /** Trusted composition only; never inferred from package metadata or a fixed preview identity. */
  installedPluginRuntimeResolver?: InstalledPluginRunRuntimeResolverPort;
  /** Construct and own the installed execution resolver using this composition's actual stores. */
  installedPluginExecution?: InstalledPluginExecutionConfig;
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
  extensionHostOrigin: string | null;
  pluginQueryHost: InstalledPluginQueryHost | null;
  /** Borrowed by the admission Host; close that Host before closing this Worker. */
  pluginExecutionReadiness: InstalledPluginExecutionReadinessPort | null;
  close(): Promise<void>;
}>;

export async function createStandaloneRuntimeWorker(
  config: StandaloneRuntimeWorkerConfig,
): Promise<StandaloneRuntimeWorker> {
  const inputs = ownCompositionInputs(config);
  try {
    const prepared = prepareComposition(config);
    const releasePlan = compileRuntimeAgentVersionRelease(prepared);
    const store = new SqliteRunStore(config.databasePath);
    inputs.lifetime.own(store, { phase: "storage" });
    const workspaceReadStore =
      config.workspaceReadFile === undefined
        ? undefined
        : SqliteWorkspaceReadFileStore.open(config.databasePath);
    if (workspaceReadStore !== undefined)
      inputs.lifetime.own(workspaceReadStore, { phase: "storage" });
    return await composeRuntimeWorker(
      store,
      workspaceReadStore,
      {
        ...prepared,
        localStoragePaths: [
          config.databasePath,
          ...(config.localStoragePaths ?? []),
        ],
      },
      releasePlan,
      inputs,
    );
  } catch (error) {
    await inputs.lifetime.close().catch(() => {});
    throw error;
  }
}

export async function createPostgresRuntimeWorker(
  config: PostgresRuntimeWorkerConfig,
): Promise<StandaloneRuntimeWorker> {
  const inputs = ownCompositionInputs(config);
  try {
    const prepared = prepareComposition(config);
    const releasePlan = compileRuntimeAgentVersionRelease(prepared);
    const store = await PostgresDomainStore.open({
      connectionString: config.connectionString,
      schema: config.schema,
      maxPoolSize: config.maxPoolSize,
      statementTimeoutMs: config.statementTimeoutMs,
    });
    inputs.lifetime.own(store, { phase: "storage" });
    const workspaceReadStore =
      config.workspaceReadFile === undefined
        ? undefined
        : await PostgresWorkspaceReadFileStore.open(config.connectionString, {
            schema: config.schema,
          });
    if (workspaceReadStore !== undefined)
      inputs.lifetime.own(workspaceReadStore, { phase: "storage" });
    return await composeRuntimeWorker(
      store,
      workspaceReadStore,
      prepared,
      releasePlan,
      inputs,
    );
  } catch (error) {
    await inputs.lifetime.close().catch(() => {});
    throw error;
  }
}

type PreparedRuntimeWorkerConfig = RuntimeWorkerCompositionConfig &
  Readonly<{
    preparedExtensionAgentVersionIds?: readonly string[];
  }>;

function prepareComposition(
  input: RuntimeWorkerCompositionConfig,
): PreparedRuntimeWorkerConfig {
  if (
    input.installedPluginExecution !== undefined &&
    input.installedPluginRuntimeResolver !== undefined
  )
    throw new Error("installed_plugin_execution_configuration_conflict");
  // Capture scheduling and plugin materialization inputs before storage can yield.
  const config = Object.freeze({
    ...input,
    route: Object.freeze({ ...input.route }),
    ...(input.installedPluginExecution === undefined
      ? {}
      : {
          installedPluginExecution: captureInstalledPluginExecutionConfig(
            input.installedPluginExecution,
          ),
        }),
    ...(input.extensionHost === undefined
      ? {}
      : { extensionHost: Object.freeze({ ...input.extensionHost }) }),
    ...(input.extensionRuntime === undefined
      ? {}
      : {
          extensionRuntime: Object.freeze({
            ...input.extensionRuntime,
            environment: Object.freeze({
              ...(input.extensionRuntime.environment ?? process.env),
            }),
            ...(input.extensionRuntime.additionalRuntimeBindingsPaths ===
            undefined
              ? {}
              : {
                  additionalRuntimeBindingsPaths: Object.freeze([
                    ...input.extensionRuntime.additionalRuntimeBindingsPaths,
                  ]),
                }),
            ...(input.extensionRuntime.privateHost === undefined
              ? {}
              : {
                  privateHost: Object.freeze({
                    ...input.extensionRuntime.privateHost,
                  }),
                }),
          }),
        }),
  });
  const mode = parseExtensionExecutionMode(config.extensionExecutionMode);
  if (
    config.installedPluginExecution?.historicalQuery !== undefined &&
    config.installedPluginExecution.historicalQuery.scope.tenantId !==
      config.runtimeTenantId
  )
    throw new Error("installed_plugin_query_tenant_mismatch");
  if (
    config.extensionExecutionMode !== undefined &&
    config.extensionRuntime === undefined &&
    config.extensionHost === undefined
  )
    throw new Error("extension_execution_mode_without_host");
  if (mode === "historical" && config.extensionRuntime === undefined)
    throw new Error("extension_historical_runtime_required");
  if (
    config.extensionHost !== undefined &&
    config.extensionRuntime?.privateHost !== undefined
  )
    throw new Error("extension_host_configuration_conflict");
  if (config.extensionRuntime === undefined)
    return config.extensionHost === undefined
      ? config
      : Object.freeze({ ...config, extensionExecutionMode: mode });
  if (
    config.agentVersionRuntimeFactory !== undefined ||
    config.agentVersionDeployments !== undefined
  )
    throw new Error("extension_runtime_factory_configuration_conflict");
  const preparedExtensions = prepareExtensionCompositionDeployments({
    config: config.extensionRuntime,
    tenantId: config.runtimeTenantId,
    defaultAgentVersionId: config.route.agentVersionId,
  });
  return Object.freeze({
    ...config,
    extensionExecutionMode: mode,
    agentVersionDeployments: preparedExtensions.deployments,
    preparedExtensionAgentVersionIds:
      preparedExtensions.extensionAgentVersionIds,
  });
}

function ownCompositionInputs(config: RuntimeWorkerCompositionConfig) {
  const lifetime = new RuntimeCompositionLifetime();
  const transport = lifetime.own(config.transport, { phase: "resources" });
  const tools =
    config.toolRuntime === undefined
      ? undefined
      : lifetime.own(config.toolRuntime, { phase: "resources" });
  if (config.installedPluginRuntimeResolver !== undefined)
    lifetime.own(config.installedPluginRuntimeResolver, { phase: "resources" });
  for (const gateway of [
    config.workspacePrivate?.gateway,
    config.workspaceReadFile?.gateway,
  ]) {
    if (gateway !== undefined) lifetime.own(gateway, { phase: "resources" });
  }
  if (config.artifactStore !== undefined)
    lifetime.own(config.artifactStore, { phase: "storage" });
  const additional = new Map<AgentVersionRuntime, RuntimeCleanupHandle>();
  for (const { runtime } of config.additionalAgentVersionRuntimes ?? [])
    additional.set(runtime, lifetime.own(runtime, { phase: "resources" }));
  return { lifetime, transport, tools, additional };
}

async function composeRuntimeWorker(
  store: SqliteRunStore | PostgresDomainStore,
  workspaceReadStore:
    | SqliteWorkspaceReadFileStore
    | PostgresWorkspaceReadFileStore
    | undefined,
  config: PreparedRuntimeWorkerConfig,
  releasePlan: RuntimeAgentVersionReleasePlan,
  inputs: ReturnType<typeof ownCompositionInputs>,
): Promise<StandaloneRuntimeWorker> {
  const { lifetime } = inputs;
  const ids = new UuidV7ApplicationIdGenerator();
  const digester = new NodeSha256ContentDigester();
  const clock = new SystemApplicationClock();
  const artifactStore = config.artifactStore;
  const workItemExecutionScope =
    config.extensionRuntime === undefined && config.extensionHost === undefined
      ? undefined
      : extensionWorkItemExecutionScope({
          tenantId: config.runtimeTenantId,
          mode: parseExtensionExecutionMode(config.extensionExecutionMode),
          targets:
            config.extensionRuntime === undefined
              ? []
              : preparedExtensionExecutionTargets({
                  tenantId: config.runtimeTenantId,
                  agentVersionIds: config.preparedExtensionAgentVersionIds!,
                  releasePlan,
                }),
        });
  if (
    workItemExecutionScope !== undefined &&
    config.extensionRuntime === undefined
  )
    await store.extensionStore().migrate();
  const pluginTaskAdmissions =
    workItemExecutionScope !== undefined ||
    config.installedPluginRuntimeResolver !== undefined ||
    config.installedPluginExecution !== undefined
      ? await preparePluginTaskAdmissionProbe(store)
      : store.pluginTaskAdmissionProbe();
  if (
    config.installedPluginExecution !== undefined &&
    (config.installedPluginExecution.executionIo !== undefined ||
      config.installedPluginExecution.historicalQuery !== undefined)
  )
    await store.externalOperationStore().migrate();
  const executionReadiness =
    config.installedPluginExecution === undefined
      ? null
      : composeInstalledPluginExecutionReadiness({
          store,
          config: config.installedPluginExecution,
        });
  if (executionReadiness !== null)
    lifetime.own(executionReadiness, { phase: "resources" });
  const installedPluginRuntimeResolver =
    config.installedPluginExecution === undefined
      ? config.installedPluginRuntimeResolver
      : composeInstalledPluginRuntimeResolver({
          store,
          extensions: store.extensionStore(),
          config: config.installedPluginExecution,
        });
  if (installedPluginRuntimeResolver !== undefined)
    lifetime.own(installedPluginRuntimeResolver, { phase: "resources" });
  const agentVersionRuntimeFactory =
    config.extensionRuntime === undefined
      ? config.agentVersionRuntimeFactory
      : await composeRuntimeExtensions({
          config: config.extensionRuntime,
          store,
          tenantId: config.runtimeTenantId,
          defaultAgentVersionId: config.route.agentVersionId,
          expectedDeployments: config.agentVersionDeployments!,
        });
  if (
    (agentVersionRuntimeFactory === undefined) !==
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
  const toolsOwner = lifetime.own(toolRuntime, { phase: "resources" });
  if (toolRuntime !== config.toolRuntime) inputs.tools?.delegate();
  if (
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(toolRuntime.definitions())),
      releasePlan.bootstrapVersion.tools,
    )
  ) {
    throw new Error("runtime_release_tool_catalog_mismatch");
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
  lifetime.own(agentVersionRegistry, { phase: "stop" });
  const bootstrapRuntime: AgentVersionRuntime = {
    version: agentVersion,
    executionAuthority: "crewonKernel",
    kernel,
    policy,
    toolRuntime,
    contextCompactor: new KernelContextCompactor(kernel),
    ...(config.governedContext === undefined
      ? {}
      : { governedContext: config.governedContext }),
    close: () => closeRuntimeResources([toolsOwner, inputs.transport]),
  };
  agentVersionRegistry.register({
    tenantId: config.runtimeTenantId,
    runtime: bootstrapRuntime,
  });
  toolsOwner.delegate();
  inputs.transport.delegate();
  const registered = new Set<AgentVersionRuntime>([bootstrapRuntime]);
  for (const additional of config.additionalAgentVersionRuntimes ?? []) {
    const disposition = agentVersionRegistry.register(additional).disposition;
    const owner = inputs.additional.get(additional.runtime)!;
    if (disposition === "registered") registered.add(additional.runtime);
    else if (!registered.has(additional.runtime)) await owner.close();
    owner.delegate();
  }
  const runtimeResolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    digester,
    registry: agentVersionRegistry,
    acquireSharedOwner: () => {
      const lease = agentVersionRegistry.acquire({
        tenantId: config.runtimeTenantId,
        agentVersionId: agentVersion.agentVersionId,
      });
      return lease === null
        ? null
        : { resource: toolRuntime, release: lease.release };
    },
    factory:
      agentVersionRuntimeFactory?.bindSharedToolRuntime?.(toolRuntime) ??
      agentVersionRuntimeFactory ??
      sharedAgentVersionRuntimeFactory(config, toolRuntime),
  });
  const runtimeResolverOwner = lifetime.own(runtimeResolver, { phase: "stop" });
  const pluginQueryHost =
    config.installedPluginExecution?.historicalQuery === undefined
      ? null
      : composeInstalledPluginQueryHost({
          store,
          extensions: store.extensionStore(),
          config: config.installedPluginExecution,
          runtimeResolver,
          tenantId: config.runtimeTenantId,
          ...(executionReadiness === null ? {} : { executionReadiness }),
        });
  if (pluginQueryHost !== null) {
    const queryOwner = lifetime.own(pluginQueryHost, { phase: "stop" });
    // A pending historical readiness borrower must finish before its resolver is fenced.
    lifetime.own(
      {
        async close() {
          const errors: unknown[] = [];
          for (const owner of [queryOwner, runtimeResolverOwner]) {
            try {
              await owner.close();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length)
            throw new AggregateError(
              errors,
              "installed_plugin_query_cleanup_failed",
            );
        },
      },
      { phase: "stop" },
    );
    queryOwner.delegate();
    runtimeResolverOwner.delegate();
  }
  const storageCapacity = createLocalStorageAdmissionOwner({
    configured: config.storageAdmission,
    paths: config.localStoragePaths ?? [],
  });
  lifetime.own(storageCapacity, { phase: "stop" });
  const execution = new RunExecutionService({
    storageAdmission: storageCapacity.admission,
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
      pluginTaskAdmissions,
      installedPluginRuntimeResolver,
      policy,
    },
    {
      ownerId: config.ownerId ?? `runtime-worker:${ids.nextId("outboxLease")}`,
      nextLeaseId: () => ids.nextId("outboxLease"),
      workItemExecutionScope,
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
  lifetime.own(worker, { phase: "stop" });
  let providerProbeServer: RuntimeProviderProbeServer | null = null;
  let workspacePrivateServer: RuntimeWorkspacePrivateServer | null = null;
  let extensionHostServer: RuntimeExtensionHostServer | null = null;
  const extensionHost =
    config.extensionHost ??
    (config.extensionRuntime?.privateHost === undefined
      ? undefined
      : {
          ...config.extensionRuntime.privateHost,
          resolveActor: config.extensionRuntime.resolveActor,
          authorization: config.extensionRuntime.authorization,
        });
  if (extensionHost !== undefined) {
    extensionHostServer = await startRuntimeExtensionHostServer({
      ...extensionHost,
      service: new RuntimeExtensionHostService({
        resolveActor: extensionHost.resolveActor,
        authorization: extensionHost.authorization,
        runtimeResolver,
        deployments: store,
      }),
    });
    lifetime.own(extensionHostServer, { phase: "stop" });
  }
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
  if (providerProbeServer !== null)
    lifetime.own(providerProbeServer, { phase: "stop" });
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
    const workspaceDispatchService = new RuntimeWorkspaceDispatchService({
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
  if (workspacePrivateServer !== null)
    lifetime.own(workspacePrivateServer, { phase: "stop" });
  return {
    worker,
    agentVersion,
    agentVersionRegistry,
    providerProbeOrigin: providerProbeServer?.origin ?? null,
    workspacePrivateOrigin: workspacePrivateServer?.origin ?? null,
    extensionHostOrigin: extensionHostServer?.origin ?? null,
    pluginQueryHost,
    pluginExecutionReadiness:
      executionReadiness === null
        ? null
        : Object.freeze({
            assertReady:
              executionReadiness.assertReady.bind(executionReadiness),
          }),
    close: () => lifetime.close(),
  };
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
