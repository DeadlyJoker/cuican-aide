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
import { extensionOpaqueId, parsePluginProfileScope } from "@crewon/domain";
import type { PluginCreditSettlementRecoveryScope } from "@crewon/application";
import { ioJson, ioRecord } from "./plugin-execution-io-network.ts";

export const PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV =
  "CREWON_PLUGIN_CREDIT_SETTLEMENT_CONFIG_PATH";
export const PLUGIN_CREDIT_SETTLEMENT_WORKER_SCHEMA =
  "crewon.plugin-credit-settlement-worker.v1";
export type PluginCreditSettlementWorkerEndpoint = Readonly<{
  url: string;
  serviceToken: string;
}>;
export type PluginCreditSettlementWorkerConfig = Readonly<{
  scope: PluginCreditSettlementRecoveryScope;
  authorityId: string;
  authorityRevision: string;
  authorizationAuthority: PluginCreditSettlementWorkerEndpoint;
  decisionAuthority: PluginCreditSettlementWorkerEndpoint;
  timeoutMs: number;
  maxAuthorizationAgeMs: number;
  batchSize: number;
  intervalMs: number;
  maxRoundMs: number;
  migrate: boolean;
}>;
const captured = new WeakSet<object>();
const MAX_BYTES = 64 * 1024;
function invalid(): never {
  throw new Error("plugin_credit_settlement_worker_configuration_invalid");
}
function boundedInteger(value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  )
    invalid();
  return value;
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
): PluginCreditSettlementWorkerEndpoint {
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
  const token: unknown =
    field && Object.hasOwn(field, "value") ? field.value : undefined;
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

/** Independent explicit financial deployment configuration; no identity, funds or prices are inferred. */
export function parsePluginCreditSettlementWorkerConfig(
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): PluginCreditSettlementWorkerConfig {
  try {
    const value = ioRecord(ioJson(input, MAX_BYTES), [
      "schemaVersion",
      "scope",
      "authorityId",
      "authorityRevision",
      "authorizationAuthority",
      "decisionAuthority",
      "timeoutMs",
      "maxAuthorizationAgeMs",
      "batchSize",
      "intervalMs",
      "maxRoundMs",
      "migrate",
    ]);
    if (
      value.schemaVersion !== PLUGIN_CREDIT_SETTLEMENT_WORKER_SCHEMA ||
      typeof value.migrate !== "boolean"
    )
      invalid();
    const result = Object.freeze({
      scope: parsePluginProfileScope(value.scope),
      authorityId: extensionOpaqueId(value.authorityId),
      authorityRevision: extensionOpaqueId(value.authorityRevision),
      authorizationAuthority: endpoint(
        value.authorizationAuthority,
        environment,
      ),
      decisionAuthority: endpoint(value.decisionAuthority, environment),
      timeoutMs: boundedInteger(value.timeoutMs, 30_000),
      maxAuthorizationAgeMs: boundedInteger(
        value.maxAuthorizationAgeMs,
        30_000,
      ),
      batchSize: boundedInteger(value.batchSize, 16),
      intervalMs: boundedInteger(value.intervalMs, 3_600_000),
      maxRoundMs: boundedInteger(value.maxRoundMs, 30_000),
      migrate: value.migrate,
    });
    captured.add(result);
    return result;
  } catch {
    invalid();
  }
}
export function assertPluginCreditSettlementWorkerConfig(
  input: PluginCreditSettlementWorkerConfig,
): void {
  if (!captured.has(input)) invalid();
}

/** Capture one owned 0600 regular file; replacement, hardlinks, symlinks and changing bytes fail closed. */
export function loadPluginCreditSettlementWorkerConfig(
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
): PluginCreditSettlementWorkerConfig {
  try {
    const file = pathValue(path),
      original = lstatSync(file),
      canonical = realpathSync(file);
    if (!original.isFile() || original.isSymbolicLink()) invalid();
    const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        typeof process.getuid !== "function" ||
        before.uid !== process.getuid() ||
        (before.mode & 0o777) !== 0o600 ||
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
      return parsePluginCreditSettlementWorkerConfig(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, count),
          ),
        ),
        environment,
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    invalid();
  }
}

/** Missing opt-in has no filesystem, HTTP, database or financial side effect. */
export function loadPluginCreditSettlementWorkerConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): PluginCreditSettlementWorkerConfig | undefined {
  const field = Object.getOwnPropertyDescriptor(
    environment,
    PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV,
  );
  if (field === undefined) return undefined;
  if (!Object.hasOwn(field, "value")) invalid();
  if (field.value === undefined) return undefined;
  return loadPluginCreditSettlementWorkerConfig(
    pathValue(field.value),
    environment,
  );
}
