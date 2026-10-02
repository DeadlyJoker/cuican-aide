import { isAbsolute, resolve } from "node:path";
import { inspect } from "node:util";
import { parsePluginControlAssetPath } from "@crewon/contracts";
import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
} from "@crewon/domain";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export type ProductionPluginUiPublication = Readonly<{
  packageDigest: string;
  pluginId: string;
  publisherId: string;
  publicAssets: readonly string[];
}>;
export type ProductionPluginUiConfiguration = Readonly<{
  installRoot: string;
  profileAuthority: Readonly<{ url: string; serviceToken: string }>;
  policyAuthority: Readonly<{ url: string; serviceToken: string }>;
  publications: readonly ProductionPluginUiPublication[];
  timeoutMs: number;
}>;
const MAX_PUBLICATIONS_BYTES = 128 * 1024;
const parsed = new WeakSet<object>();
const names = [
  "CREWON_PLUGIN_UI_ENABLED",
  "CREWON_PLUGIN_UI_INSTALL_ROOT",
  "CREWON_PLUGIN_UI_PROFILE_AUTHORITY_URL",
  "CREWON_PLUGIN_UI_PROFILE_AUTHORITY_TOKEN",
  "CREWON_PLUGIN_UI_POLICY_AUTHORITY_URL",
  "CREWON_PLUGIN_UI_POLICY_AUTHORITY_TOKEN",
  "CREWON_PLUGIN_UI_PUBLICATIONS_JSON",
  "CREWON_PLUGIN_UI_AUTHORITY_TIMEOUT_MS",
] as const;

/** Startup snapshot only. Profile, actor and revocation epoch are never environment settings. */
export function resolveProductionPluginUiEnvironment(
  environment: NodeJS.ProcessEnv,
  securityMode: "production" | "standalone",
): ProductionPluginUiConfiguration | undefined {
  const settings = Object.keys(environment).filter(
    (name) =>
      name.startsWith("CREWON_PLUGIN_UI_") && environment[name] !== undefined,
  );
  if (settings.some((name) => !(names as readonly string[]).includes(name)))
    invalid();
  const enabled = environment.CREWON_PLUGIN_UI_ENABLED;
  if (enabled !== undefined && enabled !== "0" && enabled !== "1") invalid();
  if (enabled !== "1") {
    if (settings.some((name) => name !== "CREWON_PLUGIN_UI_ENABLED")) invalid();
    return undefined;
  }
  if (securityMode !== "production") invalid();
  const json = environment.CREWON_PLUGIN_UI_PUBLICATIONS_JSON;
  if (
    typeof json !== "string" ||
    Buffer.byteLength(json) > MAX_PUBLICATIONS_BYTES
  )
    invalid();
  let publications: unknown;
  try {
    publications = JSON.parse(json);
  } catch {
    invalid();
  }
  const timeout = environment.CREWON_PLUGIN_UI_AUTHORITY_TIMEOUT_MS ?? "2000";
  if (!/^[1-9][0-9]{0,4}$/u.test(timeout)) invalid();
  return parseProductionPluginUiConfiguration({
    installRoot: environment.CREWON_PLUGIN_UI_INSTALL_ROOT,
    profileAuthority: {
      url: environment.CREWON_PLUGIN_UI_PROFILE_AUTHORITY_URL,
      serviceToken: environment.CREWON_PLUGIN_UI_PROFILE_AUTHORITY_TOKEN,
    },
    policyAuthority: {
      url: environment.CREWON_PLUGIN_UI_POLICY_AUTHORITY_URL,
      serviceToken: environment.CREWON_PLUGIN_UI_POLICY_AUTHORITY_TOKEN,
    },
    publications,
    timeoutMs: Number(timeout),
  });
}

export function parseProductionPluginUiConfiguration(
  input: unknown,
): ProductionPluginUiConfiguration {
  if (input !== null && typeof input === "object" && parsed.has(input))
    return input as ProductionPluginUiConfiguration;
  try {
    const value = pluginSecurityRecord(input, [
      "installRoot",
      "profileAuthority",
      "policyAuthority",
      "publications",
      "timeoutMs",
    ]);
    if (
      typeof value.installRoot !== "string" ||
      !isAbsolute(value.installRoot) ||
      resolve(value.installRoot) !== value.installRoot ||
      value.installRoot.trim() !== value.installRoot ||
      Buffer.byteLength(value.installRoot) > 4096 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.installRoot) ||
      !Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 1 ||
      (value.timeoutMs as number) > 30_000
    )
      invalid();
    const publications = dense(value.publications, 32).map((item) => {
      const publication = pluginSecurityRecord(item, [
        "packageDigest",
        "pluginId",
        "publisherId",
        "publicAssets",
      ]);
      const publicAssets = dense(publication.publicAssets, 256).map(
        parsePluginControlAssetPath,
      );
      if (
        publicAssets.length === 0 ||
        new Set(publicAssets).size !== publicAssets.length
      )
        invalid();
      return Object.freeze({
        packageDigest: pluginInstallationDigest(publication.packageDigest),
        pluginId: pluginInstallationNamespaceId(publication.pluginId),
        publisherId: pluginInstallationNamespaceId(publication.publisherId),
        publicAssets: Object.freeze(publicAssets),
      });
    });
    if (
      new Set(publications.map((item) => item.packageDigest)).size !==
      publications.length
    )
      invalid();
    if (
      Buffer.byteLength(JSON.stringify(publications)) > MAX_PUBLICATIONS_BYTES
    )
      invalid();
    const configuration = {
      installRoot: value.installRoot as string,
      profileAuthority: authority(value.profileAuthority),
      policyAuthority: authority(value.policyAuthority),
      publications: Object.freeze(publications),
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
    url.hash
  )
    invalid();
  if (Buffer.byteLength(url.href) > 2048) invalid();
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
  return Object.freeze(
    Array.from({ length: input.length }, (_, index) => {
      const item = Object.getOwnPropertyDescriptor(input, String(index));
      if (!item?.enumerable || !("value" in item)) invalid();
      return item.value;
    }),
  );
}
function invalid(): never {
  throw new Error("production_plugin_ui_configuration_invalid");
}
