import {
  parseInstalledPluginModelBindings,
  type InstalledPluginModelBinding,
} from "./installed-plugin-model-selection.ts";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { inspect } from "node:util";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { parseInstalledPluginPeerClientConfiguration } from "./installed-plugin-peer-transport.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export const INSTALLED_PLUGIN_TASK_CONFIG_ENV =
  "CREWON_INSTALLED_PLUGIN_TASK_CONFIG_PATH";
export const INSTALLED_PLUGIN_TASK_CONFIG_SCHEMA =
  "crewon.installed-plugin-control-tasks.v1";
export const PROJECT_CONVERSATION_CREDIT_QUOTE_VERSION =
  "crewon.project-conversation-credit-quote.v1";
export type InstalledPluginTaskEndpoint = Readonly<{
  url: string;
  serviceToken: string;
}>;
export type InstalledPluginTaskConfiguration = Readonly<{
  installRoot: string;
  peer: Readonly<{ origin: string; token: string }>;
  packageAuthority: InstalledPluginTaskEndpoint;
  quoteAuthority?: InstalledPluginTaskEndpoint;
  unmeteredAuthority?: InstalledPluginTaskEndpoint;
  timeoutMs: number;
  maximumPackages: number;
  models?: readonly InstalledPluginModelBinding[];
  projectConversationQuotes?: Readonly<{
    version: typeof PROJECT_CONVERSATION_CREDIT_QUOTE_VERSION;
  }>;
}>;
const configurations = new WeakSet<object>();
const MAX_BYTES = 64 * 1024;

export function assertInstalledPluginTaskConfiguration(
  input: unknown,
): asserts input is InstalledPluginTaskConfiguration {
  if (input === null || typeof input !== "object" || !configurations.has(input))
    invalid();
}

/** Secrets are captured from own environment data, never from a task body. */
export function parseInstalledPluginTaskConfiguration(
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): InstalledPluginTaskConfiguration {
  try {
    const value = pluginSecurityRecord(parsePluginUiJsonValue(input), [
      "schemaVersion",
      "installRoot",
      "peer",
      "packageAuthority",
      ...(Object.hasOwn(input as object, "quoteAuthority")
        ? ["quoteAuthority"]
        : []),
      "timeoutMs",
      "maximumPackages",
      ...(Object.hasOwn(input as object, "models") ? ["models"] : []),
      ...(Object.hasOwn(input as object, "unmeteredAuthority")
        ? ["unmeteredAuthority"]
        : []),
      ...(Object.hasOwn(input as object, "projectConversationQuotes")
        ? ["projectConversationQuotes"]
        : []),
    ]);
    if (
      value.schemaVersion !== INSTALLED_PLUGIN_TASK_CONFIG_SCHEMA ||
      (value.quoteAuthority === undefined &&
        value.unmeteredAuthority === undefined)
    )
      invalid();
    const peer = pluginSecurityRecord(value.peer, [
      "origin",
      "tokenEnvironmentVariable",
    ]);
    if (typeof peer.origin !== "string") invalid();
    if (
      !Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 1 ||
      (value.timeoutMs as number) > 30_000 ||
      !Number.isSafeInteger(value.maximumPackages) ||
      (value.maximumPackages as number) < 1 ||
      (value.maximumPackages as number) > 32
    )
      invalid();
    const verifiedPeer = parseInstalledPluginPeerClientConfiguration({
      origin: peer.origin,
      token: token(peer.tokenEnvironmentVariable, environment),
      deadlineMs: value.timeoutMs as number,
    });
    const projectConversationQuotes = Object.hasOwn(
      value,
      "projectConversationQuotes",
    )
      ? pluginSecurityRecord(value.projectConversationQuotes, ["version"])
      : undefined;
    if (
      projectConversationQuotes !== undefined &&
      projectConversationQuotes.version !==
        PROJECT_CONVERSATION_CREDIT_QUOTE_VERSION
    )
      invalid();
    const configuration = {
      installRoot: privatePath(value.installRoot),
      peer: Object.freeze({
        origin: verifiedPeer.origin,
        token: verifiedPeer.token,
      }),
      packageAuthority: endpoint(value.packageAuthority, environment),
      ...(value.quoteAuthority === undefined
        ? {}
        : { quoteAuthority: endpoint(value.quoteAuthority, environment) }),
      ...(value.unmeteredAuthority === undefined
        ? {}
        : {
            unmeteredAuthority: endpoint(value.unmeteredAuthority, environment),
          }),
      timeoutMs: value.timeoutMs as number,
      maximumPackages: value.maximumPackages as number,
      ...(value.models === undefined
        ? {}
        : { models: parseInstalledPluginModelBindings(value.models) }),
      ...(projectConversationQuotes === undefined
        ? {}
        : {
            projectConversationQuotes: Object.freeze({
              version: PROJECT_CONVERSATION_CREDIT_QUOTE_VERSION,
            }),
          }),
    };
    const redacted = () => ({
      ...configuration,
      peer: { origin: configuration.peer.origin, token: "[REDACTED]" },
      ...(configuration.unmeteredAuthority === undefined
        ? {}
        : {
            unmeteredAuthority: {
              url: configuration.unmeteredAuthority.url,
              serviceToken: "[REDACTED]",
            },
          }),
      packageAuthority: {
        url: configuration.packageAuthority.url,
        serviceToken: "[REDACTED]",
      },
      ...(configuration.quoteAuthority === undefined
        ? {}
        : {
            quoteAuthority: {
              url: configuration.quoteAuthority.url,
              serviceToken: "[REDACTED]",
            },
          }),
    });
    Object.defineProperties(configuration, {
      toJSON: { value: redacted },
      [inspect.custom]: { value: redacted },
    });
    Object.freeze(configuration);
    configurations.add(configuration);
    return configuration;
  } catch {
    invalid();
  }
}

/** No opt-in means no file access, authority allocation, or plugin migration. */
export async function loadInstalledPluginTaskEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  securityMode: "production" | "standalone",
): Promise<InstalledPluginTaskConfiguration | undefined> {
  const field = Object.getOwnPropertyDescriptor(
    environment,
    INSTALLED_PLUGIN_TASK_CONFIG_ENV,
  );
  if (field === undefined || ("value" in field && field.value === undefined))
    return undefined;
  if (
    !("value" in field) ||
    securityMode !== "production" ||
    process.platform === "win32"
  )
    invalid();
  const path = privatePath(field.value);
  const stats = await lstat(path);
  if (
    !stats.isFile() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o077) !== 0 ||
    stats.size > MAX_BYTES ||
    stats.size === 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  )
    invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!samePrivateFile(stats, before)) invalid();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      size > MAX_BYTES ||
      size !== before.size ||
      !samePrivateFile(before, after) ||
      !samePrivateFile(before, current) ||
      (await realpath(path)) !== path
    )
      invalid();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, size),
    );
    return parseInstalledPluginTaskConfiguration(JSON.parse(text), environment);
  } finally {
    await handle.close();
  }
}

function samePrivateFile(expected: Stats, actual: Stats): boolean {
  return (
    actual.isFile() &&
    actual.nlink === 1 &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.uid === expected.uid &&
    actual.mode === expected.mode &&
    actual.nlink === expected.nlink &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.ctimeMs === expected.ctimeMs
  );
}

function endpoint(
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const value = pluginSecurityRecord(input, [
    "url",
    "serviceTokenEnvironmentVariable",
  ]);
  if (
    typeof value.url !== "string" ||
    Buffer.byteLength(value.url) > 2048 ||
    /[\s?#\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.url)
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
  return Object.freeze({
    url: url.href,
    serviceToken: token(value.serviceTokenEnvironmentVariable, environment),
  });
}
function token(
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (typeof input !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(input))
    invalid();
  const field = Object.getOwnPropertyDescriptor(environment, input);
  const value: unknown = field && "value" in field ? field.value : undefined;
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 8192 ||
    !/^[\x21-\x7e]+$/u.test(value)
  )
    invalid();
  return value;
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
function invalid(): never {
  throw new Error("installed_plugin_task_configuration_invalid");
}
