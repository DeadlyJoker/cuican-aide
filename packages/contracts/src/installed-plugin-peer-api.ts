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
        peerRecord(value, commonFields);
        return Object.freeze({ ...common, operation: "catalog" });
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
