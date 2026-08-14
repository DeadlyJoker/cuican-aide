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
import { resolveRuntimeProductionWorkspaceEnvironment } from "./runtime-production-workspace-environment.ts";
import { runtimeNativeReadinessLines } from "./runtime-native-readiness.ts";
import {
  createRuntimeNativeRemoteMcpOwner,
  type RuntimeNativeRemoteMcpOwner,
} from "./runtime-native-remote-mcp.ts";

const agentVersionRuntimeBindingsPath =
  process.env.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH?.trim();
const nativeBootstrap = takeRuntimeNativeBootstrap();
const initialized = await (async () => {
  let remoteMcpOwner: RuntimeNativeRemoteMcpOwner | undefined;
  let transport: ReturnType<typeof createModelTransport> | undefined;
  let toolRuntime: Awaited<ReturnType<typeof createConfiguredToolRuntime>>;
  let artifactAuthority: ReturnType<typeof createConfiguredArtifactAuthority>;
  try {
    const securityMode = parseRuntimeWorkerSecurityMode(
      process.env.CREWON_CONTROL_SECURITY_MODE ?? "standalone",
    );
    const ambientProviderProbe = resolveRuntimeProviderProbeEnvironment(
      process.env,
      securityMode,
      new DesktopProviderProbeEgressPolicy(),
    );
    const productionWorkspace = resolveRuntimeProductionWorkspaceEnvironment(
      process.env,
      securityMode,
    );
    if (
      nativeBootstrap?.provider !== null &&
      nativeBootstrap?.provider !== undefined &&
      ambientProviderProbe !== undefined
    ) {
      throw new Error("runtime_provider_probe_bootstrap_conflict");
    }
    if (
      nativeBootstrap?.workspace !== null &&
      nativeBootstrap?.workspace !== undefined &&
      productionWorkspace !== undefined
    ) {
      throw new Error("runtime_workspace_bootstrap_conflict");
    }
    const workspaceBootstrap =
      nativeBootstrap?.workspace ?? productionWorkspace ?? null;
    const nativeWorkspaceReadCatalog =
      productionWorkspace === undefined
        ? parseNativeWorkspaceReadCatalog(
            process.env.CREWON_NATIVE_WORKSPACE_READ_ENABLED,
          )
        : "enabled";
    if (
      (nativeWorkspaceReadCatalog === "enabled") !==
      (workspaceBootstrap !== null)
    ) {
      throw new Error("runtime_workspace_read_bootstrap_mismatch");
    }
    const runtimeTenantId =
      workspaceBootstrap?.authority.tenantId ??
      environmentOr("CREWON_TENANT_ID", "standalone-tenant");
    const route = {
      authorityId: environmentOr("CREWON_AUTHORITY_ID", "standalone-authority"),
      runtimeGeneration:
        workspaceBootstrap?.authority.runtimeBindingId ??
        environmentOr("CREWON_RUNTIME_GENERATION", "ts-v0"),
      agentVersionId: environmentOr(
        "CREWON_AGENT_VERSION_ID",
        "default-agent-v1",
      ),
      policySnapshotId:
        workspaceBootstrap?.authority.policySnapshotId ??
        environmentOr("CREWON_POLICY_SNAPSHOT_ID", "standalone-policy-v0"),
      workspaceBindingId:
        workspaceBootstrap?.authority.workspaceBindingId ??
        process.env.CREWON_WORKSPACE_BINDING_ID?.trim() ??
        null,
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
    const agentVersionRuntimeFactory = agentVersionRuntimeBindingsPath
      ? loadAgentVersionRuntimeFactory(
          agentVersionRuntimeBindingsPath,
          process.env,
          remoteMcpOwner?.dependencies,
        )
      : undefined;
    transport = createModelTransport({ apiKey: nativeBootstrap?.apiKey });
    toolRuntime = await createConfiguredToolRuntime();
    artifactAuthority = createConfiguredArtifactAuthority();
    return {
      agentVersionRuntimeFactory,
      ambientProviderProbe,
      artifactAuthority,
      nativeWorkspaceReadCatalog,
      remoteMcpOwner,
      route,
      runtimeTenantId,
      securityMode,
      toolRuntime,
      transport,
      workspaceBootstrap,
    };
  } catch (error) {
    await Promise.allSettled([
      artifactAuthority?.store.close(),
      toolRuntime?.close?.(),
      transport?.close?.(),
    ]);
    nativeBootstrap?.credentialBindings?.destroy();
    remoteMcpOwner?.destroy();
    throw error;
  }
})();
const {
  agentVersionRuntimeFactory,
  ambientProviderProbe,
  artifactAuthority,
  nativeWorkspaceReadCatalog,
  remoteMcpOwner,
  route,
  runtimeTenantId,
  toolRuntime,
  transport,
  workspaceBootstrap,
} = initialized;

let runtime: StandaloneRuntimeWorker;
let nativeWorkspaceResources: RuntimeNativeWorkspaceResources | undefined;
try {
  nativeWorkspaceResources =
    workspaceBootstrap === null
      ? undefined
      : createRuntimeNativeWorkspaceResources({
          bootstrap: workspaceBootstrap,
          runtimeTenantId,
          route,
        });
  const config = {
    runtimeTenantId,
    route,
    transport,
    agentInstructions: process.env.CREWON_AGENT_INSTRUCTIONS?.trim() || null,
    toolRuntime,
    ...(artifactAuthority === undefined
      ? {}
      : {
          artifactStore: artifactAuthority.store,
          artifactEncryptionKeyId: artifactAuthority.keyId,
        }),
    ownerId: process.env.CREWON_WORKER_OWNER_ID?.trim() || undefined,
    streamMaxRetries: parseNonNegativeInteger(
      process.env.CREWON_RESPONSES_STREAM_MAX_RETRIES ?? "5",
      "CREWON_RESPONSES_STREAM_MAX_RETRIES_invalid",
    ),
    leaseDurationMs: parsePositiveInteger(
      process.env.CREWON_WORKER_LEASE_DURATION_MS ?? "30000",
      "CREWON_WORKER_LEASE_DURATION_MS_invalid",
    ),
    retryAfterMs: parseNonNegativeInteger(
      process.env.CREWON_WORKER_RETRY_AFTER_MS ?? "1000",
      "CREWON_WORKER_RETRY_AFTER_MS_invalid",
    ),
    approvalRecheckMs: parsePositiveInteger(
      process.env.CREWON_TOOL_APPROVAL_RECHECK_MS ?? "1000",
      "CREWON_TOOL_APPROVAL_RECHECK_MS_invalid",
    ),
    approvalTtlMs: parsePositiveInteger(
      process.env.CREWON_TOOL_APPROVAL_TTL_MS ?? "86400000",
      "CREWON_TOOL_APPROVAL_TTL_MS_invalid",
    ),
    scanIntervalMs:
      process.env.CREWON_WORKER_ONCE === "1"
        ? null
        : parsePositiveInteger(
            process.env.CREWON_WORKER_SCAN_INTERVAL_MS ?? "1000",
            "CREWON_WORKER_SCAN_INTERVAL_MS_invalid",
          ),
    cancellationPollIntervalMs: parsePositiveInteger(
      process.env.CREWON_WORKER_CANCELLATION_POLL_INTERVAL_MS ?? "250",
      "CREWON_WORKER_CANCELLATION_POLL_INTERVAL_MS_invalid",
    ),
    autoCompactAtTokens: parsePositiveInteger(
      process.env.CREWON_AUTO_COMPACT_AT_TOKENS ?? "200000",
      "CREWON_AUTO_COMPACT_AT_TOKENS_invalid",
    ),
    modelContextWindowTokens: parsePositiveInteger(
      process.env.CREWON_MODEL_CONTEXT_WINDOW_TOKENS ?? "273000",
      "CREWON_MODEL_CONTEXT_WINDOW_TOKENS_invalid",
    ),
    expectedAgentVersionDigest:
      process.env.CREWON_AGENT_VERSION_CONTENT_DIGEST?.trim() || null,
    nativeWorkspaceReadCatalog,
    ...(agentVersionRuntimeFactory === undefined
      ? {}
      : {
          agentVersionRuntimeFactory,
          agentVersionDeployments:
            agentVersionRuntimeFactory.deploymentBindings(runtimeTenantId),
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
  const connectionString = process.env.CREWON_CONTROL_DATABASE_URL?.trim();
  runtime = connectionString
    ? await createPostgresRuntimeWorker({
        ...config,
        connectionString,
        ...(process.env.CREWON_CONTROL_DATABASE_SCHEMA?.trim()
          ? { schema: process.env.CREWON_CONTROL_DATABASE_SCHEMA.trim() }
          : {}),
      })
    : await (async () => {
        const databasePath = requiredEnvironment("CREWON_CONTROL_DB_PATH");
        return createStandaloneRuntimeWorker({
          ...config,
          databasePath,
        });
      })();
} catch (error) {
  await nativeWorkspaceResources?.close();
  await artifactAuthority?.store.close();
  await toolRuntime?.close?.();
  await transport.close?.();
  remoteMcpOwner?.destroy();
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

try {
  await transport.prewarm?.(new AbortController().signal);
} catch (error) {
  await runtime.close();
  remoteMcpOwner?.destroy();
  throw error;
}

if (process.env.CREWON_WORKER_ONCE === "1") {
  try {
    const outcome = await runtime.worker.wake();
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } finally {
    await runtime.close();
    remoteMcpOwner?.destroy();
  }
} else {
  runtime.worker.start();
  process.stdout.write("CrewON Runtime Worker started\n");
  for (const line of runtimeNativeReadinessLines({
    providerRuntimeBindingId:
      nativeBootstrap?.provider?.runtimeBindingId ??
      ambientProviderProbe?.runtimeBinding.runtimeBindingId ??
      null,
    workspacePrivateOrigin: runtime.workspacePrivateOrigin,
    workspaceRuntimeBindingId:
      workspaceBootstrap?.authority.runtimeBindingId ?? null,
  })) {
    process.stdout.write(`${line}\n`);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void runtime.close().finally(() => {
        remoteMcpOwner?.destroy();
        process.exit(0);
      });
    });
  }
}
