import { isAbsolute, resolve } from "node:path";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import { ioJson, ioRecord } from "./plugin-execution-io-network.ts";
import {
  captureNativeAuthorityFile,
  nativeAuthorityFailure,
} from "./installed-plugin-native-authority-files.ts";
import {
  loadInstalledPluginWorkerConfig,
  parseInstalledPluginWorkerConfig,
  type InstalledPluginWorkerConfig,
} from "./installed-plugin-worker-config.ts";

export const INSTALLED_PLUGIN_NATIVE_WORKER_SCHEMA =
  "crewon.installed-plugin-native-worker.v1";
export type InstalledPluginNativeWorkerConfig = Readonly<{
  schemaVersion: typeof INSTALLED_PLUGIN_NATIVE_WORKER_SCHEMA;
  installRoot: string;
  releaseDocumentPath: string;
  nativeAuthorityPath: string;
  historicalScope: PluginProfileScope | null;
  timeoutMs: number;
}>;
export type InstalledPluginAuthorityConfig =
  | InstalledPluginWorkerConfig
  | InstalledPluginNativeWorkerConfig;
const issued = new WeakMap<InstalledPluginNativeWorkerConfig, () => void>();
function path(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input !== input.trim() ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    nativeAuthorityFailure("configuration_invalid");
  return input;
}
function native(
  input: unknown,
  assertCurrent: () => void,
): InstalledPluginNativeWorkerConfig {
  const value = ioRecord(ioJson(input, 128 * 1024), [
    "schemaVersion",
    "installRoot",
    "releaseDocumentPath",
    "nativeAuthorityPath",
    "historicalScope",
    "timeoutMs",
  ]);
  if (
    value.schemaVersion !== INSTALLED_PLUGIN_NATIVE_WORKER_SCHEMA ||
    !Number.isSafeInteger(value.timeoutMs) ||
    (value.timeoutMs as number) < 1 ||
    (value.timeoutMs as number) > 30_000
  )
    nativeAuthorityFailure("configuration_invalid");
  const result = Object.freeze({
    schemaVersion: INSTALLED_PLUGIN_NATIVE_WORKER_SCHEMA,
    installRoot: path(value.installRoot),
    releaseDocumentPath: path(value.releaseDocumentPath),
    nativeAuthorityPath: path(value.nativeAuthorityPath),
    historicalScope:
      value.historicalScope === null
        ? null
        : parsePluginProfileScope(value.historicalScope),
    timeoutMs: value.timeoutMs as number,
  });
  issued.set(result, assertCurrent);
  return result;
}
export function assertInstalledPluginNativeWorkerConfig(
  config: InstalledPluginNativeWorkerConfig,
): void {
  const current = issued.get(config);
  if (!current) nativeAuthorityFailure("configuration_unissued");
  current();
}
/** The original remote parser remains strict and unchanged. Native is a distinct host protocol. */
export function parseInstalledPluginAuthorityConfig(
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): InstalledPluginAuthorityConfig {
  const schema =
    input && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "schemaVersion")?.value
      : undefined;
  return schema === INSTALLED_PLUGIN_NATIVE_WORKER_SCHEMA
    ? native(input, () => {})
    : parseInstalledPluginWorkerConfig(input, environment);
}
/** Capture one private file before opening any database. Native owners keep this file proof live. */
export function loadInstalledPluginAuthorityConfig(
  pathValue: string,
  environment: Readonly<Record<string, string | undefined>>,
): InstalledPluginAuthorityConfig {
  let remoteFailure: unknown;
  try {
    return loadInstalledPluginWorkerConfig(pathValue, environment);
  } catch (error) {
    remoteFailure = error;
  }
  let file: ReturnType<typeof captureNativeAuthorityFile>;
  try {
    file = captureNativeAuthorityFile(path(pathValue), 128 * 1024);
  } catch {
    throw remoteFailure;
  }
  const schema =
    file.value && typeof file.value === "object"
      ? Object.getOwnPropertyDescriptor(file.value, "schemaVersion")?.value
      : undefined;
  if (schema !== INSTALLED_PLUGIN_NATIVE_WORKER_SCHEMA) throw remoteFailure;
  return native(file.value, file.assertCurrent);
}
