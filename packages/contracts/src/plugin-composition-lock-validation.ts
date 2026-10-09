import { ContractValidationError } from "./contract-validation-error.ts";
import {
  pluginControlOpaqueId,
  pluginControlRecord,
  pluginControlRevision,
  pluginControlVersion,
} from "./plugin-control-contract-support.ts";
import {
  PLUGIN_COMPOSITION_LOCK_LIMITS as limits,
  type PluginCompositionEdge,
  type PluginCompositionHostService,
  type PluginCompositionNode,
  type PluginCompositionScope,
} from "./plugin-composition-lock-types.ts";

export function compositionFail(
  code = "plugin_composition_lock_invalid",
): never {
  throw new ContractValidationError(code);
}
export function compositionDigest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    compositionFail();
  return input;
}
function identifier(input: unknown): string {
  if (typeof input !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(input))
    compositionFail();
  return input;
}
function apiVersion(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input)
  )
    compositionFail();
  return input;
}
export function compositionArray(
  input: unknown,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum) compositionFail();
  return input;
}
export function compositionScope(input: unknown): PluginCompositionScope {
  const value = pluginControlRecord(input, [
    "tenantId",
    "spaceId",
    "profileId",
    "authorityEpoch",
  ]);
  return Object.freeze({
    tenantId: pluginControlOpaqueId(value.tenantId),
    spaceId: pluginControlOpaqueId(value.spaceId),
    profileId: pluginControlOpaqueId(value.profileId),
    authorityEpoch: pluginControlOpaqueId(value.authorityEpoch),
  });
}
export function compositionNode(input: unknown): PluginCompositionNode {
  const value = pluginControlRecord(input, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "hostApi",
    "selectionRevision",
    "requires",
    "provides",
  ]);
  if (value.hostApi !== "crewon.plugin-host.v1")
    compositionFail("plugin_composition_host_api_unsupported");
  const requires = compositionArray(value.requires, limits.servicesPerPlugin)
    .map((input) => {
      const item = pluginControlRecord(input, [
        "service",
        "apiVersion",
        "optional",
      ]);
      if (typeof item.optional !== "boolean") compositionFail();
      return Object.freeze({
        service: identifier(item.service),
        apiVersion: apiVersion(item.apiVersion),
        optional: item.optional,
      });
    })
    .sort(byService);
  const provides = compositionArray(value.provides, limits.servicesPerPlugin)
    .map((input) => {
      const item = pluginControlRecord(input, ["service", "apiVersion"]);
      return Object.freeze({
        service: identifier(item.service),
        apiVersion: apiVersion(item.apiVersion),
      });
    })
    .sort(byService);
  if (
    new Set(requires.map((r) => r.service)).size !== requires.length ||
    new Set(provides.map((r) => r.service)).size !== provides.length ||
    requires.some((r) => provides.some((p) => p.service === r.service))
  )
    compositionFail("plugin_composition_service_conflict");
  return Object.freeze({
    pluginId: identifier(value.pluginId),
    publisherId: identifier(value.publisherId),
    version: pluginControlVersion(value.version),
    packageDigest: compositionDigest(value.packageDigest),
    hostApi: value.hostApi,
    selectionRevision: pluginControlRevision(value.selectionRevision),
    requires: Object.freeze(requires),
    provides: Object.freeze(provides),
  });
}
export function compositionHostService(
  input: unknown,
): PluginCompositionHostService {
  const value = pluginControlRecord(input, [
    "service",
    "apiVersion",
    "implementationId",
    "implementationRevision",
  ]);
  return Object.freeze({
    service: identifier(value.service),
    apiVersion: apiVersion(value.apiVersion),
    implementationId: pluginControlOpaqueId(value.implementationId),
    implementationRevision: pluginControlRevision(value.implementationRevision),
  });
}
export function compositionEdge(input: unknown): PluginCompositionEdge {
  const value = pluginControlRecord(input, [
    "consumerPluginId",
    "service",
    "apiVersion",
    "provider",
  ]);
  const kind = pluginControlRecord(
    value.provider,
    [
      "kind",
      "pluginId",
      "packageDigest",
      "implementationId",
      "implementationRevision",
    ],
    {
      optional: [
        "pluginId",
        "packageDigest",
        "implementationId",
        "implementationRevision",
      ],
    },
  ).kind;
  let provider: PluginCompositionEdge["provider"];
  if (kind === "plugin") {
    const p = pluginControlRecord(value.provider, [
      "kind",
      "pluginId",
      "packageDigest",
    ]);
    provider = Object.freeze({
      kind,
      pluginId: identifier(p.pluginId),
      packageDigest: compositionDigest(p.packageDigest),
    });
  } else if (kind === "host") {
    const p = pluginControlRecord(value.provider, [
      "kind",
      "implementationId",
      "implementationRevision",
    ]);
    provider = Object.freeze({
      kind,
      implementationId: pluginControlOpaqueId(p.implementationId),
      implementationRevision: pluginControlRevision(p.implementationRevision),
    });
  } else if (kind === "absent") {
    pluginControlRecord(value.provider, ["kind"]);
    provider = Object.freeze({ kind });
  } else compositionFail();
  return Object.freeze({
    consumerPluginId: identifier(value.consumerPluginId),
    service: identifier(value.service),
    apiVersion: apiVersion(value.apiVersion),
    provider,
  });
}
export function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function byService(
  left: { service: string; apiVersion: string },
  right: { service: string; apiVersion: string },
): number {
  return (
    codeUnitCompare(left.service, right.service) ||
    codeUnitCompare(left.apiVersion, right.apiVersion)
  );
}
