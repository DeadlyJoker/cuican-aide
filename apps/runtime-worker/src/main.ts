import { loadWorkflowDeploymentEnvironment } from "@crewon/agent-version/workflow-deployment-config";
import { RuntimeCompositionLifetime } from "./runtime-composition-lifetime.ts";
import { installRuntimeProcessShutdown } from "./runtime-process-shutdown.ts";
import {
  FilesystemArtifactStore,
  loadArtifactEncryptionKey,
} from "@crewon/artifacts";

import {
  createPostgresRuntimeWorker,
  createStandaloneRuntimeWorker,
  type StandaloneRuntimeWorker,
} from "./standalone-composition.ts";
import {
  loadAgentVersionRuntimeFactory,
  loadRemoteMcpManifestBindings,
} from "./runtime-binding-config.ts";
import {
  createConfiguredToolRuntime,
  createModelTransport,
  environmentOr,
  parseNativeWorkspaceReadCatalog,
  parseNonNegativeInteger,
  parsePositiveInteger,
  requiredEnvironment,
} from "./runtime-process-environment.ts";
import { takeRuntimeNativeBootstrap } from "./runtime-native-bootstrap.ts";
import {
  createRuntimeNativeWorkspaceResources,
  type RuntimeNativeWorkspaceResources,
} from "./runtime-native-workspace.ts";
import { DesktopProviderProbeEgressPolicy } from "./provider-probe-egress.ts";
import {
  parseRuntimeWorkerSecurityMode,
  resolveRuntimeProviderProbeEnvironment,
} from "./runtime-provider-probe-environment.ts";
import { runtimeNativeReadinessLines } from "./runtime-native-readiness.ts";
import {
  createRuntimeNativeRemoteMcpOwner,
  type RuntimeNativeRemoteMcpOwner,
} from "./runtime-native-remote-mcp.ts";
import { resolveRuntimeExtensionEnvironment } from "./extensions/extension-process-environment.ts";
import { loadExtensionReleaseInput } from "./extensions/extension-release-input.ts";
import type { RuntimeExtensionCompositionConfig } from "./extensions/extension-runtime-composition.ts";
import { INSTALLED_PLUGIN_WORKER_CONFIG_ENV } from "./plugins/installed-plugin-worker-config.ts";
import { loadInstalledPluginAuthorityConfig } from "./plugins/installed-plugin-authority-config.ts";
import {
  prepareInstalledPluginWorkerAuthority,
  type InstalledPluginWorkerAuthority,
} from "./plugins/installed-plugin-worker-authority.ts";
import { resolveInstalledPluginPeerEnvironment } from "./plugins/installed-plugin-peer-environment.ts";
import { loadPluginCreditSettlementWorkerConfigFromEnvironment } from "./plugins/plugin-credit-settlement-worker-config.ts";
import { createPluginCreditSettlementWorkerAuthority } from "./plugins/plugin-credit-settlement-worker-authority.ts";
import type { PluginCreditSettlementDeploymentAuthority } from "./plugins/plugin-credit-settlement-runtime-types.ts";
import { readInstalledPluginReleaseDocument } from "./plugins/installed-plugin-release-document.ts";
import {
  loadInstalledPluginRelease,
  composeInstalledPluginReleaseRuntimeFactory,
  type LoadedInstalledPluginRelease,
} from "./plugins/installed-plugin-release-loader.ts";
import {
  resolveRuntimeBootstrapAgent,
  resolveRuntimeBootstrapRoute,
} from "./runtime-bootstrap-defaults.ts";

const environment = Object.freeze({ ...process.env });
const bootstrapAgent = resolveRuntimeBootstrapAgent(environment);
const agentVersionRuntimeBindingsPath =
  environment.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH?.trim();
const nativeBootstrap = takeRuntimeNativeBootstrap();
const initialized = await (async () => {
  let remoteMcpOwner: RuntimeNativeRemoteMcpOwner | undefined;
  let transport: ReturnType<typeof createModelTransport> | undefined;
  let toolRuntime: Awaited<ReturnType<typeof createConfiguredToolRuntime>>;
  let artifactAuthority: ReturnType<typeof createConfiguredArtifactAuthority>;
  let installedPluginAuthority: InstalledPluginWorkerAuthority | undefined;
  let installedPluginRelease: LoadedInstalledPluginRelease | undefined;
  let pluginCreditSettlementAuthority:
    | PluginCreditSettlementDeploymentAuthority
    | undefined;
  try {
    const securityMode = parseRuntimeWorkerSecurityMode(
      environment.CREWON_CONTROL_SECURITY_MODE ?? "standalone",
    );
    const workflow = loadWorkflowDeploymentEnvironment(environment, securityMode);
    const pluginCreditSettlementConfiguration =
      loadPluginCreditSettlementWorkerConfigFromEnvironment(environment);
    const installedPluginConfigPath =
      environment[INSTALLED_PLUGIN_WORKER_CONFIG_ENV];
    const installedPluginPeer =
      resolveInstalledPluginPeerEnvironment(environment);
    if (
      installedPluginPeer !== undefined &&
      installedPluginConfigPath === undefined
    )
      throw new Error("installed_plugin_peer_deployment_invalid");
    const installedPluginConfiguration =
      installedPluginConfigPath === undefined
        ? undefined
        : loadInstalledPluginAuthorityConfig(
            installedPluginConfigPath,
            environment,
          );
    const extensionEnvironment = resolveRuntimeExtensionEnvironment(
      environment,
      securityMode,
    );
    if (
      installedPluginConfiguration !== undefined &&
      extensionEnvironment !== undefined
    )
      throw new Error("installed_plugin_release_legacy_runtime_conflict");
    if (extensionEnvironment !== undefined && nativeBootstrap !== null) {
      throw new Error("extension_native_bootstrap_unsupported");
    }
    const ambientProviderProbe = resolveRuntimeProviderProbeEnvironment(
      environment,
      securityMode,
      new DesktopProviderProbeEgressPolicy(),
    );
    if (
      nativeBootstrap?.provider !== null &&
      nativeBootstrap?.provider !== undefined &&
      ambientProviderProbe !== undefined
    ) {
      throw new Error("runtime_provider_probe_bootstrap_conflict");
    }
    const nativeWorkspaceReadCatalog = parseNativeWorkspaceReadCatalog(
      environment.CREWON_NATIVE_WORKSPACE_READ_ENABLED,
    );
    if (
      (nativeWorkspaceReadCatalog === "enabled") !==
      (nativeBootstrap?.workspace !== null &&
        nativeBootstrap?.workspace !== undefined)
    ) {
      throw new Error("runtime_workspace_read_bootstrap_mismatch");
    }
    const runtimeTenantId =
      nativeBootstrap?.workspace?.authority.tenantId ??
      environmentOr("CREWON_TENANT_ID", "standalone-tenant");
    const standaloneRoute = resolveRuntimeBootstrapRoute(environment);
    const route = {
      ...standaloneRoute,
      runtimeGeneration:
        nativeBootstrap?.workspace?.authority.runtimeBindingId ??
        standaloneRoute.runtimeGeneration,
      policySnapshotId:
        nativeBootstrap?.workspace?.authority.policySnapshotId ??
        standaloneRoute.policySnapshotId,
      workspaceBindingId:
        nativeBootstrap?.workspace?.authority.workspaceBindingId ??
        environment.CREWON_WORKSPACE_BINDING_ID?.trim() ??
        null,
    };
    if (
      extensionEnvironment !== undefined &&
      extensionEnvironment.actor.tenantId !== runtimeTenantId
    ) {
      throw new Error("runtime_deployment_tenant_mismatch");
    }
    const extensionRelease =
      extensionEnvironment?.runtimeBindingsPath === undefined ||
      extensionEnvironment.runtimeBindingsPath === null
        ? null
        : loadExtensionReleaseInput({
            environment,
            tenantId: runtimeTenantId,
            defaultAgentVersionId: route.agentVersionId,
          });
    const extensionRuntime: RuntimeExtensionCompositionConfig | undefined =
      extensionRelease === null ||
      extensionEnvironment === undefined ||
      extensionEnvironment.runtimeBindingsPath === null
        ? undefined
        : {
            runtimeBindingsPath: extensionEnvironment.runtimeBindingsPath,
            ...(agentVersionRuntimeBindingsPath
              ? {
                  additionalRuntimeBindingsPaths: [
                    agentVersionRuntimeBindingsPath,
                  ],
                }
              : {}),
            authorization: extensionEnvironment.host.authorization,
            resolveActor: extensionEnvironment.host.resolveActor,
            environment,
          };
    if (
      nativeBootstrap?.credentialBindings !== null &&
      nativeBootstrap?.credentialBindings !== undefined
    ) {
      if (
        agentVersionRuntimeBindingsPath === undefined ||
        nativeBootstrap.workspace === null ||
        route.workspaceBindingId === null
      ) {
        throw new Error("runtime_native_remote_mcp_invalid");
      }
      remoteMcpOwner = createRuntimeNativeRemoteMcpOwner({
        credentials: nativeBootstrap.credentialBindings,
        expectedAuthority: {
          tenantId: runtimeTenantId,
          workspaceBindingId: route.workspaceBindingId,
          runtimeBindingId: route.runtimeGeneration,
          agentVersionId: route.agentVersionId,
        },
        manifestBindings: loadRemoteMcpManifestBindings(
          agentVersionRuntimeBindingsPath,
        ),
      });
    }
    const baseAgentVersionRuntimeFactory =
      agentVersionRuntimeBindingsPath && extensionRelease === null
        ? loadAgentVersionRuntimeFactory(
            agentVersionRuntimeBindingsPath,
            environment,
            remoteMcpOwner?.dependencies,
            nativeBootstrap?.apiKey,
          )
        : undefined;
    if (installedPluginConfiguration !== undefined) {
      installedPluginAuthority = await prepareInstalledPluginWorkerAuthority(
        installedPluginConfiguration,
        environment,
      );
      const document = readInstalledPluginReleaseDocument(
        installedPluginAuthority.releaseDocumentPath,
      );
      if (
        document.tenantId !== runtimeTenantId ||
        document.defaultAgentVersionId !== route.agentVersionId
      )
        throw new Error("installed_plugin_release_bootstrap_mismatch");
      installedPluginRelease = await loadInstalledPluginRelease({
        document,
        installRoot: installedPluginAuthority.installRoot,
        authorizeRead: installedPluginAuthority.authorizeRead,
        environment,
        ...(remoteMcpOwner === undefined
          ? {}
          : { remoteMcpDependencies: remoteMcpOwner.dependencies }),
        ...(nativeBootstrap?.apiKey === undefined
          ? {}
          : { nativeProviderApiKey: nativeBootstrap.apiKey }),
      });
    }
    const agentVersionRuntimeFactory =
      installedPluginRelease === undefined
        ? baseAgentVersionRuntimeFactory
        : composeInstalledPluginReleaseRuntimeFactory({
            release: installedPluginRelease,
            ...(baseAgentVersionRuntimeFactory === undefined
              ? {}
              : {
                  base: {
                    factory: baseAgentVersionRuntimeFactory,
                    deployments:
                      baseAgentVersionRuntimeFactory.deploymentBindings(
                        runtimeTenantId,
                      ),
                  },
                }),
          });
    if (
      pluginCreditSettlementConfiguration !== undefined &&
      pluginCreditSettlementConfiguration.scope.tenantId !== runtimeTenantId
    )
      throw new Error("plugin_credit_settlement_tenant_mismatch");
    const pluginCreditSettlement =
      pluginCreditSettlementConfiguration === undefined
        ? undefined
        : {
            scope: pluginCreditSettlementConfiguration.scope,
            authority: (pluginCreditSettlementAuthority =
              createPluginCreditSettlementWorkerAuthority(
                pluginCreditSettlementConfiguration,
              )),
            batchSize: pluginCreditSettlementConfiguration.batchSize,
            intervalMs: pluginCreditSettlementConfiguration.intervalMs,
            maxRoundMs: pluginCreditSettlementConfiguration.maxRoundMs,
            migrate: pluginCreditSettlementConfiguration.migrate,
          };
    transport = createModelTransport(
      environmentOr("CREWON_MODEL_ADAPTER", "responses", environment),
      {
        apiKey: nativeBootstrap?.apiKey,
        providerId: nativeBootstrap?.provider?.providerId,
      },
      environment,
    );
    toolRuntime = await createConfiguredToolRuntime(environment);
    artifactAuthority = createConfiguredArtifactAuthority();
    return {
      agentVersionRuntimeFactory,
      extensionEnvironment,
      extensionRelease,
      extensionRuntime,
      installedPluginAuthority,
      installedPluginRelease,
      installedPluginPeer,
      pluginCreditSettlement,
      ambientProviderProbe,
      artifactAuthority,
      nativeWorkspaceReadCatalog,
      remoteMcpOwner,
      route,
      runtimeTenantId,
      securityMode,
      workflow,
      toolRuntime,
      transport,
    };
  } catch (error) {
    await Promise.allSettled(
      [
        () => installedPluginRelease?.close(),
        () => installedPluginAuthority?.close(),
        () => pluginCreditSettlementAuthority?.close(),
        () => artifactAuthority?.store.close(),
        () => toolRuntime?.close?.(),
        () => transport?.close?.(),
        () => nativeBootstrap?.credentialBindings?.destroy(),
        () => remoteMcpOwner?.destroy(),
      ].map((close) => Promise.resolve().then(close)),
    );
    throw error;
  }
})();
const {
  agentVersionRuntimeFactory,
  ambientProviderProbe,
  artifactAuthority,
  extensionEnvironment,
  extensionRelease,
  extensionRuntime,
  installedPluginAuthority,
  installedPluginRelease,
  installedPluginPeer,
  pluginCreditSettlement,
  nativeWorkspaceReadCatalog,
  remoteMcpOwner,
  route,
  runtimeTenantId,
  toolRuntime,
  transport,
  workflow,
} = initialized;

let runtime: StandaloneRuntimeWorker;
let nativeWorkspaceResources: RuntimeNativeWorkspaceResources | undefined;
let compositionOwnsResources = false;
try {
  nativeWorkspaceResources =
    nativeBootstrap?.workspace === null ||
    nativeBootstrap?.workspace === undefined
      ? undefined
      : createRuntimeNativeWorkspaceResources({
          bootstrap: nativeBootstrap.workspace,
          runtimeTenantId,
          route,
        });
  const config = {
    workflow,
    localStoragePaths:
      artifactAuthority === undefined
        ? []
        : [
            requiredEnvironment("CREWON_ARTIFACT_ROOT"),
            requiredEnvironment("CREWON_ARTIFACT_DB_PATH"),
          ],
    runtimeTenantId,
    route,
    transport,
    agentInstructions: bootstrapAgent.instructions,
    toolRuntime,
    ...(artifactAuthority === undefined
      ? {}
      : {
          artifactStore: artifactAuthority.store,
          artifactEncryptionKeyId: artifactAuthority.keyId,
        }),
    ownerId: environment.CREWON_WORKER_OWNER_ID?.trim() || undefined,
    workerConcurrency:
      environment.CREWON_WORKER_ONCE === "1"
        ? 1
        : parsePositiveInteger(
            environment.CREWON_WORKER_CONCURRENCY ?? "2",
            "CREWON_WORKER_CONCURRENCY_invalid",
          ),
    streamMaxRetries: bootstrapAgent.streamMaxRetries,
    maxToolRounds: bootstrapAgent.maxToolRounds,
    leaseDurationMs: parsePositiveInteger(
      environment.CREWON_WORKER_LEASE_DURATION_MS ?? "30000",
      "CREWON_WORKER_LEASE_DURATION_MS_invalid",
    ),
    retryAfterMs: parseNonNegativeInteger(
      environment.CREWON_WORKER_RETRY_AFTER_MS ?? "1000",
      "CREWON_WORKER_RETRY_AFTER_MS_invalid",
    ),
    approvalRecheckMs: parsePositiveInteger(
      environment.CREWON_TOOL_APPROVAL_RECHECK_MS ?? "1000",
      "CREWON_TOOL_APPROVAL_RECHECK_MS_invalid",
    ),
    approvalTtlMs: parsePositiveInteger(
      environment.CREWON_TOOL_APPROVAL_TTL_MS ?? "86400000",
      "CREWON_TOOL_APPROVAL_TTL_MS_invalid",
    ),
    scanIntervalMs:
      environment.CREWON_WORKER_ONCE === "1"
        ? null
        : parsePositiveInteger(
            environment.CREWON_WORKER_SCAN_INTERVAL_MS ?? "1000",
            "CREWON_WORKER_SCAN_INTERVAL_MS_invalid",
          ),
    cancellationPollIntervalMs: parsePositiveInteger(
      environment.CREWON_WORKER_CANCELLATION_POLL_INTERVAL_MS ?? "250",
      "CREWON_WORKER_CANCELLATION_POLL_INTERVAL_MS_invalid",
    ),
    autoCompactAtTokens: bootstrapAgent.autoCompactAtTokens,
    modelContextWindowTokens: bootstrapAgent.contextWindowTokens,
    expectedAgentVersionDigest:
      environment.CREWON_AGENT_VERSION_CONTENT_DIGEST?.trim() || null,
    nativeWorkspaceReadCatalog,
    ...(extensionEnvironment === undefined
      ? {}
      : {
          extensionHost: extensionEnvironment.host,
          extensionExecutionMode: extensionEnvironment.executionMode,
        }),
    ...(extensionRelease === null
      ? {}
      : {
          additionalAgentVersions: extensionRelease.versions,
          extensionRuntime,
        }),
    ...(pluginCreditSettlement === undefined ? {} : { pluginCreditSettlement }),
    ...(installedPluginRelease === undefined
      ? {}
      : {
          installedPluginRelease,
          installedPluginExecution:
            installedPluginAuthority!.installedPluginExecution,
          installedPluginAuthorityOwner: installedPluginAuthority!,
          ...(installedPluginAuthority!.projectPlanning === undefined
            ? {}
            : {
                projectPlanning: installedPluginAuthority!.projectPlanning,
              }),
          ...(installedPluginPeer === undefined
            ? {}
            : {
                installedPluginPeer: {
                  ...installedPluginPeer,
                  resolveProfile: installedPluginAuthority!.resolveProfile,
                },
              }),
          additionalAgentVersions: installedPluginRelease.versions,
        }),
    ...(agentVersionRuntimeFactory === undefined
      ? {}
      : {
          agentVersionRuntimeFactory,
          agentVersionDeployments: agentVersionRuntimeFactory
            .deploymentBindings(runtimeTenantId)
            .filter(
              (deployment) =>
                deployment.agentVersionId !== route.agentVersionId,
            ),
        }),
    ...(nativeBootstrap?.provider === null ||
    nativeBootstrap?.provider === undefined
      ? ambientProviderProbe === undefined
        ? {}
        : { providerProbe: ambientProviderProbe }
      : {
          providerProbe: {
            port: nativeBootstrap.probe.port,
            token: nativeBootstrap.probe.token,
            runtimeBinding: nativeBootstrap.provider,
            secrets: {
              resolve: () =>
                nativeBootstrap.apiKey === null
                  ? null
                  : {
                      value: nativeBootstrap.apiKey,
                      release: () => {},
                    },
            },
            egressPolicy: new DesktopProviderProbeEgressPolicy(),
          },
        }),
    ...(nativeWorkspaceResources === undefined
      ? {}
      : {
          workspacePrivate: nativeWorkspaceResources.config,
          workspaceReadFile: nativeWorkspaceResources.readFile,
        }),
  };
  const connectionString = environment.CREWON_CONTROL_DATABASE_URL?.trim();
  // Resolve the remaining configuration before transferring resources. The
  // composition owns every supplied closer from invocation, even on failure.
  const databasePath = connectionString
    ? undefined
    : requiredEnvironment("CREWON_CONTROL_DB_PATH");
  compositionOwnsResources = true;
  runtime = connectionString
    ? await createPostgresRuntimeWorker({
        ...config,
        connectionString,
        ...(environment.CREWON_CONTROL_DATABASE_SCHEMA?.trim()
          ? { schema: environment.CREWON_CONTROL_DATABASE_SCHEMA.trim() }
          : {}),
      })
    : await createStandaloneRuntimeWorker({
        ...config,
        databasePath: databasePath!,
      });
} catch (error) {
  if (!compositionOwnsResources) {
    await Promise.allSettled(
      [
        () => installedPluginRelease?.close(),
        () => installedPluginAuthority?.close(),
        () => pluginCreditSettlement?.authority.close(),
        () => nativeWorkspaceResources?.gateway.close(),
        () => nativeWorkspaceResources?.readGateway.close(),
        () => artifactAuthority?.store.close(),
        () => toolRuntime?.close?.(),
        () => transport.close?.(),
      ].map((close) => Promise.resolve().then(close)),
    );
  }
  await Promise.resolve()
    .then(() => remoteMcpOwner?.destroy())
    .catch(() => {});
  throw error;
}

function createConfiguredArtifactAuthority():
  | Readonly<{ store: FilesystemArtifactStore; keyId: string }>
  | undefined {
  const names = [
    "CREWON_ARTIFACT_ROOT",
    "CREWON_ARTIFACT_DB_PATH",
    "CREWON_ARTIFACT_ENCRYPTION_KEY_PATH",
    "CREWON_ARTIFACT_ENCRYPTION_KEY_ID",
  ] as const;
  const configured = names.filter((name) => process.env[name]?.trim().length);
  if (configured.length === 0) {
    return undefined;
  }
  if (configured.length !== names.length) {
    throw new Error("CREWON_ARTIFACT_CONFIGURATION_incomplete");
  }
  const keyId = requiredEnvironment("CREWON_ARTIFACT_ENCRYPTION_KEY_ID");
  return {
    keyId,
    store: new FilesystemArtifactStore({
      rootDirectory: requiredEnvironment("CREWON_ARTIFACT_ROOT"),
      databasePath: requiredEnvironment("CREWON_ARTIFACT_DB_PATH"),
      encryptionKey: loadArtifactEncryptionKey(
        requiredEnvironment("CREWON_ARTIFACT_ENCRYPTION_KEY_PATH"),
      ),
      keyId,
    }),
  };
}

const processLifetime = new RuntimeCompositionLifetime();
processLifetime.own(runtime, { phase: "stop" });
if (remoteMcpOwner !== undefined)
  processLifetime.own(
    { close: () => remoteMcpOwner.destroy() },
    { phase: "resources" },
  );

try {
  await transport.prewarm?.(new AbortController().signal);
} catch (error) {
  await processLifetime.close().catch(() => {});
  throw error;
}

if (environment.CREWON_WORKER_ONCE === "1") {
  try {
    const outcome = await runtime.worker.wake();
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } catch (error) {
    await processLifetime.close().catch(() => {});
    throw error;
  }
  await processLifetime.close();
} else {
  installRuntimeProcessShutdown({
    host: process,
    close: () => processLifetime.close(),
    reportFailure: () => {
      process.stderr.write("CrewON Runtime Worker shutdown failed\n");
    },
  });
  runtime.start();
  process.stdout.write("CrewON Runtime Worker started\n");
  if (runtime.extensionHostOrigin !== null) {
    process.stdout.write(
      `CrewON Extension Host origin ${runtime.extensionHostOrigin}\n`,
    );
  }
  if (runtime.installedPluginPeerOrigin !== null) {
    process.stdout.write(
      `CrewON Installed Plugin Peer origin ${runtime.installedPluginPeerOrigin}\n`,
    );
  }
  for (const line of runtimeNativeReadinessLines({
    providerRuntimeBindingId:
      nativeBootstrap?.provider?.runtimeBindingId ?? null,
    workspacePrivateOrigin: runtime.workspacePrivateOrigin,
    workspaceRuntimeBindingId:
      nativeBootstrap?.workspace?.authority.runtimeBindingId ?? null,
  })) {
    process.stdout.write(`${line}\n`);
  }
}
