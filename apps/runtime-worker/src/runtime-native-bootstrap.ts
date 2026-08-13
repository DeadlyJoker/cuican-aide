import { inspect } from "node:util";

import type { RuntimeProviderBinding } from "./provider-probe-service.ts";
import type { RuntimeWorkspaceDispatchAuthority } from "./runtime-workspace-binding-resolver.ts";

const SCHEMA_VERSION = "crewon.worker-native-bootstrap.v4";
const PRIVATE_CREDENTIAL_SCHEMA_VERSION =
  "crewon.remote-mcp-private-credentials.v1";
const MAX_CREDENTIAL_BINDINGS = 32;

export type RuntimeNativeWorkspaceBootstrap = Readonly<{
  trustedLocalPath: string;
  deadlineMs: number;
  privateServer: Readonly<{ port: number; token: string }>;
  authority: RuntimeWorkspaceDispatchAuthority;
}>;

export type RuntimeNativeBootstrap = Readonly<{
  provider: RuntimeProviderBinding | null;
  apiKey: string | null;
  probe: Readonly<{ port: number; token: string }>;
  workspace: RuntimeNativeWorkspaceBootstrap | null;
  credentialBindings: RuntimeNativeCredentialBindings | null;
}>;

export type RuntimeNativeCredentialBindingAuthority = Readonly<{
  tenantId: string;
  workspaceBindingId: string;
  runtimeBindingId: string;
  agentVersionId: string;
}>;

export type RuntimeNativeCredentialBinding = Readonly<{
  credentialBindingId: string;
  bearerToken: string;
}>;

/** One-shot owner for private credentials parsed from the native stdin channel. */
export interface RuntimeNativeCredentialBindings {
  readonly authority: RuntimeNativeCredentialBindingAuthority;
  consume(
    expectedAuthority: RuntimeNativeCredentialBindingAuthority,
    consumer: (bindings: readonly RuntimeNativeCredentialBinding[]) => void,
  ): void;
  destroy(): void;
}

let pending: RuntimeNativeBootstrap | null = null;

/** Installs the one-shot, native-owned bootstrap read from zeroized stdin bytes. */
export function installRuntimeNativeBootstrap(value: unknown): void {
  if (pending !== null || !object(value)) {
    throw invalid();
  }
  let parsed: ParsedPrivateBootstrap | null = null;
  try {
    parsed = parseCurrent(value);
    if (parsed === null) throw invalid();
    const provider = parseProvider(value.provider);
    const probe = parseProbe(value.probe);
    if (
      (provider === null && value.apiKey !== null) ||
      (provider !== null &&
        provider.credentialKind === "none" &&
        value.apiKey !== null) ||
      (provider !== null &&
        provider.credentialKind !== "none" &&
        value.apiKey === null) ||
      (value.apiKey !== null && !bounded(value.apiKey, 32 * 1024))
    ) {
      throw invalid();
    }
    pending = redact({
      provider,
      apiKey: value.apiKey as string | null,
      probe,
      workspace: parsed.workspace,
      credentialBindings: parsed.credentialBindings,
    });
  } catch {
    parsed?.credentialBindings?.destroy();
    throw invalid();
  }
}

export function takeRuntimeNativeBootstrap(): RuntimeNativeBootstrap | null {
  const value = pending;
  pending = null;
  return value;
}

type ParsedPrivateBootstrap = Readonly<{
  workspace: RuntimeNativeWorkspaceBootstrap | null;
  credentialBindings: RuntimeNativeCredentialBindings | null;
}>;

function parseCurrent(
  value: Record<string, unknown>,
): ParsedPrivateBootstrap | null {
  if (
    !exactKeys(value, [
      "apiKey",
      "credentialBindings",
      "probe",
      "provider",
      "schemaVersion",
      "workspace",
    ]) ||
    value.schemaVersion !== SCHEMA_VERSION
  ) {
    return null;
  }
  const workspace =
    value.workspace === null ? null : parseWorkspace(value.workspace);
  if (value.credentialBindings === null) {
    return { workspace, credentialBindings: null };
  }
  if (workspace === null) return null;
  const credentialBindings = parseCredentialBindings(value.credentialBindings);
  const authority = credentialBindings.authority;
  if (
    authority.tenantId !== workspace.authority.tenantId ||
    authority.workspaceBindingId !== workspace.authority.workspaceBindingId ||
    authority.runtimeBindingId !== workspace.authority.runtimeBindingId
  ) {
    credentialBindings.destroy();
    return null;
  }
  return { workspace, credentialBindings };
}

function parseCredentialBindings(
  value: unknown,
): RuntimeNativeCredentialBindings {
  if (
    !object(value) ||
    !exactKeys(value, ["authority", "bindings", "schemaVersion"]) ||
    value.schemaVersion !== PRIVATE_CREDENTIAL_SCHEMA_VERSION ||
    !object(value.authority) ||
    !exactKeys(value.authority, [
      "agentVersionId",
      "runtimeBindingId",
      "tenantId",
      "workspaceBindingId",
    ]) ||
    !Array.isArray(value.bindings) ||
    value.bindings.length < 1 ||
    value.bindings.length > MAX_CREDENTIAL_BINDINGS
  ) {
    throw invalid();
  }
  const authority = redact({
    tenantId: opaque(value.authority.tenantId),
    workspaceBindingId: opaque(value.authority.workspaceBindingId),
    runtimeBindingId: opaque(value.authority.runtimeBindingId),
    agentVersionId: opaque(value.authority.agentVersionId),
  });
  const ids = new Set<string>();
  const bindings: { credentialBindingId: string; bearerToken: string }[] =
    value.bindings.map((candidate) => {
      if (
        !object(candidate) ||
        !exactKeys(candidate, ["bearerToken", "credentialBindingId"]) ||
        !bearer(candidate.bearerToken)
      ) {
        throw invalid();
      }
      const credentialBindingId = opaque(candidate.credentialBindingId);
      if (ids.has(credentialBindingId)) throw invalid();
      ids.add(credentialBindingId);
      const parsed = redact({
        credentialBindingId,
        bearerToken: candidate.bearerToken,
      });
      candidate.bearerToken = "";
      return parsed;
    });
  let available = true;
  const owner: RuntimeNativeCredentialBindings = {
    authority,
    consume(expectedAuthority, consumer): void {
      if (
        !available ||
        !sameCredentialAuthority(expectedAuthority, authority) ||
        typeof consumer !== "function"
      ) {
        throw invalid();
      }
      available = false;
      try {
        consumer(bindings);
      } finally {
        for (const binding of bindings) binding.bearerToken = "";
        bindings.length = 0;
      }
    },
    destroy(): void {
      available = false;
      for (const binding of bindings) binding.bearerToken = "";
      bindings.length = 0;
    },
  };
  return redact(owner);
}

function sameCredentialAuthority(
  value: unknown,
  expected: RuntimeNativeCredentialBindingAuthority,
): boolean {
  return (
    object(value) &&
    exactKeys(value, [
      "agentVersionId",
      "runtimeBindingId",
      "tenantId",
      "workspaceBindingId",
    ]) &&
    value.tenantId === expected.tenantId &&
    value.workspaceBindingId === expected.workspaceBindingId &&
    value.runtimeBindingId === expected.runtimeBindingId &&
    value.agentVersionId === expected.agentVersionId
  );
}

function bearer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 4_096 &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

function parseWorkspace(value: unknown): RuntimeNativeWorkspaceBootstrap {
  if (
    !object(value) ||
    !exactKeys(value, [
      "authority",
      "deadlineMs",
      "privateServer",
      "trustedLocalPath",
    ]) ||
    !integer(value.deadlineMs, 1_000, 60_000) ||
    !absolutePath(value.trustedLocalPath)
  ) {
    throw invalid();
  }
  return redact({
    trustedLocalPath: value.trustedLocalPath,
    deadlineMs: Number(value.deadlineMs),
    privateServer: parseWorkspacePrivateServer(value.privateServer),
    authority: parseWorkspaceAuthority(value.authority),
  });
}

function absolutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 16_384)
    return false;
  if (process.platform === "win32")
    return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value);
  return value.startsWith("/");
}

function parseWorkspacePrivateServer(
  value: unknown,
): RuntimeNativeWorkspaceBootstrap["privateServer"] {
  if (
    !object(value) ||
    !exactKeys(value, ["port", "token"]) ||
    !integer(value.port, 0, 65_535) ||
    !secret(value.token, 32, 8_192)
  ) {
    throw invalid();
  }
  return redact({ port: Number(value.port), token: value.token });
}

function parseWorkspaceAuthority(
  value: unknown,
): RuntimeWorkspaceDispatchAuthority {
  const keys = [
    "incarnationId",
    "policySnapshotId",
    "runtimeBindingId",
    "spaceId",
    "tenantId",
    "workspaceBindingId",
  ];
  if (!object(value) || !exactKeys(value, keys)) throw invalid();
  return {
    tenantId: opaque(value.tenantId),
    spaceId: opaque(value.spaceId),
    workspaceBindingId: opaque(value.workspaceBindingId),
    incarnationId: opaque(value.incarnationId),
    runtimeBindingId: opaque(value.runtimeBindingId),
    policySnapshotId: opaque(value.policySnapshotId),
  };
}

function parseProvider(value: unknown): RuntimeProviderBinding | null {
  if (value === null) return null;
  if (
    !object(value) ||
    !exactKeys(value, [
      "credentialKind",
      "endpoint",
      "environmentVariable",
      "providerId",
      "runtimeBindingId",
    ]) ||
    !["environment", "keychain", "none"].includes(
      value.credentialKind as string,
    ) ||
    !bounded(value.endpoint, 2_048) ||
    !bounded(value.providerId, 128) ||
    !bounded(value.runtimeBindingId, 128) ||
    (value.environmentVariable !== null &&
      !boundedEnvironmentVariable(value.environmentVariable)) ||
    (value.credentialKind === "environment") !==
      (value.environmentVariable !== null)
  ) {
    throw invalid();
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint as string);
  } catch {
    throw invalid();
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw invalid();
  }
  return {
    credentialKind:
      value.credentialKind as RuntimeProviderBinding["credentialKind"],
    endpoint: value.endpoint as string,
    environmentVariable: value.environmentVariable as string | null,
    providerId: value.providerId as string,
    runtimeBindingId: value.runtimeBindingId as string,
  };
}

function parseProbe(value: unknown): RuntimeNativeBootstrap["probe"] {
  if (
    !object(value) ||
    !exactKeys(value, ["port", "token"]) ||
    !integer(value.port, 1, 65_535) ||
    !bounded(value.token, 512)
  ) {
    throw invalid();
  }
  return { port: Number(value.port), token: value.token };
}

function opaque(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw invalid();
  }
  return value;
}

function secret(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) >= minimumBytes &&
    Buffer.byteLength(value) <= maximumBytes &&
    /^[A-Za-z0-9._~:-]+$/u.test(value)
  );
}

function integer(value: unknown, minimum: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function boundedEnvironmentVariable(value: unknown): value is string {
  return bounded(value, 128) && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function bounded(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index])
  );
}

function object(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redact<T extends object>(value: T): T {
  Object.defineProperty(value, inspect.custom, {
    configurable: false,
    enumerable: false,
    value: () => "RuntimeNativeBootstrap([REDACTED])",
  });
  return value;
}

function invalid(): Error {
  return new Error("runtime_native_bootstrap_invalid");
}
