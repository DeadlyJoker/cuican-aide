import {
  copyPluginControlJson,
  pluginControlRecord,
  pluginControlVersion,
} from "./plugin-control-contract-support.ts";
import {
  INSTALLED_PLUGIN_PEER_WIRE_LIMITS as limits,
  type InstalledPluginPeerActor,
  type InstalledPluginPeerExpectedSource,
  type InstalledPluginPeerIdentity,
  type InstalledPluginPeerJsonObject,
  type InstalledPluginPeerReadinessResult,
  type InstalledPluginPeerScope,
  type InstalledPluginPeerUnavailableReason,
} from "./installed-plugin-peer-types.ts";

export class InstalledPluginPeerContractError extends Error {
  readonly code = "installed_plugin_peer_contract_invalid";
  constructor() {
    super("installed_plugin_peer_contract_invalid");
    this.name = "InstalledPluginPeerContractError";
  }
}
export function peerFail(): never {
  throw new InstalledPluginPeerContractError();
}
export function peerChecked<T>(read: () => T): T {
  try {
    return read();
  } catch {
    return peerFail();
  }
}
export function peerJsonObject(
  input: unknown,
  maxBytes: number,
): InstalledPluginPeerJsonObject {
  const copied = copyPluginControlJson(input, {
    maxBytes,
    maxNodes: limits.jsonNodes,
  });
  if (copied === null || typeof copied !== "object" || Array.isArray(copied))
    peerFail();
  return copied as InstalledPluginPeerJsonObject;
}
export function peerRecord(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  return pluginControlRecord(input, fields);
}
export function peerOpaque(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 128 ||
    input !== input.trim() ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input) ||
    new TextEncoder().encode(input).byteLength > 128
  )
    peerFail();
  return input;
}
function namespace(input: unknown): string {
  const value = peerOpaque(input);
  if (!/^[a-z][a-z0-9._-]*$/u.test(value)) peerFail();
  return value;
}
export function peerDigest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    peerFail();
  return input;
}
export function peerSelectionRevision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    peerFail();
  return input;
}
export function peerActor(input: unknown): InstalledPluginPeerActor {
  const value = peerRecord(input, [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ]);
  return Object.freeze({
    principalId: peerOpaque(value.principalId),
    actorId: peerOpaque(value.actorId),
    tenantId: peerOpaque(value.tenantId),
    spaceId: peerOpaque(value.spaceId),
  });
}
export function peerScope(input: unknown): InstalledPluginPeerScope {
  const value = peerRecord(input, ["tenantId", "spaceId", "profileId"]);
  return Object.freeze({
    tenantId: peerOpaque(value.tenantId),
    spaceId: peerOpaque(value.spaceId),
    profileId: peerOpaque(value.profileId),
  });
}
export function peerIdentity(input: unknown): InstalledPluginPeerIdentity {
  const value = peerRecord(input, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "manifestDigest",
    "implementationDigest",
  ]);
  return Object.freeze({
    pluginId: namespace(value.pluginId),
    publisherId: namespace(value.publisherId),
    version: pluginControlVersion(value.version),
    packageDigest: peerDigest(value.packageDigest),
    manifestDigest: peerDigest(value.manifestDigest),
    implementationDigest: peerDigest(value.implementationDigest),
  });
}
/** Complete wire shape only; the receiving application must parse and verify the domain target. */
export function peerTarget(input: unknown): InstalledPluginPeerJsonObject {
  const value = peerJsonObject(input, limits.targetBytes);
  peerRecord(value, [
    "executionAuthority",
    "agentVersionId",
    "agentVersionContentDigest",
    "materializationDigest",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
  ]);
  if (
    typeof value.executionAuthority !== "string" ||
    typeof value.agentVersionId !== "string" ||
    typeof value.agentVersionContentDigest !== "string" ||
    typeof value.materializationDigest !== "string" ||
    typeof value.authorityId !== "string" ||
    typeof value.runtimeGeneration !== "string" ||
    typeof value.policySnapshotId !== "string" ||
    (value.workspaceBindingId !== null &&
      typeof value.workspaceBindingId !== "string")
  )
    peerFail();
  return value;
}
export function peerSource(input: unknown): InstalledPluginPeerExpectedSource {
  const value = peerRecord(input, ["admission", "binding", "operationId"]);
  if (
    typeof value.operationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      value.operationId,
    )
  )
    peerFail();
  return Object.freeze({
    admission: peerJsonObject(value.admission, limits.sourceBytes),
    binding: peerJsonObject(value.binding, limits.sourceBytes),
    operationId: value.operationId,
  });
}
export function peerResult(input: unknown): InstalledPluginPeerReadinessResult {
  const value = peerJsonObject(input, limits.targetBytes + 128);
  if (value.outcome === "ready") {
    peerRecord(value, ["outcome", "target"]);
    return Object.freeze({
      outcome: "ready",
      target: peerTarget(value.target),
    });
  }
  peerRecord(value, ["outcome", "reasonCode"]);
  if (
    value.outcome !== "unavailable" ||
    ![
      "extension_runtime_unavailable",
      "extension_implementation_unavailable",
      "extension_credential_unavailable",
      "extension_execution_authority_unsupported",
    ].includes(value.reasonCode as string)
  )
    peerFail();
  return Object.freeze({
    outcome: "unavailable",
    reasonCode: value.reasonCode as InstalledPluginPeerUnavailableReason,
  });
}
