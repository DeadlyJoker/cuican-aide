import { basename, dirname, join } from "node:path";
import type { ActorContext } from "@crewon/application";
import {
  extensionCanonicalJson,
  extensionDigest,
  extensionOpaqueId,
  pluginInstallationNamespaceId,
  pluginInstallationVersion,
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import { ioJson, ioRecord } from "./plugin-execution-io-network.ts";
import {
  parseInstalledPluginAuthorityConfig,
  type InstalledPluginAuthorityConfig,
} from "./installed-plugin-authority-config.ts";
import type { InstalledPluginReleaseIdentity } from "./installed-plugin-release-document.ts";
import {
  NativePreparationFiles,
  nativePreparationFailure as fail,
  nativePreparationPath,
} from "./installed-plugin-native-preparation-files.ts";

export const INSTALLED_PLUGIN_NATIVE_PREPARATION_ENV =
  "CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH";
export const INSTALLED_PLUGIN_NATIVE_PREPARATION_SCHEMA =
  "crewon.installed-plugin-native-preparation.v1";
export const INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA =
  "crewon.installed-plugin-native-preparation.v2";
export type NativeInstalledPluginPreparationConfiguration = Readonly<{
  schemaVersion:
    | typeof INSTALLED_PLUGIN_NATIVE_PREPARATION_SCHEMA
    | typeof INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA;
  actor: ActorContext;
  scope: PluginProfileScope;
  approvedPackages: readonly InstalledPluginReleaseIdentity[];
  plugins: readonly Readonly<{
    pluginId: string;
    approvalRequirement: "none" | "perAction";
  }>[];
  workerConfigurationPath: string;
}>;
export type LoadedNativeInstalledPluginPreparation = Readonly<{
  configuration: NativeInstalledPluginPreparationConfiguration;
  worker: InstalledPluginAuthorityConfig;
  databasePath: string;
  documentPath: string;
  resultPath: string;
  environment: Readonly<Record<string, string | undefined>>;
  files: NativePreparationFiles;
}>;
const issued = new WeakSet<object>();
const legacyFields = [
  "CREWON_EXTENSION_RUNTIME_BINDINGS_PATH",
  "CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH",
  "CREWON_EXTENSION_HOST_PORT",
  "CREWON_EXTENSION_HOST_TOKEN",
  "CREWON_EXTENSION_HOST_DEADLINE_MS",
  "CREWON_EXTENSION_EXECUTION_MODE",
  "CREWON_EXTENSION_RECOVERY_ATTEMPT_ID",
  "CREWON_EXTENSION_RECOVERY_PROVIDER_JSON",
  "CREWON_INSTALLED_PLUGIN_TASK_CONFIG_PATH",
  "CREWON_INSTALLED_PLUGIN_CONFIGURATION_CONFIG_PATH",
  "CREWON_INSTALLED_PLUGIN_PEER_ORIGIN",
  "CREWON_INSTALLED_PLUGIN_PEER_PORT",
  "CREWON_INSTALLED_PLUGIN_PEER_TOKEN",
  "CREWON_INSTALLED_PLUGIN_PEER_DEADLINE_MS",
] as const;
const actorEnvironment = {
  CREWON_RELEASE_PRINCIPAL_ID: "principalId",
  CREWON_RELEASE_ACTOR_ID: "actorId",
  CREWON_TENANT_ID: "tenantId",
  CREWON_SPACE_ID: "spaceId",
} as const;

export function parseNativePreparationActor(input: unknown): ActorContext {
  const value = ioRecord(input, [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ]);
  return Object.freeze({
    principalId: extensionOpaqueId(value.principalId),
    actorId: extensionOpaqueId(value.actorId),
    tenantId: extensionOpaqueId(value.tenantId),
    spaceId: extensionOpaqueId(value.spaceId),
  });
}

export function parseNativeInstalledPluginPreparationConfiguration(
  input: unknown,
): NativeInstalledPluginPreparationConfiguration {
  const value = ioRecord(ioJson(input, 128 * 1024), [
    "schemaVersion",
    "actor",
    "scope",
    "approvedPackages",
    "plugins",
    "workerConfigurationPath",
  ]);
  if (
    value.schemaVersion !== INSTALLED_PLUGIN_NATIVE_PREPARATION_SCHEMA &&
    value.schemaVersion !== INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA
  )
    fail("configuration_invalid");
  const candidates =
    value.schemaVersion === INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA;
  const actor = parseNativePreparationActor(value.actor),
    scope = parsePluginProfileScope(value.scope);
  if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
    fail("scope_mismatch");
  if (
    !Array.isArray(value.approvedPackages) ||
    value.approvedPackages.length < (candidates ? 0 : 1) ||
    value.approvedPackages.length > 32 ||
    !Array.isArray(value.plugins) ||
    value.plugins.length < 1 ||
    value.plugins.length > 32
  )
    fail("configuration_invalid");
  const identities = new Set<string>(),
    publishers = new Map<string, string>(),
    versions = new Map<string, string>();
  const approvedPackages = value.approvedPackages.map((input) => {
    const tuple = ioRecord(input, [
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
    ]);
    const identity = Object.freeze({
      pluginId: pluginInstallationNamespaceId(tuple.pluginId),
      publisherId: pluginInstallationNamespaceId(tuple.publisherId),
      version: pluginInstallationVersion(tuple.version),
      packageDigest: extensionDigest(tuple.packageDigest),
    });
    const key = extensionCanonicalJson(identity),
      publisher = publishers.get(identity.pluginId);
    const versionKey = `${identity.pluginId}:${identity.version}`,
      priorDigest = versions.get(versionKey);
    if (
      identities.has(key) ||
      (publisher !== undefined && publisher !== identity.publisherId) ||
      (priorDigest !== undefined && priorDigest !== identity.packageDigest)
    )
      fail("approval_conflict");
    identities.add(key);
    publishers.set(identity.pluginId, identity.publisherId);
    versions.set(versionKey, identity.packageDigest);
    return identity;
  });
  const pluginIds = new Set<string>();
  const plugins = value.plugins.map((input) => {
    const entry = ioRecord(input, ["pluginId", "approvalRequirement"]);
    const pluginId = pluginInstallationNamespaceId(entry.pluginId);
    if (
      pluginIds.has(pluginId) ||
      (!candidates && !publishers.has(pluginId)) ||
      (entry.approvalRequirement !== "none" &&
        entry.approvalRequirement !== "perAction")
    )
      fail("plugin_invalid");
    pluginIds.add(pluginId);
    return Object.freeze({
      pluginId,
      approvalRequirement: entry.approvalRequirement,
    });
  });
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    actor,
    scope,
    approvedPackages: Object.freeze(approvedPackages),
    plugins: Object.freeze(plugins),
    workerConfigurationPath: nativePreparationPath(
      value.workerConfigurationPath,
    ),
  });
}

/** Pure file/environment preflight before default transport or tools are constructed. No Store is opened. */
export function loadNativeInstalledPluginPreparation(
  input: Readonly<{
    inputPath: string;
    environment: Readonly<Record<string, string | undefined>>;
    actor: ActorContext;
  }>,
): LoadedNativeInstalledPluginPreparation {
  const request = ioRecord(input, ["inputPath", "environment", "actor"]);
  const inputPath = nativePreparationPath(request.inputPath);
  const actualActor = parseNativePreparationActor(request.actor);
  const environmentInput = request.environment;
  if (
    !environmentInput ||
    typeof environmentInput !== "object" ||
    Array.isArray(environmentInput)
  )
    fail("environment_invalid");
  const environment: Record<string, string | undefined> = {};
  for (const name of Reflect.ownKeys(environmentInput)) {
    if (typeof name !== "string") fail("environment_invalid");
    const field = Object.getOwnPropertyDescriptor(environmentInput, name);
    if (
      !field ||
      !("value" in field) ||
      !field.enumerable ||
      (field.value !== undefined && typeof field.value !== "string")
    )
      fail("environment_invalid");
    environment[name] = field.value;
  }
  if (
    environment.CREWON_CONTROL_DATABASE_URL !== undefined ||
    environment.CREWON_CONTROL_DATABASE_SCHEMA !== undefined ||
    (environment.CREWON_EXTENSIONS_ENABLED !== undefined &&
      environment.CREWON_EXTENSIONS_ENABLED !== "0") ||
    legacyFields.some((name) => environment[name] !== undefined)
  )
    fail("legacy_runtime_conflict");
  if (environment[INSTALLED_PLUGIN_NATIVE_PREPARATION_ENV] !== inputPath)
    fail("environment_invalid");
  for (const [name, field] of Object.entries(actorEnvironment))
    if (environment[name] !== actualActor[field as keyof ActorContext])
      fail("actor_mismatch");
  const databasePath = nativePreparationPath(
    environment.CREWON_CONTROL_DB_PATH,
  );
  const dataDirectory = dirname(databasePath),
    directory = dirname(inputPath);
  if (
    basename(databasePath) !== "control.sqlite" ||
    basename(inputPath) !== "preparation.json" ||
    dirname(directory) !== dataDirectory
  )
    fail("path_invalid");
  const files = new NativePreparationFiles();
  files.privateDirectory(dataDirectory);
  files.privateDirectory(directory);
  files.database(databasePath);
  const configuration = parseNativeInstalledPluginPreparationConfiguration(
    files.readJson(inputPath),
  );
  if (
    extensionCanonicalJson(actualActor) !==
    extensionCanonicalJson(configuration.actor)
  )
    fail("actor_mismatch");
  const workerPath = join(directory, "worker.json"),
    documentPath = join(directory, "release.json"),
    resultPath = join(directory, "preparation-result.json");
  if (
    configuration.workerConfigurationPath !== workerPath ||
    (environment.CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH !== undefined &&
      environment.CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH !== workerPath)
  )
    fail("path_invalid");
  const worker = parseInstalledPluginAuthorityConfig(
    files.readJson(workerPath),
    environment,
  );
  if (
    worker.installRoot !== join(dataDirectory, "plugins") ||
    worker.releaseDocumentPath !== documentPath ||
    (worker.historicalScope !== null &&
      extensionCanonicalJson(worker.historicalScope) !==
        extensionCanonicalJson(configuration.scope))
  )
    fail("scope_mismatch");
  files.assertAbsent(documentPath);
  if (
    configuration.schemaVersion === INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA
  ) {
    files.privateDirectory(worker.installRoot);
    files.assertAbsent(resultPath);
  }
  const result = Object.freeze({
    configuration,
    worker,
    databasePath,
    documentPath,
    resultPath,
    environment: Object.freeze(environment),
    files,
  });
  issued.add(result);
  return result;
}

export function assertNativeInstalledPluginPreparation(
  input: LoadedNativeInstalledPluginPreparation,
): void {
  if (!issued.has(input)) fail("input_unverified");
  input.files.assertCurrent();
}
