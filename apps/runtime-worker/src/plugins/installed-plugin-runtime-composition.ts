import { isAbsolute } from "node:path";
import type { AuthorizationPort, ExtensionStore } from "@crewon/application";
import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import {
  InstalledPluginRunContext,
  type InstalledPluginRunContextDependencies,
} from "./installed-plugin-run-context.ts";
import {
  InstalledPluginRuntimeResolver,
  type InstalledPluginRuntimeResolverDependencies,
} from "./installed-plugin-runtime-resolver.ts";

/** Host deployment authority, never supplied by a plugin or inferred from an installation receipt. */
export type InstalledPluginExecutionConfig = Readonly<{
  installRoot: string;
  authorization: AuthorizationPort;
  resolveActor: InstalledPluginRunContextDependencies["resolveActor"];
  authorizePackage: InstalledPluginRuntimeResolverDependencies["authorizePackage"];
  maximumRuntimes?: number;
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
    (config.maximumRuntimes !== undefined &&
      (!Number.isSafeInteger(config.maximumRuntimes) ||
        config.maximumRuntimes < 1 ||
        config.maximumRuntimes > 32))
  )
    throw new Error("installed_plugin_execution_configuration_invalid");
  return Object.freeze({
    installRoot: config.installRoot,
    authorization: Object.freeze({
      authorize: config.authorization.authorize.bind(config.authorization),
    }),
    resolveActor: config.resolveActor.bind(config),
    authorizePackage: config.authorizePackage.bind(config),
    ...(config.maximumRuntimes === undefined
      ? {}
      : { maximumRuntimes: config.maximumRuntimes }),
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
    resolveActor: config.resolveActor,
  });
  return new InstalledPluginRuntimeResolver({
    contexts,
    admissions: {
      pluginAdmissionVersion: extensions.pluginAdmissionVersion,
      loadPluginTaskAdmission:
        extensions.loadPluginTaskAdmission.bind(extensions),
    },
    installations,
    installRoot: config.installRoot,
    authorizePackage: config.authorizePackage,
    ...(config.maximumRuntimes === undefined
      ? {}
      : { maximumRuntimes: config.maximumRuntimes }),
  });
}
