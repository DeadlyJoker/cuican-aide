import { isAbsolute, resolve } from "node:path";
import { inspect } from "node:util";
import { parsePluginSourceView } from "@crewon/contracts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export type ProductionPluginInstallationSource = Readonly<{
  sourceId: string;
  directory: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
}>;
export type ProductionPluginInstallationConfiguration = Readonly<{
  installRoot: string;
  sources: readonly ProductionPluginInstallationSource[];
  profileAuthority: Readonly<{ url: string; serviceToken: string }>;
  policyAuthority: Readonly<{ url: string; serviceToken: string }>;
  timeoutMs: number;
}>;
const MAX_CONFIGURATION_BYTES = 128 * 1024;
const parsed = new WeakSet<object>();
const names = [
  "CREWON_PLUGIN_INSTALLATION_ENABLED",
  "CREWON_PLUGIN_INSTALLATION_INSTALL_ROOT",
  "CREWON_PLUGIN_INSTALLATION_SOURCES_JSON",
  "CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_URL",
  "CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_TOKEN",
  "CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_URL",
  "CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_TOKEN",
  "CREWON_PLUGIN_INSTALLATION_AUTHORITY_TIMEOUT_MS",
] as const;

/** Deployment opt-in only; current actors, profiles and permissions are authority responses. */
export function resolveProductionPluginInstallationEnvironment(
  environment: NodeJS.ProcessEnv,
  securityMode: "production" | "standalone",
): ProductionPluginInstallationConfiguration | undefined {
  const settings = Object.keys(environment).filter(
    (name) =>
      name.startsWith("CREWON_PLUGIN_INSTALLATION_") &&
      environment[name] !== undefined,
  );
  if (settings.some((name) => !(names as readonly string[]).includes(name)))
    invalid();
  const enabled = environment.CREWON_PLUGIN_INSTALLATION_ENABLED;
  if (enabled !== undefined && enabled !== "0" && enabled !== "1") invalid();
  if (enabled !== "1") {
    if (settings.some((name) => name !== "CREWON_PLUGIN_INSTALLATION_ENABLED"))
      invalid();
    return undefined;
  }
  if (securityMode !== "production") invalid();
  const json = environment.CREWON_PLUGIN_INSTALLATION_SOURCES_JSON;
  if (
    typeof json !== "string" ||
    Buffer.byteLength(json) > MAX_CONFIGURATION_BYTES
  )
    invalid();
  let sources: unknown;
  try {
    sources = JSON.parse(json);
  } catch {
    invalid();
  }
  const timeout =
    environment.CREWON_PLUGIN_INSTALLATION_AUTHORITY_TIMEOUT_MS ?? "2000";
  if (!/^[1-9][0-9]{0,4}$/u.test(timeout)) invalid();
  return parseProductionPluginInstallationConfiguration({
    installRoot: environment.CREWON_PLUGIN_INSTALLATION_INSTALL_ROOT,
    sources,
    profileAuthority: {
      url: environment.CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_URL,
      serviceToken:
        environment.CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_TOKEN,
    },
    policyAuthority: {
      url: environment.CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_URL,
      serviceToken:
        environment.CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_TOKEN,
    },
    timeoutMs: Number(timeout),
  });
}

export function parseProductionPluginInstallationConfiguration(
  input: unknown,
): ProductionPluginInstallationConfiguration {
  if (input !== null && typeof input === "object" && parsed.has(input))
    return input as ProductionPluginInstallationConfiguration;
  try {
    const value = pluginSecurityRecord(input, [
      "installRoot",
      "sources",
      "profileAuthority",
      "policyAuthority",
      "timeoutMs",
    ]);
    const installRoot = privatePath(value.installRoot);
    if (
      !Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 1 ||
      (value.timeoutMs as number) > 30_000
    )
      invalid();
    const sources = dense(value.sources, 32).map((input) => {
      const source = pluginSecurityRecord(input, [
        "sourceId",
        "directory",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
      ]);
      const identity = parsePluginSourceView({
        sourceId: source.sourceId,
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        version: source.version,
        packageDigest: source.packageDigest,
        title: "Approved source",
        description: "Host deployment metadata",
      });
      return Object.freeze({
        sourceId: identity.sourceId,
        directory: privatePath(source.directory),
        pluginId: identity.pluginId,
        publisherId: identity.publisherId,
        version: identity.version,
        packageDigest: identity.packageDigest,
      });
    });
    const ids = new Set<string>();
    const directories = new Set<string>();
    const digests = new Set<string>();
    const versions = new Set<string>();
    const publishers = new Map<string, string>();
    for (const source of sources) {
      const version = `${source.pluginId}@${source.version}`;
      if (
        ids.has(source.sourceId) ||
        directories.has(source.directory) ||
        digests.has(source.packageDigest) ||
        versions.has(version) ||
        (publishers.has(source.pluginId) &&
          publishers.get(source.pluginId) !== source.publisherId)
      )
        invalid();
      ids.add(source.sourceId);
      directories.add(source.directory);
      digests.add(source.packageDigest);
      versions.add(version);
      publishers.set(source.pluginId, source.publisherId);
    }
    if (Buffer.byteLength(JSON.stringify(sources)) > MAX_CONFIGURATION_BYTES)
      invalid();
    const configuration = {
      installRoot,
      sources: Object.freeze(sources),
      profileAuthority: authority(value.profileAuthority),
      policyAuthority: authority(value.policyAuthority),
      timeoutMs: value.timeoutMs as number,
    };
    const redacted = () => ({
      ...configuration,
      profileAuthority: {
        ...configuration.profileAuthority,
        serviceToken: "[REDACTED]",
      },
      policyAuthority: {
        ...configuration.policyAuthority,
        serviceToken: "[REDACTED]",
      },
    });
    Object.defineProperties(configuration, {
      toJSON: { value: redacted },
      [inspect.custom]: { value: redacted },
    });
    Object.freeze(configuration);
    parsed.add(configuration);
    return configuration;
  } catch {
    invalid();
  }
}

function privatePath(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input.trim() !== input ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    invalid();
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) invalid();
  }
  return input;
}
function authority(input: unknown) {
  const value = pluginSecurityRecord(input, ["url", "serviceToken"]);
  if (
    typeof value.url !== "string" ||
    Buffer.byteLength(value.url) > 2048 ||
    /[\s?#\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.url) ||
    typeof value.serviceToken !== "string" ||
    Buffer.byteLength(value.serviceToken) < 32 ||
    Buffer.byteLength(value.serviceToken) > 8192 ||
    !/^[\x21-\x7e]+$/u.test(value.serviceToken)
  )
    invalid();
  const url = new URL(value.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    Buffer.byteLength(url.href) > 2048
  )
    invalid();
  return Object.freeze({ url: url.href, serviceToken: value.serviceToken });
}
function dense(input: unknown, limit: number): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > limit ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid();
  return Array.from({ length: input.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(input, String(index));
    if (!item?.enumerable || !("value" in item)) invalid();
    return item.value;
  });
}
function invalid(): never {
  throw new Error("production_plugin_installation_configuration_invalid");
}
