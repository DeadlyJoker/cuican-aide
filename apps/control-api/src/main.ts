import { loadWorkflowDeploymentEnvironment } from "@crewon/agent-version/workflow-deployment-config";
import { DEFAULT_OUTBOX_RETENTION } from "./outbox-retention-maintenance.ts";
import { desktopProjectMaterialStorageFromEnvironment } from "@crewon/media-runtime/desktop-project-material-archive";
import { installProcessShutdown } from "@crewon/process-lifecycle";
import type { AddressInfo } from "node:net";

import {
  FilesystemArtifactStore,
  loadArtifactEncryptionKey,
} from "@crewon/artifacts";

import { createProductionPostgresControlApi } from "./production-composition.ts";
import { resolveProductionPluginUiEnvironment } from "./production-plugin-ui-environment.ts";
import { resolveProductionPluginInstallationEnvironment } from "./production-plugin-installation-environment.ts";
import { resolveProductionDatabaseMaxPoolSize } from "./production-database-environment.ts";
import {
  loadProductionProjectEnvironment,
  composeProductionProjectStartup,
} from "./production-project-environment.ts";
import { ProductionProjectSourceUploadAuthorization } from "./production-project-source-upload-authorization.ts";
import { loadInstalledPluginConfigurationEnvironment } from "./installed-plugin-configuration-environment.ts";
import { loadInstalledPluginTaskEnvironment } from "./installed-plugin-task-environment.ts";
import {
  HttpControlTokenVerifier,
  HttpPolicyDecisionPort,
} from "./production-http-security-ports.ts";
import {
  DynamicPolicyAuthorization,
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
} from "./production-security-adapters.ts";
import {
  createPostgresControlApi,
  createStandaloneControlApi,
  createStandaloneControlApiWithExtensions,
  createStandaloneControlApiWithPlugins,
} from "./standalone-composition.ts";
import { createStandaloneTeamTaskControlApi } from "./standalone-team-task-control-api.ts";
import { loadDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { createDesktopNativeProjectWorkspaceRuntime } from "./desktop-native-project-workspace-runtime.ts";
import { loadDesktopInstalledPluginActivationEnvironment } from "./desktop-installed-plugin-activation-environment.ts";
import { loadDesktopNativePluginControlEnvironment } from "./desktop-native-plugin-control-environment.ts";
import { loadDesktopInstalledPluginTaskEnvironment } from "./desktop-installed-plugin-task-environment.ts";
import {
  captureDesktopInstalledPluginTaskStartup,
  snapshotDesktopInstalledPluginTaskEnvironment,
} from "./desktop-installed-plugin-task-startup.ts";
import { resolveControlExtensionWorkerEnvironment } from "./extension-worker-environment.ts";
import { resolveStandaloneWorkspaceWorkerEnvironment } from "./standalone-workspace-environment.ts";
import { resolveDesktopWorkspaceRegistryPath } from "./desktop-workspace-admission.ts";
import {
  candidateReadinessLine,
  resolvePausedAdmission,
  watchActivationInput,
} from "./paused-admission.ts";
import { resolveStandaloneProviderProbeWorkers } from "./standalone-provider-probe-environment.ts";
import { PimThreadSandbox } from "./pim-sandbox-client.ts";
import { watchSqliteOutboxAvailability } from "./sqlite-outbox-wakeup.ts";

const securityMode = parseSecurityMode(
  process.env.CREWON_CONTROL_SECURITY_MODE ?? "standalone",
);
const workflow = loadWorkflowDeploymentEnvironment(process.env, securityMode);
const desktopTaskEnvironment = snapshotDesktopInstalledPluginTaskEnvironment(
  process.env,
);
const pluginUiConfiguration = resolveProductionPluginUiEnvironment(
  process.env,
  securityMode,
);
const pluginInstallationConfiguration =
  resolveProductionPluginInstallationEnvironment(process.env, securityMode);
const extensionEnvironment = resolveControlExtensionWorkerEnvironment(
  process.env,
  securityMode,
);
const installedPluginTaskConfiguration =
  await loadInstalledPluginTaskEnvironment(process.env, securityMode);
const installedPluginConfiguration =
  await loadInstalledPluginConfigurationEnvironment(process.env, securityMode);
const projectStartup = await loadProductionProjectEnvironment(
  process.env,
  securityMode,
);
const maximumDatabasePoolSize = resolveProductionDatabaseMaxPoolSize(
  process.env,
  securityMode,
);
if (
  installedPluginConfiguration !== undefined &&
  installedPluginTaskConfiguration !== undefined
)
  throw new Error("installed_plugin_configuration_task_conflict");
if (
  (installedPluginTaskConfiguration !== undefined ||
    installedPluginConfiguration !== undefined) &&
  extensionEnvironment !== undefined
)
  throw new Error("installed_plugin_task_legacy_extension_conflict");
const activationGate = resolvePausedAdmission(process.env, securityMode);
const desktopWorkspaceRegistryPath = resolveDesktopWorkspaceRegistryPath(
  process.env,
  securityMode,
);
const standaloneTenantId =
  extensionEnvironment?.actor.tenantId ??
  environmentOr(
    "CREWON_TENANT_ID",
    "standalone-tenant",
    desktopTaskEnvironment ?? process.env,
  );
const providerProbeWorkers = resolveStandaloneProviderProbeWorkers(
  process.env,
  securityMode,
  standaloneTenantId,
);
const desktopEnvironment = desktopTaskEnvironment ?? process.env;
const connectionString = desktopEnvironment.CREWON_CONTROL_DATABASE_URL?.trim();
const desktopPluginBootstrapPath =
  desktopEnvironment.CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH;
const experimentalDurableTeamTasks = parseExperimentalDurableTeamTasks(
  process.env.CREWON_EXPERIMENTAL_DURABLE_TEAM_TASKS,
);
if (
  experimentalDurableTeamTasks &&
  (securityMode !== "standalone" ||
    connectionString ||
    desktopTaskEnvironment !== undefined ||
    desktopPluginBootstrapPath !== undefined ||
    extensionEnvironment !== undefined)
)
  throw new Error("experimental_durable_team_tasks_requires_plain_standalone");
if (
  desktopTaskEnvironment !== undefined &&
  (securityMode !== "standalone" || connectionString)
)
  throw new Error("desktop_plugin_standalone_sqlite_required");
const desktopPluginActivation =
  await loadDesktopInstalledPluginActivationEnvironment(desktopEnvironment, {
    securityMode,
    ...(desktopPluginBootstrapPath === undefined
      ? {}
      : { desktopBootstrapPath: desktopPluginBootstrapPath }),
  });
if (
  desktopPluginBootstrapPath !== undefined &&
  (securityMode !== "standalone" || connectionString)
)
  throw new Error("desktop_plugin_standalone_sqlite_required");
const desktopPluginTasks =
  desktopTaskEnvironment === undefined
    ? undefined
    : await loadDesktopInstalledPluginTaskEnvironment(desktopTaskEnvironment, {
        securityMode,
        ...(desktopPluginBootstrapPath === undefined
          ? {}
          : { desktopBootstrapPath: desktopPluginBootstrapPath }),
        ...(desktopTaskEnvironment.CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH ===
        undefined
          ? {}
          : {
              activationConfigPath:
                desktopTaskEnvironment.CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH,
            }),
      });
const desktopNativePluginControl = loadDesktopNativePluginControlEnvironment(
  desktopEnvironment,
  {
    securityMode,
    ...(desktopPluginBootstrapPath === undefined
      ? {}
      : { desktopBootstrapPath: desktopPluginBootstrapPath }),
    ...(desktopEnvironment.CREWON_CONTROL_DB_PATH === undefined
      ? {}
      : { databasePath: desktopEnvironment.CREWON_CONTROL_DB_PATH }),
  },
);
if (
  desktopNativePluginControl !== undefined &&
  (connectionString ||
    desktopPluginTasks !== undefined ||
    desktopPluginActivation !== undefined)
)
  throw new Error("desktop_native_plugin_authority_conflict");
// An explicit Native bootstrap is validated before allocating artifact or business persistence.
const desktopTaskActor =
  desktopPluginBootstrapPath === undefined
    ? undefined
    : (extensionEnvironment?.actor ?? {
        principalId: environmentOr(
          "CREWON_PRINCIPAL_ID",
          "standalone-principal",
          desktopEnvironment,
        ),
        actorId: environmentOr(
          "CREWON_ACTOR_ID",
          "standalone-actor",
          desktopEnvironment,
        ),
        tenantId: standaloneTenantId,
        spaceId: environmentOr(
          "CREWON_SPACE_ID",
          "standalone-space",
          desktopEnvironment,
        ),
      });
const desktopTaskBootstrap =
  desktopTaskActor === undefined
    ? undefined
    : await loadDesktopPluginConfiguration(desktopPluginBootstrapPath!, {
        actor: desktopTaskActor,
      });
if (desktopTaskBootstrap !== undefined)
  captureDesktopInstalledPluginTaskStartup(
    { desktopPluginTasks, desktopPluginActivation },
    desktopTaskBootstrap,
  );
const desktopProjectStartup =
  desktopTaskBootstrap === undefined || desktopTaskActor === undefined
    ? undefined
    : composeDesktopProjectStartup({
        configuration: desktopTaskBootstrap,
        actor: desktopTaskActor,
        ...(desktopNativePluginControl === undefined
          ? {}
          : { nativeControl: desktopNativePluginControl }),
        ...(desktopPluginTasks === undefined
          ? {}
          : { tasks: desktopPluginTasks }),
        ...(desktopPluginActivation === undefined
          ? {}
          : { activation: desktopPluginActivation }),
      });
const workspaceWorker = resolveStandaloneWorkspaceWorkerEnvironment(
  process.env,
  securityMode,
);
// The PIM sandbox is a standalone authority. Production does not have a
// tenant-bound workspace resolver yet, so keep the global sandbox route
// explicitly unavailable there instead of constructing a shared instance.
const sandbox =
  securityMode === "standalone" ? configuredPimSandbox(process.env) : undefined;
if (securityMode === "production" && connectionString === undefined) {
  throw new Error("CREWON_CONTROL_DATABASE_URL_required");
}
const artifactEncryptionKeyId = requiredEnvironment(
  "CREWON_ARTIFACT_ENCRYPTION_KEY_ID",
);
const artifactRoot = requiredEnvironment("CREWON_ARTIFACT_ROOT"),
  artifactEncryptionKeyPath = requiredEnvironment(
    "CREWON_ARTIFACT_ENCRYPTION_KEY_PATH",
  );
const projectMaterialEnvironment = Object.freeze({
  CREWON_ARTIFACT_ROOT: artifactRoot,
  CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: artifactEncryptionKeyPath,
  CREWON_ARTIFACT_ENCRYPTION_KEY_ID: artifactEncryptionKeyId,
});
const artifactRetention = configuredArtifactRetention(
  process.env.CREWON_ARTIFACT_RETENTION,
);
const artifactStore = new FilesystemArtifactStore({
  rootDirectory: artifactRoot,
  databasePath: requiredEnvironment("CREWON_ARTIFACT_DB_PATH"),
  encryptionKey: loadArtifactEncryptionKey(artifactEncryptionKeyPath),
  keyId: artifactEncryptionKeyId,
});
const sharedConfig = {
  artifactRetention,
  localStoragePaths: [
    artifactRoot,
    requiredEnvironment("CREWON_ARTIFACT_DB_PATH"),
  ],
  artifactStore,
  artifactEncryptionKeyId,
  ...(sandbox === undefined ? {} : { sandbox }),
  outboxScanIntervalMs: parsePositiveInteger(
    process.env.CREWON_OUTBOX_SCAN_INTERVAL_MS ?? "1000",
    "CREWON_OUTBOX_SCAN_INTERVAL_MS_invalid",
  ),
  outboxRetention:
    process.env.CREWON_OUTBOX_RETENTION_MS === "off"
      ? null
      : {
          ...DEFAULT_OUTBOX_RETENTION,
          retentionMs: parsePositiveInteger(
            process.env.CREWON_OUTBOX_RETENTION_MS ??
              String(DEFAULT_OUTBOX_RETENTION.retentionMs),
            "CREWON_OUTBOX_RETENTION_MS_invalid",
          ),
        },
  automationScanIntervalMs: parsePositiveInteger(
    process.env.CREWON_AUTOMATION_SCAN_INTERVAL_MS ?? "1000",
    "CREWON_AUTOMATION_SCAN_INTERVAL_MS_invalid",
  ),
};
let runtime;
let nativeProjectWorkspaces: ReturnType<
  typeof createDesktopNativeProjectWorkspaceRuntime
>;
let sqliteOutboxDatabasePath: string | null = null;
let projectSourceUploadAuthorization:
  | ProductionProjectSourceUploadAuthorization
  | undefined;
try {
  if (securityMode === "production") {
    const productionConnectionString = requiredEnvironment(
      "CREWON_CONTROL_DATABASE_URL",
    );
    const authorityTimeoutMs = parsePositiveInteger(
      process.env.CREWON_SECURITY_AUTHORITY_TIMEOUT_MS ?? "2000",
      "CREWON_SECURITY_AUTHORITY_TIMEOUT_MS_invalid",
    );
    const identity = new ProductionControlApiIdentity({
      trustedBff: new StaticTrustedBffRequestVerifier({
        serviceToken: requiredEnvironment("CREWON_CONTROL_BFF_TOKEN"),
        allowedOrigins: splitRequiredEnvironment("CREWON_BFF_ALLOWED_ORIGINS"),
        allowedRemoteAddresses: splitRequiredEnvironment(
          "CREWON_BFF_ALLOWED_REMOTE_ADDRESSES",
        ),
      }),
      tokens: new HttpControlTokenVerifier({
        url: requiredEnvironment("CREWON_IDENTITY_VERIFY_URL"),
        serviceToken: requiredEnvironment("CREWON_IDENTITY_SERVICE_TOKEN"),
      }),
      expectedIssuer: requiredEnvironment("CREWON_IDENTITY_EXPECTED_ISSUER"),
      expectedAudience: requiredEnvironment(
        "CREWON_IDENTITY_EXPECTED_AUDIENCE",
      ),
      timeoutMs: authorityTimeoutMs,
      cacheTtlMs: parseNonNegativeInteger(
        process.env.CREWON_IDENTITY_CACHE_TTL_MS ?? "0",
        "CREWON_IDENTITY_CACHE_TTL_MS_invalid",
      ),
      cacheMaxEntries: parsePositiveInteger(
        process.env.CREWON_IDENTITY_CACHE_MAX_ENTRIES ?? "1000",
        "CREWON_IDENTITY_CACHE_MAX_ENTRIES_invalid",
      ),
    });
    const authorization = new DynamicPolicyAuthorization({
      policy: new HttpPolicyDecisionPort({
        url: requiredEnvironment("CREWON_POLICY_DECISION_URL"),
        serviceToken: requiredEnvironment("CREWON_POLICY_SERVICE_TOKEN"),
      }),
      timeoutMs: authorityTimeoutMs,
    });
    if (projectStartup?.foundation !== undefined)
      projectSourceUploadAuthorization =
        new ProductionProjectSourceUploadAuthorization({
          url: requiredEnvironment("CREWON_POLICY_DECISION_URL"),
          serviceToken: requiredEnvironment("CREWON_POLICY_SERVICE_TOKEN"),
          timeoutMs: authorityTimeoutMs,
        });
    runtime = await createProductionPostgresControlApi({
      ...sharedConfig,
      connectionString: productionConnectionString,
      identity,
      authorization,
      pluginCreditAuthorization: authorization,
      ...composeProductionProjectStartup(
        projectStartup,
        authorization,
        projectSourceUploadAuthorization,
      ),
      ...(maximumDatabasePoolSize === undefined
        ? {}
        : { maxPoolSize: maximumDatabasePoolSize }),
      ...(installedPluginConfiguration === undefined
        ? {}
        : {
            pluginConfiguration: {
              configuration: installedPluginConfiguration,
            },
          }),
      ...(installedPluginTaskConfiguration === undefined
        ? {}
        : {
            pluginTasks: { configuration: installedPluginTaskConfiguration },
          }),
      ...(pluginUiConfiguration === undefined
        ? {}
        : { pluginUi: { configuration: pluginUiConfiguration } }),
      ...(pluginInstallationConfiguration === undefined
        ? {}
        : {
            pluginInstallation: {
              configuration: pluginInstallationConfiguration,
            },
          }),
      ...(process.env.CREWON_CONTROL_DATABASE_SCHEMA?.trim()
        ? { schema: process.env.CREWON_CONTROL_DATABASE_SCHEMA.trim() }
        : {}),
    });
  } else {
    const actor = desktopTaskActor ??
      extensionEnvironment?.actor ?? {
        principalId: environmentOr(
          "CREWON_PRINCIPAL_ID",
          "standalone-principal",
        ),
        actorId: environmentOr("CREWON_ACTOR_ID", "standalone-actor"),
        tenantId: standaloneTenantId,
        spaceId: environmentOr("CREWON_SPACE_ID", "standalone-space"),
      };
    const standaloneConfig = {
      ...sharedConfig,
      workflow,
      actor,
      desktopWorkspaceRegistryPath,
      defaultAgentVersionId: environmentOr(
        "CREWON_AGENT_VERSION_ID",
        "default-agent-v1",
      ),
      sessionToken: requiredEnvironment("CREWON_CONTROL_SESSION_TOKEN"),
      csrfToken: requiredEnvironment("CREWON_CONTROL_CSRF_TOKEN"),
      allowedOrigins: splitRequiredEnvironment(
        "CREWON_CONTROL_ALLOWED_ORIGINS",
      ),
      ...(providerProbeWorkers === undefined ? {} : { providerProbeWorkers }),
      ...(workspaceWorker === undefined ? {} : { workspaceWorker }),
      ...(activationGate === null ? {} : { activationGate }),
    };
    if (connectionString !== undefined && connectionString.length > 0) {
      runtime = await createPostgresControlApi({
        ...standaloneConfig,
        connectionString,
        ...(extensionEnvironment === undefined
          ? {}
          : { extensionWorker: extensionEnvironment.extensionWorker }),
        ...(process.env.CREWON_CONTROL_DATABASE_SCHEMA?.trim()
          ? { schema: process.env.CREWON_CONTROL_DATABASE_SCHEMA.trim() }
          : {}),
      });
    } else {
      const databasePath = requiredEnvironment("CREWON_CONTROL_DB_PATH");
      const desktopPlugins =
        desktopTaskBootstrap ??
        (desktopPluginBootstrapPath === undefined
          ? undefined
          : await loadDesktopPluginConfiguration(desktopPluginBootstrapPath, {
              actor,
            }));
      if (desktopPlugins !== undefined)
        nativeProjectWorkspaces = createDesktopNativeProjectWorkspaceRuntime({
          configuration: desktopPlugins,
          nativeControl: desktopNativePluginControl,
        });
      runtime =
        desktopPlugins !== undefined
          ? await createStandaloneControlApiWithPlugins({
              ...standaloneConfig,
              databasePath,
              desktopPlugins,
              ...(nativeProjectWorkspaces === undefined
                ? {}
                : {
                    desktopNativeProjectWorkspaceObserver:
                      nativeProjectWorkspaces.observe,
                  }),
              ...(desktopPlugins.schemaVersion ===
                "crewon.desktop-plugin-bootstrap.v3" &&
              (desktopPlugins.projects.mediaGenerations !== undefined ||
                desktopPlugins.projects.mediaResults !== undefined)
                ? {
                    desktopProjectMaterialStorage:
                      desktopProjectMaterialStorageFromEnvironment(
                        projectMaterialEnvironment,
                      ),
                  }
                : {}),
              ...(desktopNativePluginControl === undefined
                ? {}
                : { desktopNativePluginControl }),
              ...(desktopProjectStartup ??
                composeDesktopProjectStartup({
                  configuration: desktopPlugins,
                  actor,
                  ...(desktopNativePluginControl === undefined
                    ? {}
                    : { nativeControl: desktopNativePluginControl }),
                  ...(desktopPluginTasks === undefined
                    ? {}
                    : { tasks: desktopPluginTasks }),
                  ...(desktopPluginActivation === undefined
                    ? {}
                    : { activation: desktopPluginActivation }),
                })),
              ...(desktopPluginActivation === undefined
                ? {}
                : { desktopPluginActivation }),
              ...(desktopPluginTasks === undefined
                ? {}
                : { desktopPluginTasks }),
              ...(extensionEnvironment === undefined
                ? {}
                : { extensionWorker: extensionEnvironment.extensionWorker }),
            })
          : extensionEnvironment === undefined
            ? experimentalDurableTeamTasks
              ? await createStandaloneTeamTaskControlApi({
                  ...standaloneConfig,
                  databasePath,
                })
              : createStandaloneControlApi({
                  ...standaloneConfig,
                  databasePath,
                })
            : await createStandaloneControlApiWithExtensions({
                ...standaloneConfig,
                databasePath,
                extensionWorker: extensionEnvironment.extensionWorker,
              });
      sqliteOutboxDatabasePath = databasePath;
    }
  }
} catch (error) {
  await nativeProjectWorkspaces?.close();
  projectSourceUploadAuthorization?.close();
  await artifactStore.close();
  throw error;
}

const port = parsePort(
  process.env.CREWON_CONTROL_PORT ?? "3210",
  activationGate !== null,
);
const sqliteOutboxWakeup =
  sqliteOutboxDatabasePath === null
    ? null
    : watchSqliteOutboxAvailability({
        databasePath: sqliteOutboxDatabasePath,
        outbox: runtime.outboxDispatcher,
      });
runtime.app.addHook("preClose", async () => sqliteOutboxWakeup?.close());
runtime.app.addHook("preClose", async () => nativeProjectWorkspaces?.close());
const shutdown = installProcessShutdown({
  host: process,
  close: () => {
    sqliteOutboxWakeup?.close();
    projectSourceUploadAuthorization?.close();
    return runtime.app.close();
  },
  reportFailure: () => {
    process.stderr.write("CrewON Control API shutdown failed\n");
  },
});
if (projectSourceUploadAuthorization !== undefined)
  runtime.app.addHook("onClose", async () =>
    projectSourceUploadAuthorization?.close(),
  );
const activationInput =
  activationGate === null
    ? null
    : watchActivationInput(
        activationGate,
        process.stdin,
        process.stdout,
        () => {
          shutdown.request("failure");
        },
      );
if (activationInput !== null) {
  runtime.app.addHook("onClose", async () => activationInput.close());
}
try {
  await runtime.app.listen({ host: "127.0.0.1", port });
} catch (error) {
  sqliteOutboxWakeup?.close();
  await runtime.app.close();
  throw error;
}
const listeningPort = controlListeningPort(runtime.app.server.address());
process.stdout.write(
  `${
    activationGate === null
      ? `CrewON Control API listening on 127.0.0.1:${listeningPort}`
      : candidateReadinessLine(listeningPort)
  }\n`,
);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function environmentOr(
  name: string,
  fallback: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return environment[name]?.trim() || fallback;
}

function splitRequiredEnvironment(name: string): string[] {
  const values = requiredEnvironment(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name}_required`);
  }
  return values;
}

function parseSecurityMode(value: string): "standalone" | "production" {
  if (value === "standalone" || value === "production") {
    return value;
  }
  throw new Error("CREWON_CONTROL_SECURITY_MODE_invalid");
}

function parsePort(value: string, allowEphemeral: boolean): number {
  const port = Number(value);
  if (
    !Number.isSafeInteger(port) ||
    port < (allowEphemeral ? 0 : 1) ||
    port > 65_535
  ) {
    throw new Error("CREWON_CONTROL_PORT_invalid");
  }
  return port;
}

function controlListeningPort(address: AddressInfo | string | null): number {
  if (
    address === null ||
    typeof address === "string" ||
    !Number.isSafeInteger(address.port) ||
    address.port < 1 ||
    address.port > 65_535
  ) {
    throw new Error("CREWON_CONTROL_LISTEN_ADDRESS_invalid");
  }
  return address.port;
}

function parsePositiveInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(code);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(code);
  }
  return parsed;
}

function parseExperimentalDurableTeamTasks(value: string | undefined): boolean {
  if (value === undefined || value === "0" || value === "") return false;
  if (value === "1") return true;
  throw new Error("CREWON_EXPERIMENTAL_DURABLE_TEAM_TASKS_invalid");
}

function configuredPimSandbox(
  environment: NodeJS.ProcessEnv,
): PimThreadSandbox | undefined {
  const names = [
    "CREWON_PIM_SANDBOX_BASE_URL",
    "CREWON_PIM_SANDBOX_USERNAME",
    "CREWON_PIM_SANDBOX_PASSWORD",
    "CREWON_PIM_SANDBOX_AGENT_ID",
  ] as const;
  const configured = names.filter((name) => environment[name]?.trim());
  if (configured.length === 0) return undefined;
  if (configured.length !== names.length) {
    throw new Error("CREWON_PIM_SANDBOX_configuration_incomplete");
  }
  return new PimThreadSandbox({
    baseUrl: environment.CREWON_PIM_SANDBOX_BASE_URL!,
    username: environment.CREWON_PIM_SANDBOX_USERNAME!,
    password: environment.CREWON_PIM_SANDBOX_PASSWORD!,
    agentId: parsePositiveInteger(
      environment.CREWON_PIM_SANDBOX_AGENT_ID!,
      "CREWON_PIM_SANDBOX_AGENT_ID_invalid",
    ),
  });
}
import { configuredArtifactRetention } from "./artifact-retention-maintenance.ts";
