import {
  captureInstalledPluginProjectAssetToolsConfig,
  composeInstalledPluginProjectAssetTools,
  type InstalledPluginProjectAssetToolsConfig,
} from "./installed-plugin-project-asset-tools.ts";
import { isAbsolute } from "node:path";
import type { AuthorizationPort, ExtensionStore } from "@crewon/application";
import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  InstalledPluginQueryHost,
  type InstalledPluginQueryHostDependencies,
} from "./installed-plugin-query-host.ts";
import type { StoreBackedAgentVersionRuntimeResolver } from "../store-backed-agent-version-runtime-resolver.ts";
import type { InstalledPluginExtensionHostDependencies } from "./installed-plugin-extension-host.ts";
import {
  InstalledPluginRunContext,
  type InstalledPluginRunContextDependencies,
} from "./installed-plugin-run-context.ts";
import {
  InstalledPluginRuntimeResolver,
  type InstalledPluginRuntimeResolverDependencies,
} from "./installed-plugin-runtime-resolver.ts";
import {
  captureInstalledPluginExecutionIoConfig,
  type InstalledPluginExecutionIoConfig,
} from "./installed-plugin-execution-io-config.ts";
import {
  InstalledPluginExecutionReadinessOwner,
  type InstalledPluginExecutionReadinessPort,
} from "./installed-plugin-execution-readiness.ts";
import {
  captureInstalledPluginProjectToolsConfig,
  composeInstalledPluginProjectToolsDependencies,
  type InstalledPluginProjectToolsConfig,
} from "./installed-plugin-project-tools.ts";

/** Host deployment authority, never supplied by a plugin or inferred from an installation receipt. */
export type InstalledPluginExecutionConfig = Readonly<{
  installRoot: string;
  authorization: AuthorizationPort;
  resolveActor: InstalledPluginRunContextDependencies["resolveActor"];
  authorizePackage: InstalledPluginRuntimeResolverDependencies["authorizePackage"];
  authorizeCandidatePackage?: InstalledPluginExtensionHostDependencies["authorizeCandidatePackage"];
  maximumRuntimes?: number;
  executionIo?: InstalledPluginExecutionIoConfig;
  projectTools?: InstalledPluginProjectToolsConfig;
  projectAssetTools?: InstalledPluginProjectAssetToolsConfig;
  /** Historical observation is an explicit profile-scoped deployment, never today's catalog. */
  historicalQuery?: InstalledPluginHistoricalQueryConfig;
}>;
export type InstalledPluginHistoricalQueryConfig = Readonly<{
  scope: PluginProfileScope;
  resolveProfile: InstalledPluginQueryHostDependencies["resolveProfile"];
}>;

/** Capture function identities and deployment values before opening asynchronous storage. */
export function captureInstalledPluginExecutionConfig(
  config: InstalledPluginExecutionConfig,
): InstalledPluginExecutionConfig {
  if (
    typeof config.installRoot !== "string" ||
    !isAbsolute(config.installRoot) ||
    typeof config.authorization?.authorize !== "function" ||
    typeof config.resolveActor !== "function" ||
    typeof config.authorizePackage !== "function" ||
    (config.authorizeCandidatePackage !== undefined &&
      typeof config.authorizeCandidatePackage !== "function") ||
    (config.maximumRuntimes !== undefined &&
      (!Number.isSafeInteger(config.maximumRuntimes) ||
        config.maximumRuntimes < 1 ||
        config.maximumRuntimes > 32))
  )
    throw new Error("installed_plugin_execution_configuration_invalid");
  if (
    config.projectAssetTools !== undefined &&
    config.projectTools === undefined
  )
    throw new Error("installed_plugin_asset_read_dependencies_unavailable");
  return Object.freeze({
    ...(config.projectAssetTools === undefined
      ? {}
      : {
          projectAssetTools: captureInstalledPluginProjectAssetToolsConfig(
            config.projectAssetTools,
          ),
        }),
    installRoot: config.installRoot,
    authorization: Object.freeze({
      authorize: config.authorization.authorize.bind(config.authorization),
    }),
    resolveActor: config.resolveActor.bind(config),
    authorizePackage: config.authorizePackage.bind(config),
    ...(config.authorizeCandidatePackage === undefined
      ? {}
      : {
          authorizeCandidatePackage:
            config.authorizeCandidatePackage.bind(config),
        }),
    ...(config.executionIo === undefined
      ? {}
      : {
          executionIo: captureInstalledPluginExecutionIoConfig(
            config.executionIo,
          ),
        }),
    ...(config.projectTools === undefined
      ? {}
      : {
          projectTools: captureInstalledPluginProjectToolsConfig(
            config.projectTools,
          ),
        }),
    ...(config.historicalQuery === undefined
      ? {}
      : {
          historicalQuery: captureInstalledPluginHistoricalQueryConfig(
            config.historicalQuery,
          ),
        }),
    ...(config.maximumRuntimes === undefined
      ? {}
      : { maximumRuntimes: config.maximumRuntimes }),
  });
}

export function captureInstalledPluginHistoricalQueryConfig(
  config: InstalledPluginHistoricalQueryConfig,
): InstalledPluginHistoricalQueryConfig {
  if (
    config === null ||
    typeof config !== "object" ||
    typeof config.resolveProfile !== "function"
  )
    throw new Error("installed_plugin_query_configuration_invalid");
  return Object.freeze({
    scope: parsePluginProfileScope(config.scope),
    resolveProfile: config.resolveProfile.bind(config),
  });
}

/** Uses the actual parent Store and prepared Agent runtime owner; no standalone DB or catalog substitute. */
export function composeInstalledPluginQueryHost(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    extensions: ExtensionStore;
    config: InstalledPluginExecutionConfig;
    runtimeResolver: StoreBackedAgentVersionRuntimeResolver;
    tenantId: string;
    executionReadiness?: InstalledPluginExecutionReadinessPort;
  }>,
): InstalledPluginQueryHost | null {
  const config = captureInstalledPluginExecutionConfig(input.config),
    query = config.historicalQuery;
  if (query === undefined) return null;
  if (query.scope.tenantId !== input.tenantId)
    throw new Error("installed_plugin_query_tenant_mismatch");
  return new InstalledPluginQueryHost({
    scope: query.scope,
    installRoot: config.installRoot,
    extensions: input.extensions,
    runs: input.store,
    operations: input.store.externalOperationStore(),
    installations: input.store.pluginInstallationStore(),
    authorization: config.authorization,
    runtimeResolver: input.runtimeResolver,
    deployments: input.store,
    resolveActor: config.resolveActor,
    resolveProfile: query.resolveProfile,
    authorizePackage: config.authorizePackage,
    ...(input.executionReadiness === undefined
      ? {}
      : { executionReadiness: input.executionReadiness }),
  });
}

/** Own this preflight with the parent Store; callers receive no synthetic Run or dispatch grant. */
export function composeInstalledPluginExecutionReadiness(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    config: InstalledPluginExecutionConfig;
  }>,
): InstalledPluginExecutionReadinessOwner | null {
  const config = captureInstalledPluginExecutionConfig(input.config);
  if (config.executionIo === undefined) return null;
  return new InstalledPluginExecutionReadinessOwner({
    configuration: config.executionIo,
    operations: input.store.externalOperationStore(),
  });
}

/** Uses the composition's actual Run, extension and installation stores after explicit migration. */
export function composeInstalledPluginRuntimeResolver(input: {
  store: SqliteRunStore | PostgresDomainStore;
  extensions: ExtensionStore;
  config: InstalledPluginExecutionConfig;
}): InstalledPluginRuntimeResolver {
  const { extensions, store, config } = input;
  if (
    extensions.pluginAdmissionVersion !== "crewon.plugin-task-admission.v1" ||
    typeof extensions.loadPluginTaskAdmission !== "function"
  )
    throw new Error("installed_plugin_execution_admission_unavailable");
  const installations = store.pluginInstallationStore();
  const contexts = new InstalledPluginRunContext({
    extensions,
    runs: store,
    installations,
    authorization: config.authorization,
    operations: store.externalOperationStore(),
    conversations: store.projectConversationStore(),
    plans: store.projectTextPlanStore(),
    assetStages: store.projectAssetStageStore(),
    resolveActor: config.resolveActor,
  });
  return new InstalledPluginRuntimeResolver({
    contexts,
    admissions: {
      pluginAdmissionVersion: extensions.pluginAdmissionVersion,
      loadPluginTaskAdmission:
        extensions.loadPluginTaskAdmission.bind(extensions),
      ...(extensions.loadPluginQueryTaskAdmission === undefined
        ? {}
        : {
            pluginQueryAdmissionVersion: extensions.pluginQueryAdmissionVersion,
            loadPluginQueryTaskAdmission:
              extensions.loadPluginQueryTaskAdmission.bind(extensions),
          }),
    },
    installations,
    installRoot: config.installRoot,
    authorizePackage: config.authorizePackage,
    ...(config.projectTools === undefined
      ? {}
      : {
          projectTools: Object.freeze({
            ...composeInstalledPluginProjectToolsDependencies({
              store,
              config: config.projectTools,
              resolveActor: config.resolveActor,
            }),
            ...(config.projectAssetTools === undefined
              ? {}
              : {
                  assetTools: (
                    admission: import("@crewon/domain").PluginTaskAdmission,
                  ) =>
                    composeInstalledPluginProjectAssetTools({
                      store,
                      config: config.projectAssetTools!,
                      admission,
                    }),
                }),
          }),
        }),
    ...(config.executionIo === undefined
      ? {}
      : {
          executionIo: {
            ...captureInstalledPluginExecutionIoConfig(config.executionIo),
            operations: store.externalOperationStore(),
          },
        }),
    ...(config.maximumRuntimes === undefined
      ? {}
      : { maximumRuntimes: config.maximumRuntimes }),
  });
}
