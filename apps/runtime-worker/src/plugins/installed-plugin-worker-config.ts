import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { inspect } from "node:util";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import { ioJson, ioRecord } from "./plugin-execution-io-network.ts";

export const INSTALLED_PLUGIN_WORKER_CONFIG_ENV =
  "CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH";
export const INSTALLED_PLUGIN_WORKER_SCHEMA =
  "crewon.installed-plugin-worker.v1";
export type InstalledPluginWorkerEndpoint = Readonly<{
  url: string;
  serviceToken: string;
}>;
export type InstalledPluginWorkerConfig = Readonly<{
  installRoot: string;
  releaseDocumentPath: string;
  actorAuthority: InstalledPluginWorkerEndpoint;
  policyAuthority: InstalledPluginWorkerEndpoint;
  profileAuthority: InstalledPluginWorkerEndpoint;
  packageAuthority: InstalledPluginWorkerEndpoint;
  networkAuthority: InstalledPluginWorkerEndpoint | null;
  projectServiceAuthority?: InstalledPluginWorkerEndpoint;
  historicalScope: PluginProfileScope | null;
  timeoutMs: number;
}>;
const captured = new WeakSet<object>();
const MAX_BYTES = 128 * 1024;
const authorityNames = [
  "actorAuthority",
  "policyAuthority",
  "profileAuthority",
  "packageAuthority",
  "networkAuthority",
] as const;

function invalid(): never {
  throw new Error("installed_plugin_worker_configuration_invalid");
}

function pathValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.trim() !== value ||
    Buffer.byteLength(value) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  )
    invalid();
  return value;
}

function endpoint(
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): InstalledPluginWorkerEndpoint {
  const value = ioRecord(input, ["url", "serviceTokenEnvironmentVariable"]);
  if (
    typeof value.url !== "string" ||
    Buffer.byteLength(value.url) > 2048 ||
    /[\s?#\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.url) ||
    typeof value.serviceTokenEnvironmentVariable !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value.serviceTokenEnvironmentVariable)
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
  const field = Object.getOwnPropertyDescriptor(
    environment,
    value.serviceTokenEnvironmentVariable,
  );
  const token: unknown = field && "value" in field ? field.value : undefined;
  if (
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 8192 ||
    !/^[\x21-\x7e]+$/u.test(token)
  )
    invalid();
  const result = { url: url.href, serviceToken: token };
  const redacted = () => ({ url: result.url, serviceToken: "[REDACTED]" });
  Object.defineProperties(result, {
    toJSON: { value: redacted },
    [inspect.custom]: { value: redacted },
  });
  return Object.freeze(result);
}

/** Explicit deployment configuration. No identity, wallet, price, or permission is inferred. */
export function parseInstalledPluginWorkerConfig(
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): InstalledPluginWorkerConfig {
  try {
    const value = ioRecord(ioJson(input, MAX_BYTES), [
      "schemaVersion",
      "installRoot",
      "releaseDocumentPath",
      ...authorityNames,
      ...(Object.hasOwn(input as object, "projectServiceAuthority")
        ? ["projectServiceAuthority"]
        : []),
      "historicalScope",
      "timeoutMs",
    ]);
    if (
      value.schemaVersion !== INSTALLED_PLUGIN_WORKER_SCHEMA ||
      !Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 1 ||
      (value.timeoutMs as number) > 30_000
    )
      invalid();
    const result = Object.freeze({
      installRoot: pathValue(value.installRoot),
      releaseDocumentPath: pathValue(value.releaseDocumentPath),
      actorAuthority: endpoint(value.actorAuthority, environment),
      policyAuthority: endpoint(value.policyAuthority, environment),
      profileAuthority: endpoint(value.profileAuthority, environment),
      packageAuthority: endpoint(value.packageAuthority, environment),
      networkAuthority:
        value.networkAuthority === null
          ? null
          : endpoint(value.networkAuthority, environment),
      ...(value.projectServiceAuthority === undefined
        ? {}
        : {
            projectServiceAuthority: endpoint(
              value.projectServiceAuthority,
              environment,
            ),
          }),
      historicalScope:
        value.historicalScope === null
          ? null
          : parsePluginProfileScope(value.historicalScope),
      timeoutMs: value.timeoutMs as number,
    });
    captured.add(result);
    return result;
  } catch {
    invalid();
  }
}

export function assertInstalledPluginWorkerConfig(
  input: InstalledPluginWorkerConfig,
): void {
  if (!captured.has(input)) invalid();
}

/** One private, bounded, unchanged file is captured before opening the parent database. */
export function loadInstalledPluginWorkerConfig(
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
): InstalledPluginWorkerConfig {
  try {
    const file = pathValue(path),
      original = lstatSync(file);
    const canonical = realpathSync(file);
    if (!original.isFile() || original.isSymbolicLink()) invalid();
    const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        typeof process.getuid !== "function" ||
        before.uid !== process.getuid() ||
        (before.mode & 0o077) !== 0 ||
        before.size < 1 ||
        before.size > MAX_BYTES ||
        before.dev !== original.dev ||
        before.ino !== original.ino
      )
        invalid();
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, count);
        if (read === 0) break;
        count += read;
      }
      const after = fstatSync(fd),
        current = lstatSync(file);
      if (
        count !== before.size ||
        after.size !== before.size ||
        after.nlink !== 1 ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mode !== before.mode ||
        after.uid !== before.uid ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.isSymbolicLink() ||
        realpathSync(file) !== canonical
      )
        invalid();
      const json = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, count),
      );
      return parseInstalledPluginWorkerConfig(JSON.parse(json), environment);
    } finally {
      closeSync(fd);
    }
  } catch {
    invalid();
  }
}
