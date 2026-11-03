import {
  INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  INSTALLED_PLUGIN_PEER_WIRE_LIMITS as limits,
  type InstalledPluginPeerCatalogEntry,
  type InstalledPluginPeerRegistration,
  type InstalledPluginPeerRequest,
  type InstalledPluginPeerResponse,
} from "./installed-plugin-peer-types.ts";
import {
  peerActor,
  peerChecked,
  peerDigest,
  peerFail,
  peerIdentity,
  peerJsonObject,
  peerOpaque,
  peerRecord,
  peerResult,
  peerScope,
  peerSelectionRevision,
  peerSource,
  peerTarget,
} from "./installed-plugin-peer-values.ts";

const commonFields = ["protocol", "requestId", "operation", "actor", "scope"];
const configurationFields = ["identity", "configuration"];
const readinessFields = [...configurationFields, "expectedTarget"];

export function parseInstalledPluginPeerRequest(
  input: unknown,
): InstalledPluginPeerRequest {
  return peerChecked(() => {
    const value = peerJsonObject(input, limits.messageBytes);
    if (value.protocol !== INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL) peerFail();
    const common = {
      protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
      requestId: peerOpaque(value.requestId),
      actor: peerActor(value.actor),
      scope: peerScope(value.scope),
    } as const;
    switch (value.operation) {
      case "catalog":
        peerRecord(value, [
          ...commonFields,
          ...(Object.hasOwn(value, "compact") ? ["compact"] : []),
        ]);
        if (Object.hasOwn(value, "compact") && value.compact !== true)
          peerFail();
        return Object.freeze({
          ...common,
          operation: "catalog",
          ...(value.compact === true ? { compact: true as const } : {}),
        });
      case "validateConfiguration":
        peerRecord(value, [...commonFields, ...configurationFields]);
        return Object.freeze({
          ...common,
          operation: "validateConfiguration",
          identity: peerIdentity(value.identity),
          configuration: peerJsonObject(
            value.configuration,
            limits.configurationBytes,
          ),
        });
      case "readiness":
      case "queryReadiness": {
        const query = value.operation === "queryReadiness";
        peerRecord(value, [
          ...commonFields,
          ...readinessFields,
          ...(query ? ["expectedSource"] : []),
        ]);
        const readiness = {
          ...common,
          identity: peerIdentity(value.identity),
          configuration: peerJsonObject(
            value.configuration,
            limits.configurationBytes,
          ),
          expectedTarget: peerTarget(value.expectedTarget),
        };
        return query
          ? Object.freeze({
              ...readiness,
              operation: "queryReadiness",
              expectedSource: peerSource(value.expectedSource),
            })
          : Object.freeze({ ...readiness, operation: "readiness" });
      }
      case "prepareCandidate":
        peerRecord(value, [
          ...commonFields,
          ...readinessFields,
          "expectedSelectionRevision",
        ]);
        return Object.freeze({
          ...common,
          operation: "prepareCandidate",
          identity: peerIdentity(value.identity),
          configuration: peerJsonObject(
            value.configuration,
            limits.configurationBytes,
          ),
          expectedTarget: peerTarget(value.expectedTarget),
          expectedSelectionRevision: peerSelectionRevision(
            value.expectedSelectionRevision,
          ),
        });
      case "queryResolveRegistration":
        peerRecord(value, [...commonFields, "expectedSource"]);
        return Object.freeze({
          ...common,
          operation: "queryResolveRegistration",
          expectedSource: peerSource(value.expectedSource),
        });
      default:
        return peerFail();
    }
  });
}

function registration(input: unknown): InstalledPluginPeerRegistration {
  const value = peerRecord(input, ["identity", "manifest"]);
  return Object.freeze({
    identity: peerIdentity(value.identity),
    manifest: peerJsonObject(value.manifest, limits.manifestBytes),
  });
}
function catalogEntry(input: unknown): InstalledPluginPeerCatalogEntry {
  const value = peerRecord(input, [
    "identity",
    "manifest",
    "configuration",
    "configuredTarget",
  ]);
  return Object.freeze({
    identity: peerIdentity(value.identity),
    manifest: peerJsonObject(value.manifest, limits.manifestBytes),
    configuration: peerJsonObject(
      value.configuration,
      limits.configurationBytes,
    ),
    configuredTarget: peerTarget(value.configuredTarget),
  });
}

/** Private wire projection. Identical package/configuration bytes appear once across model variants. */
export function compactInstalledPluginPeerCatalog(
  input: Extract<InstalledPluginPeerResponse, { operation: "catalog" }>,
) {
  const registrations: Omit<
    InstalledPluginPeerCatalogEntry,
    "configuredTarget"
  >[] = [];
  const indices = new Map<string, number>();
  const targets = input.entries.map(({ configuredTarget, ...registration }) => {
    const key = JSON.stringify(registration);
    let index = indices.get(key);
    if (index === undefined) {
      index = registrations.length;
      indices.set(key, index);
      registrations.push(registration);
    }
    return { registration: index, configuredTarget };
  });
  const { entries: _entries, ...common } = input;
  return { ...common, registrations, targets };
}

function compactCatalogEntries(
  value: Record<string, unknown>,
): readonly InstalledPluginPeerCatalogEntry[] {
  peerRecord(value, [...commonFields, "registrations", "targets"]);
  if (
    !Array.isArray(value.registrations) ||
    !Array.isArray(value.targets) ||
    value.registrations.length > limits.entries ||
    value.targets.length > limits.entries
  )
    peerFail();
  const registrations = value.registrations.map((input) => {
    const record = peerRecord(input, ["identity", "manifest", "configuration"]);
    return Object.freeze({
      identity: peerIdentity(record.identity),
      manifest: peerJsonObject(record.manifest, limits.manifestBytes),
      configuration: peerJsonObject(
        record.configuration,
        limits.configurationBytes,
      ),
    });
  });
  const used = new Set<number>();
  const entries = value.targets.map((input) => {
    const target = peerRecord(input, ["registration", "configuredTarget"]);
    if (
      typeof target.registration !== "number" ||
      !Number.isSafeInteger(target.registration) ||
      target.registration < 0 ||
      target.registration >= registrations.length
    )
      peerFail();
    used.add(target.registration);
    return Object.freeze({
      ...registrations[target.registration]!,
      configuredTarget: peerTarget(target.configuredTarget),
    });
  });
  if (used.size !== registrations.length) peerFail();
  return Object.freeze(entries);
}
export function parseInstalledPluginPeerResponse(
  input: unknown,
): InstalledPluginPeerResponse {
  return peerChecked(() => {
    const value = peerJsonObject(input, limits.messageBytes);
    if (value.protocol !== INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL) peerFail();
    const common = {
      protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
      requestId: peerOpaque(value.requestId),
      actor: peerActor(value.actor),
      scope: peerScope(value.scope),
    } as const;
    switch (value.operation) {
      case "catalog":
        if (Object.hasOwn(value, "registrations"))
          return Object.freeze({
            ...common,
            operation: "catalog",
            entries: compactCatalogEntries(value),
          });
        peerRecord(value, [...commonFields, "entries"]);
        if (
          !Array.isArray(value.entries) ||
          value.entries.length > limits.entries
        )
          peerFail();
        return Object.freeze({
          ...common,
          operation: "catalog",
          entries: Object.freeze(value.entries.map(catalogEntry)),
        });
      case "validateConfiguration":
        peerRecord(value, [...commonFields, "identity", "configurationDigest"]);
        return Object.freeze({
          ...common,
          operation: "validateConfiguration",
          identity: peerIdentity(value.identity),
          configurationDigest: peerDigest(value.configurationDigest),
        });
      case "readiness":
      case "queryReadiness": {
        const query = value.operation === "queryReadiness";
        peerRecord(value, [
          ...commonFields,
          "identity",
          "configurationDigest",
          "expectedTarget",
          "result",
          ...(query ? ["expectedSource"] : []),
        ]);
        const readiness = {
          ...common,
          identity: peerIdentity(value.identity),
          configurationDigest: peerDigest(value.configurationDigest),
          expectedTarget: peerTarget(value.expectedTarget),
          result: peerResult(value.result),
        };
        return query
          ? Object.freeze({
              ...readiness,
              operation: "queryReadiness",
              expectedSource: peerSource(value.expectedSource),
            })
          : Object.freeze({ ...readiness, operation: "readiness" });
      }
      case "prepareCandidate":
        peerRecord(value, [
          ...commonFields,
          "identity",
          "configurationDigest",
          "expectedTarget",
          "expectedSelectionRevision",
          "result",
        ]);
        return Object.freeze({
          ...common,
          operation: "prepareCandidate",
          identity: peerIdentity(value.identity),
          configurationDigest: peerDigest(value.configurationDigest),
          expectedTarget: peerTarget(value.expectedTarget),
          expectedSelectionRevision: peerSelectionRevision(
            value.expectedSelectionRevision,
          ),
          result: peerResult(value.result),
        });
      case "queryResolveRegistration":
        peerRecord(value, [...commonFields, "expectedSource", "registration"]);
        return Object.freeze({
          ...common,
          operation: "queryResolveRegistration",
          expectedSource: peerSource(value.expectedSource),
          registration:
            value.registration === null
              ? null
              : registration(value.registration),
        });
      default:
        return peerFail();
    }
  });
}
