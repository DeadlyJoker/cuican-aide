import {
  FilesystemArtifactStore,
  loadArtifactEncryptionKey,
} from "@crewon/artifacts";

import {
  createPostgresRuntimeWorker,
  createStandaloneRuntimeWorker,
  type StandaloneRuntimeWorker,
} from "./standalone-composition.ts";
import { loadAgentVersionRuntimeFactory } from "./runtime-binding-config.ts";
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

const agentVersionRuntimeBindingsPath =
  process.env.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH?.trim();
const agentVersionRuntimeFactory = agentVersionRuntimeBindingsPath
  ? loadAgentVersionRuntimeFactory(agentVersionRuntimeBindingsPath)
  : undefined;

const nativeBootstrap = takeRuntimeNativeBootstrap();
const securityMode = parseRuntimeWorkerSecurityMode(
  process.env.CREWON_CONTROL_SECURITY_MODE ?? "standalone",
);
const ambientProviderProbe = resolveRuntimeProviderProbeEnvironment(
  process.env,
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
  process.env.CREWON_NATIVE_WORKSPACE_READ_ENABLED,
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
const route = {
  authorityId: environmentOr("CREWON_AUTHORITY_ID", "standalone-authority"),
  runtimeGeneration:
    nativeBootstrap?.workspace?.authority.runtimeBindingId ??
    environmentOr("CREWON_RUNTIME_GENERATION", "ts-v0"),
  agentVersionId: environmentOr("CREWON_AGENT_VERSION_ID", "default-agent-v1"),
  policySnapshotId:
    nativeBootstrap?.workspace?.authority.policySnapshotId ??
    environmentOr("CREWON_POLICY_SNAPSHOT_ID", "standalone-policy-v0"),
  workspaceBindingId:
    nativeBootstrap?.workspace?.authority.workspaceBindingId ??
    process.env.CREWON_WORKSPACE_BINDING_ID?.trim() ??
    null,
};
const transport = createModelTransport(
  environmentOr("CREWON_MODEL_ADAPTER", "responses"),
  { apiKey: nativeBootstrap?.apiKey },
);
const toolRuntime = await createConfiguredToolRuntime();
const artifactAuthority = createConfiguredArtifactAuthority();

let runtime: StandaloneRuntimeWorker;
let nativeWorkspaceResources: RuntimeNativeWorkspaceResources | undefined;
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
    : await createStandaloneRuntimeWorker({
        ...config,
        databasePath: requiredEnvironment("CREWON_CONTROL_DB_PATH"),
      });
} catch (error) {
  await Promise.allSettled([
    nativeWorkspaceResources?.gateway.close(),
    nativeWorkspaceResources?.readGateway.close(),
  ]);
  await artifactAuthority?.store.close();
  await toolRuntime?.close?.();
  await transport.close?.();
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
  throw error;
}

if (process.env.CREWON_WORKER_ONCE === "1") {
  const outcome = await runtime.worker.wake();
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  await runtime.close();
} else {
  runtime.worker.start();
  process.stdout.write("CrewON Runtime Worker started\n");
  for (const line of runtimeNativeReadinessLines({
    providerRuntimeBindingId:
      nativeBootstrap?.provider?.runtimeBindingId ?? null,
    workspacePrivateOrigin: runtime.workspacePrivateOrigin,
    workspaceRuntimeBindingId:
      nativeBootstrap?.workspace?.authority.runtimeBindingId ?? null,
  })) {
    process.stdout.write(`${line}\n`);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void runtime.close().finally(() => process.exit(0));
    });
  }
}
