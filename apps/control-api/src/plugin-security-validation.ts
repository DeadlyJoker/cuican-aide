import type {
  ActorContext,
  AuthorizationDecision,
  PluginInstallationAuthorizationPort,
  PluginUiAuthorizationDecision,
  PluginUiAuthorizationPort,
} from "@crewon/application";
import {
  parsePluginProfileScope,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationOpaqueId,
  pluginInstallationRevision,
} from "@crewon/domain";

/** Flat authority DTO snapshots: no getters, inherited fields, unknown fields or serialization hooks. */
export function pluginSecurityRecord(
  input: unknown,
  fields: readonly string[],
) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("plugin_security_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  const keys = Reflect.ownKeys(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new Error("plugin_security_fields_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        )
          throw new Error("plugin_security_fields_invalid");
        return [field, descriptor.value] as const;
      }),
    ),
  );
}

export function pluginSecurityActor(input: unknown): ActorContext {
  const value = pluginSecurityRecord(input, [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ]);
  return Object.freeze({
    principalId: pluginInstallationOpaqueId(value.principalId),
    actorId: pluginInstallationOpaqueId(value.actorId),
    tenantId: pluginInstallationOpaqueId(value.tenantId),
    spaceId: pluginInstallationOpaqueId(value.spaceId),
  });
}

export function pluginSecurityInstallationRequest(
  input: unknown,
): Parameters<PluginInstallationAuthorizationPort["authorize"]>[0] {
  const value = pluginSecurityRecord(input, ["actor", "action", "resource"]);
  if (
    value.action !== "pluginInstallation:read" &&
    value.action !== "pluginInstallation:install" &&
    value.action !== "pluginInstallation:select"
  )
    throw new Error("plugin_installation_policy_action_invalid");
  const resource = pluginSecurityRecord(value.resource, [
    "kind",
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "packageDigest",
  ]);
  if (resource.kind !== "pluginInstallation")
    throw new Error("plugin_installation_policy_resource_invalid");
  return Object.freeze({
    actor: pluginSecurityActor(value.actor),
    action: value.action,
    resource: Object.freeze({
      kind: "pluginInstallation",
      ...parsePluginProfileScope({
        tenantId: resource.tenantId,
        spaceId: resource.spaceId,
        profileId: resource.profileId,
      }),
      pluginId:
        resource.pluginId === null
          ? null
          : pluginInstallationNamespaceId(resource.pluginId),
      packageDigest:
        resource.packageDigest === null
          ? null
          : pluginInstallationDigest(resource.packageDigest),
    }),
  });
}

export function pluginSecurityUiRequest(
  input: unknown,
): Parameters<PluginUiAuthorizationPort["authorize"]>[0] {
  const value = pluginSecurityRecord(input, ["actor", "action", "resource"]);
  if (
    value.action !== "catalog" &&
    value.action !== "mount" &&
    value.action !== "asset" &&
    value.action !== "invoke"
  )
    throw new Error("plugin_ui_policy_action_invalid");
  const resource = pluginSecurityRecord(value.resource, [
    "kind",
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "packageDigest",
    "selectionRevision",
    "contributionId",
  ]);
  if (resource.kind !== "pluginUi")
    throw new Error("plugin_ui_policy_resource_invalid");
  return Object.freeze({
    actor: pluginSecurityActor(value.actor),
    action: value.action,
    resource: Object.freeze({
      kind: "pluginUi",
      ...parsePluginProfileScope({
        tenantId: resource.tenantId,
        spaceId: resource.spaceId,
        profileId: resource.profileId,
      }),
      pluginId:
        resource.pluginId === null
          ? null
          : pluginInstallationNamespaceId(resource.pluginId),
      packageDigest:
        resource.packageDigest === null
          ? null
          : pluginInstallationDigest(resource.packageDigest),
      selectionRevision:
        resource.selectionRevision === null
          ? null
          : pluginInstallationRevision(resource.selectionRevision),
      contributionId:
        resource.contributionId === null
          ? null
          : pluginInstallationNamespaceId(resource.contributionId),
    }),
  });
}

export function pluginSecurityUiDecision(
  input: unknown,
): PluginUiAuthorizationDecision {
  const outcome =
    input !== null && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "outcome")
      : undefined;
  if (!outcome || !Object.hasOwn(outcome, "value"))
    throw new Error("plugin_ui_policy_decision_invalid");
  const value = pluginSecurityRecord(
    input,
    outcome.value === "allow"
      ? ["outcome", "authorityEpoch"]
      : ["outcome", "reasonCode"],
  );
  if (
    value.outcome === "allow" &&
    typeof value.authorityEpoch === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value.authorityEpoch)
  )
    return Object.freeze({
      outcome: "allow",
      authorityEpoch: value.authorityEpoch,
    });
  if (
    value.outcome === "deny" &&
    typeof value.reasonCode === "string" &&
    value.reasonCode.length <= 128 &&
    /^[a-z][a-z0-9_:-]*$/u.test(value.reasonCode)
  )
    return Object.freeze({ outcome: "deny", reasonCode: value.reasonCode });
  throw new Error("plugin_ui_policy_decision_invalid");
}

export function pluginSecurityInstallationDecision(
  input: unknown,
): AuthorizationDecision {
  const outcome =
    input !== null && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "outcome")
      : undefined;
  if (!outcome || !Object.hasOwn(outcome, "value"))
    throw new Error("policy_decision_invalid");
  const value = pluginSecurityRecord(
    input,
    outcome.value === "allow" ? ["outcome"] : ["outcome", "reasonCode"],
  );
  if (value.outcome === "allow") return Object.freeze({ outcome: "allow" });
  if (
    value.outcome === "deny" &&
    typeof value.reasonCode === "string" &&
    value.reasonCode.length <= 128 &&
    /^[a-z][a-z0-9_:-]*$/u.test(value.reasonCode)
  )
    return Object.freeze({ outcome: "deny", reasonCode: value.reasonCode });
  throw new Error("policy_decision_invalid");
}
