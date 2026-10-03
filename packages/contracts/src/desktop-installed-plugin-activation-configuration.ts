import { ContractValidationError } from "./contract-validation-error.ts";
import {
  copyPluginControlJson,
  pluginControlRecord,
} from "./plugin-control-contract-support.ts";
import {
  peerActor,
  peerDigest,
  peerIdentity,
  peerJsonObject,
  peerOpaque,
  peerScope,
  peerTarget,
} from "./installed-plugin-peer-values.ts";
import {
  INSTALLED_PLUGIN_PEER_WIRE_LIMITS as limits,
  type InstalledPluginPeerActor,
  type InstalledPluginPeerScope,
  type InstalledPluginPeerIdentity,
  type InstalledPluginPeerJsonObject,
} from "./installed-plugin-peer-types.ts";
import type { NativeInstalledPluginPreparationTarget } from "./native-installed-plugin-preparation-result.ts";

/** Private Main-to-Control publication. No task, payer, credit or supplier authority is encoded. */
export const DESKTOP_INSTALLED_PLUGIN_ACTIVATION_SCHEMA =
  "crewon.desktop-installed-plugin-activation.v1";
export const DESKTOP_INSTALLED_PLUGIN_ACTIVATION_MAX_BYTES = 1024 * 1024;
export type DesktopInstalledPluginActivationEntry = Readonly<{
  identity: InstalledPluginPeerIdentity;
  configuration: InstalledPluginPeerJsonObject;
  target: NativeInstalledPluginPreparationTarget;
}>;
export type DesktopInstalledPluginActivationConfiguration = Readonly<{
  schemaVersion: typeof DESKTOP_INSTALLED_PLUGIN_ACTIVATION_SCHEMA;
  actor: InstalledPluginPeerActor;
  scope: InstalledPluginPeerScope;
  installRoot: string;
  peer: Readonly<{ origin: string; tokenEnvironmentVariable: string }>;
  authority: Readonly<{ url: string; serviceTokenEnvironmentVariable: string }>;
  timeoutMs: number;
  entries: readonly DesktopInstalledPluginActivationEntry[];
}>;
export class DesktopInstalledPluginActivationContractError extends ContractValidationError {
  constructor() {
    super("desktop_installed_plugin_activation_configuration_invalid");
    this.name = "DesktopInstalledPluginActivationContractError";
  }
}
function fail(): never {
  throw new DesktopInstalledPluginActivationContractError();
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
    fail();
  return input;
}
function absolutePath(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 4096 ||
    !input.startsWith("/") ||
    input === "/" ||
    input.endsWith("/") ||
    /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input) ||
    input
      .split("/")
      .slice(1)
      .some((part) => part === "" || part === "." || part === "..")
  )
    fail();
  return input;
}
function peerOrigin(input: unknown): string {
  if (typeof input !== "string") fail();
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(input);
  if (!match || Number(match[1]) > 65535 || new URL(input).origin !== input)
    fail();
  return input;
}
function authorityUrl(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 2048 ||
    input !== input.trim() ||
    /[\\\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    fail();
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    input.includes("?") ||
    input.includes("#")
  )
    fail();
  return input;
}
function target(input: unknown): NativeInstalledPluginPreparationTarget {
  const value = peerTarget(input);
  if (value.executionAuthority !== "crewonKernel") fail();
  return Object.freeze({
    executionAuthority: "crewonKernel",
    agentVersionId: peerOpaque(value.agentVersionId),
    agentVersionContentDigest: peerDigest(value.agentVersionContentDigest),
    materializationDigest: peerDigest(value.materializationDigest),
    authorityId: peerOpaque(value.authorityId),
    runtimeGeneration: peerOpaque(value.runtimeGeneration),
    policySnapshotId: peerOpaque(value.policySnapshotId),
    workspaceBindingId:
      value.workspaceBindingId === null
        ? null
        : peerOpaque(value.workspaceBindingId),
  });
}
function canonical(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  const value = input as Readonly<Record<string, unknown>>;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
/** Detached bounded DTO. Receiving owners must bind it to actual Native sources and current facts. */
export function parseDesktopInstalledPluginActivationConfiguration(
  input: unknown,
): DesktopInstalledPluginActivationConfiguration {
  try {
    const value = pluginControlRecord(
      copyPluginControlJson(input, {
        maxBytes: DESKTOP_INSTALLED_PLUGIN_ACTIVATION_MAX_BYTES,
        maxNodes: 65536,
      }),
      [
        "schemaVersion",
        "actor",
        "scope",
        "installRoot",
        "peer",
        "authority",
        "timeoutMs",
        "entries",
      ],
    );
    if (
      value.schemaVersion !== DESKTOP_INSTALLED_PLUGIN_ACTIVATION_SCHEMA ||
      typeof value.timeoutMs !== "number" ||
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1000 ||
      value.timeoutMs > 30000 ||
      !Array.isArray(value.entries) ||
      value.entries.length < 1 ||
      value.entries.length > 32
    )
      fail();
    const actor = peerActor(value.actor);
    const scope = peerScope(value.scope);
    if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
      fail();
    const peer = pluginControlRecord(value.peer, [
      "origin",
      "tokenEnvironmentVariable",
    ]);
    const authority = pluginControlRecord(value.authority, [
      "url",
      "serviceTokenEnvironmentVariable",
    ]);
    if (
      peer.tokenEnvironmentVariable !==
      "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN"
    )
      fail();
    const peerToken = "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN";
    const authorityToken = tokenReference(
      authority.serviceTokenEnvironmentVariable,
    );
    if (peerToken === authorityToken) fail();
    const seen = new Set<string>();
    const entries = value.entries.map((inputEntry) => {
      const entry = pluginControlRecord(inputEntry, [
        "identity",
        "configuration",
        "target",
      ]);
      const parsed = Object.freeze({
        identity: peerIdentity(entry.identity),
        configuration: peerJsonObject(
          entry.configuration,
          limits.configurationBytes,
        ),
        target: target(entry.target),
      });
      const key = canonical(parsed);
      if (seen.has(key)) fail();
      seen.add(key);
      return parsed;
    });
    return Object.freeze({
      schemaVersion: DESKTOP_INSTALLED_PLUGIN_ACTIVATION_SCHEMA,
      actor,
      scope,
      installRoot: absolutePath(value.installRoot),
      peer: Object.freeze({
        origin: peerOrigin(peer.origin),
        tokenEnvironmentVariable: peerToken,
      }),
      authority: Object.freeze({
        url: authorityUrl(authority.url),
        serviceTokenEnvironmentVariable: authorityToken,
      }),
      timeoutMs: value.timeoutMs,
      entries: Object.freeze(entries),
    });
  } catch {
    fail();
  }
}
