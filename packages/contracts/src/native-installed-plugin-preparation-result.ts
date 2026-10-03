import {
  copyPluginControlJson,
  pluginControlRecord,
  pluginControlVersion,
} from "./plugin-control-contract-support.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  peerActor,
  peerDigest,
  peerOpaque,
  peerScope,
} from "./installed-plugin-peer-values.ts";
import type {
  InstalledPluginPeerActor,
  InstalledPluginPeerScope,
} from "./installed-plugin-peer-types.ts";

/** Candidate preparation data only. Neither branch grants Node, IO or task authority. */
export const NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_SCHEMA =
  "crewon.installed-plugin-native-preparation-result.v1";
export const NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_MAX_BYTES = 128 * 1024;
export type NativeInstalledPluginPreparationBlockedReason =
  | "notInstalled"
  | "notApproved"
  | "configurationMissing"
  | "configurationIncompatible"
  | "packageUnavailable"
  | "readDenied"
  | "stateChanged";
export type NativeInstalledPluginPreparationTarget = Readonly<{
  executionAuthority: "crewonKernel";
  agentVersionId: string;
  agentVersionContentDigest: string;
  materializationDigest: string;
  authorityId: string;
  runtimeGeneration: string;
  policySnapshotId: string;
  workspaceBindingId: string | null;
}>;
export type NativeInstalledPluginPreparationPackageIdentity = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
}>;
export type NativeInstalledPluginPreparationStatus =
  | Readonly<{
      pluginId: string;
      state: "prepared";
      packageIdentity: NativeInstalledPluginPreparationPackageIdentity;
      configuration: Readonly<{ revision: number; contentDigest: string }>;
      approvalRequirement: "none" | "perAction";
      target: NativeInstalledPluginPreparationTarget;
    }>
  | Readonly<{
      pluginId: string;
      state: "blocked";
      reasonCode: NativeInstalledPluginPreparationBlockedReason;
    }>;
export type NativeInstalledPluginPreparationResult = Readonly<{
  schemaVersion: typeof NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_SCHEMA;
  actor: InstalledPluginPeerActor;
  scope: InstalledPluginPeerScope;
  defaultAgentVersionId: string;
  plugins: readonly NativeInstalledPluginPreparationStatus[];
}>;

const reasons: readonly NativeInstalledPluginPreparationBlockedReason[] = [
  "notInstalled",
  "notApproved",
  "configurationMissing",
  "configurationIncompatible",
  "packageUnavailable",
  "readDenied",
  "stateChanged",
];
function fail(): never {
  throw new ContractValidationError(
    "native_installed_plugin_preparation_result_invalid",
  );
}
function namespace(input: unknown): string {
  const value = peerOpaque(input);
  // Same namespace syntax as the independent package identity, including "crewon".
  if (!/^[a-z][a-z0-9._-]*$/u.test(value)) fail();
  return value;
}
function target(input: unknown): NativeInstalledPluginPreparationTarget {
  const value = pluginControlRecord(input, [
    "executionAuthority",
    "agentVersionId",
    "agentVersionContentDigest",
    "materializationDigest",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
  ]);
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
function status(input: unknown): NativeInstalledPluginPreparationStatus {
  // Exact keys are chosen after bounded own-data copying, so no plugin getter is read.
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  const state = (input as Record<string, unknown>).state;
  if (state === "blocked") {
    const value = pluginControlRecord(input, [
      "pluginId",
      "state",
      "reasonCode",
    ]);
    if (
      !reasons.includes(
        value.reasonCode as NativeInstalledPluginPreparationBlockedReason,
      )
    )
      fail();
    return Object.freeze({
      pluginId: namespace(value.pluginId),
      state,
      reasonCode:
        value.reasonCode as NativeInstalledPluginPreparationBlockedReason,
    });
  }
  const value = pluginControlRecord(input, [
    "pluginId",
    "state",
    "packageIdentity",
    "configuration",
    "approvalRequirement",
    "target",
  ]);
  if (
    state !== "prepared" ||
    (value.approvalRequirement !== "none" &&
      value.approvalRequirement !== "perAction")
  )
    fail();
  const pluginId = namespace(value.pluginId);
  const tuple = pluginControlRecord(value.packageIdentity, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ]);
  const configuration = pluginControlRecord(value.configuration, [
    "revision",
    "contentDigest",
  ]);
  if (
    namespace(tuple.pluginId) !== pluginId ||
    typeof configuration.revision !== "number" ||
    !Number.isSafeInteger(configuration.revision) ||
    configuration.revision < 1 ||
    configuration.revision > 2_147_483_647
  )
    fail();
  return Object.freeze({
    pluginId,
    state,
    packageIdentity: Object.freeze({
      pluginId,
      publisherId: namespace(tuple.publisherId),
      version: pluginControlVersion(tuple.version),
      packageDigest: peerDigest(tuple.packageDigest),
    }),
    configuration: Object.freeze({
      revision: configuration.revision,
      contentDigest: peerDigest(configuration.contentDigest),
    }),
    approvalRequirement: value.approvalRequirement,
    target: target(value.target),
  });
}

/** Strict, bounded, detached DTO. A receiving owner must compare every prepared row with its real release. */
export function parseNativeInstalledPluginPreparationResult(
  input: unknown,
): NativeInstalledPluginPreparationResult {
  try {
    const copied = copyPluginControlJson(input, {
      maxBytes: NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_MAX_BYTES,
      maxNodes: 8192,
    });
    const value = pluginControlRecord(copied, [
      "schemaVersion",
      "actor",
      "scope",
      "defaultAgentVersionId",
      "plugins",
    ]);
    if (
      value.schemaVersion !==
        NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_SCHEMA ||
      !Array.isArray(value.plugins) ||
      value.plugins.length < 1 ||
      value.plugins.length > 32
    )
      fail();
    const actor = peerActor(value.actor),
      scope = peerScope(value.scope);
    if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
      fail();
    const defaultAgentVersionId = peerOpaque(value.defaultAgentVersionId);
    const plugins = value.plugins.map(status),
      ids = new Set<string>(),
      agents = new Set<string>();
    for (const plugin of plugins) {
      if (ids.has(plugin.pluginId)) fail();
      ids.add(plugin.pluginId);
      if (plugin.state === "prepared") {
        if (
          plugin.target.agentVersionId === defaultAgentVersionId ||
          agents.has(plugin.target.agentVersionId)
        )
          fail();
        agents.add(plugin.target.agentVersionId);
      }
    }
    return Object.freeze({
      schemaVersion: NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_SCHEMA,
      actor,
      scope,
      defaultAgentVersionId,
      plugins: Object.freeze(plugins),
    });
  } catch {
    return fail();
  }
}
