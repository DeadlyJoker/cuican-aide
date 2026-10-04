import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
} from "./plugin-control-contract.ts";
import {
  copyPluginControlJson,
  pluginControlRecord,
} from "./plugin-control-contract-support.ts";
import { peerActor, peerScope } from "./installed-plugin-peer-values.ts";
import type {
  InstalledPluginPeerActor,
  InstalledPluginPeerScope,
} from "./installed-plugin-peer-types.ts";

/** Independent private Native execution publication; no activation, wallet or supplier grant is inferred. */
export const DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_SCHEMA =
  "crewon.desktop-installed-plugin-tasks.v1";
export const DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES = 64 * 1024;

export type DesktopInstalledPluginTaskAuthorityReference = Readonly<{
  url: string;
  serviceTokenEnvironmentVariable: string;
}>;
export type DesktopInstalledPluginTaskUiPublication = Readonly<{
  pluginId: string;
  packageDigest: string;
  contributionId: string;
}>;
/** Explicit execution role settings only; these data do not issue a Native publication. */
export type DesktopInstalledPluginTaskExecutionSettings = Readonly<{
  uiPublications: readonly DesktopInstalledPluginTaskUiPublication[];
  taskPolicyAuthority: DesktopInstalledPluginTaskAuthorityReference;
  uiPolicyAuthority: DesktopInstalledPluginTaskAuthorityReference;
  packageAuthority: DesktopInstalledPluginTaskAuthorityReference;
  quoteAuthority: DesktopInstalledPluginTaskAuthorityReference;
  timeoutMs: number;
  maximumPackages: number;
}>;
export type DesktopInstalledPluginTaskConfiguration = Readonly<{
  schemaVersion: typeof DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_SCHEMA;
  actor: InstalledPluginPeerActor;
  scope: InstalledPluginPeerScope;
  authorityEpoch: string;
  installRoot: string;
  /** SHA-256 of the parsed activation publication's canonical JSON, excluding runtime secrets; file provenance is separate. */
  activationDigest: string;
}> &
  DesktopInstalledPluginTaskExecutionSettings;

const SETTINGS_FIELDS = [
  "uiPublications",
  "taskPolicyAuthority",
  "uiPolicyAuthority",
  "packageAuthority",
  "quoteAuthority",
  "timeoutMs",
  "maximumPackages",
] as const;

export class DesktopInstalledPluginTaskConfigurationError extends ContractValidationError {
  constructor() {
    super("desktop_installed_plugin_task_configuration_invalid");
    this.name = "DesktopInstalledPluginTaskConfigurationError";
  }
}

function invalid(): never {
  throw new DesktopInstalledPluginTaskConfigurationError();
}

function tokenReference(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(input) ||
    (input.startsWith("CREWON_") &&
      !input.startsWith("CREWON_INSTALLED_PLUGIN_AUTHORITY_")) ||
    /^(?:NODE_|ELECTRON_|DYLD_|LD_|XDG_|LC_|PNPM_|NPM_|VITE_)/u.test(input) ||
    [
      "PATH",
      "HOME",
      "SHELL",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "TZ",
      "PWD",
      "OLDPWD",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "CODEX_HOME",
    ].includes(input)
  )
    invalid();
  return input;
}

function authority(
  input: unknown,
): DesktopInstalledPluginTaskAuthorityReference {
  const value = pluginControlRecord(input, [
    "url",
    "serviceTokenEnvironmentVariable",
  ]);
  if (
    typeof value.url !== "string" ||
    value.url.length > 2048 ||
    value.url !== value.url.trim() ||
    /[\\\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.url)
  )
    invalid();
  const url = new URL(value.url);
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.url.includes("?") ||
    value.url.includes("#")
  )
    invalid();
  return Object.freeze({
    url: value.url,
    serviceTokenEnvironmentVariable: tokenReference(
      value.serviceTokenEnvironmentVariable,
    ),
  });
}

function installRoot(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 4096 ||
    input !== input.trim() ||
    new TextEncoder().encode(input).byteLength > 4096 ||
    !input.startsWith("/") ||
    input === "/" ||
    input.endsWith("/") ||
    /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input) ||
    input
      .split("/")
      .slice(1)
      .some((part) => part === "" || part === "." || part === "..")
  )
    invalid();
  return input;
}

function taskExecutionSettings(
  value: Record<string, unknown>,
): DesktopInstalledPluginTaskExecutionSettings {
  if (
    typeof value.timeoutMs !== "number" ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1000 ||
    value.timeoutMs > 30000 ||
    typeof value.maximumPackages !== "number" ||
    !Number.isSafeInteger(value.maximumPackages) ||
    value.maximumPackages < 1 ||
    value.maximumPackages > 32 ||
    !Array.isArray(value.uiPublications) ||
    value.uiPublications.length < 1 ||
    value.uiPublications.length > 32
  )
    invalid();
  const seen = new Set<string>();
  const uiPublications = value.uiPublications.map((inputPublication) => {
    const publication = pluginControlRecord(inputPublication, [
      "pluginId",
      "packageDigest",
      "contributionId",
    ]);
    const parsed = Object.freeze({
      pluginId: parsePluginControlPluginId(publication.pluginId),
      packageDigest: parsePluginControlPackageDigest(publication.packageDigest),
      contributionId: parsePluginControlPluginId(publication.contributionId),
    });
    const tuple = JSON.stringify([
      parsed.pluginId,
      parsed.packageDigest,
      parsed.contributionId,
    ]);
    if (seen.has(tuple)) invalid();
    seen.add(tuple);
    return parsed;
  });
  return Object.freeze({
    uiPublications: Object.freeze(uiPublications),
    taskPolicyAuthority: authority(value.taskPolicyAuthority),
    uiPolicyAuthority: authority(value.uiPolicyAuthority),
    packageAuthority: authority(value.packageAuthority),
    quoteAuthority: authority(value.quoteAuthority),
    timeoutMs: value.timeoutMs,
    maximumPackages: value.maximumPackages,
  });
}

/** Pure bounded settings; only the actual Native file owner can later bind actor, profile and publication facts. */
export function parseDesktopInstalledPluginTaskExecutionSettings(
  input: unknown,
): DesktopInstalledPluginTaskExecutionSettings {
  try {
    return taskExecutionSettings(
      pluginControlRecord(
        copyPluginControlJson(input, {
          maxBytes: DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES,
        }),
        SETTINGS_FIELDS,
      ),
    );
  } catch {
    invalid();
  }
}

/** Detached bounded data only. Receiving owners must bind the digest, scope and UI grants to current Native facts. */
export function parseDesktopInstalledPluginTaskConfiguration(
  input: unknown,
): DesktopInstalledPluginTaskConfiguration {
  try {
    const value = pluginControlRecord(
      copyPluginControlJson(input, {
        maxBytes: DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES,
      }),
      [
        "schemaVersion",
        "actor",
        "scope",
        "authorityEpoch",
        "installRoot",
        "activationDigest",
        ...SETTINGS_FIELDS,
      ],
    );
    if (
      value.schemaVersion !==
        DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_SCHEMA ||
      typeof value.authorityEpoch !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(value.authorityEpoch)
    )
      invalid();
    const actor = peerActor(value.actor);
    const scope = peerScope(value.scope);
    if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
      invalid();
    const settings = taskExecutionSettings(value);
    return Object.freeze({
      schemaVersion: DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_SCHEMA,
      actor,
      scope,
      authorityEpoch: value.authorityEpoch,
      installRoot: installRoot(value.installRoot),
      activationDigest: parsePluginControlPackageDigest(value.activationDigest),
      ...settings,
    });
  } catch {
    invalid();
  }
}
