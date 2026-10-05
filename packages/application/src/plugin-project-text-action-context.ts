import { parseProjectTextUiActionRequest } from "@crewon/contracts/project-texts-ui";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import {
  uiActor,
  uiEpoch,
  uiPackage,
  uiProfile,
  uiPublicLease,
  uiRecord,
  uiSelection,
} from "./plugin-ui-application-support.ts";

/** Snapshot actual captured UI data without constructing task or Run evidence. */
export function projectTextActionContext(input: PluginUiActionContext) {
  const value = uiRecord(input, [
    "actor",
    "scope",
    "selection",
    "package",
    "lease",
    "authorityEpoch",
    "action",
    "input",
  ]);
  const actor = uiActor(value.actor as PluginUiActionContext["actor"]);
  const scope = uiProfile(value.scope, actor);
  const lease = uiPublicLease(value.lease);
  const selection = uiSelection(
    value.selection,
    scope,
    lease.descriptor.pluginId,
  );
  const pkg = uiPackage(value.package, scope, selection);
  const request = parseProjectTextUiActionRequest({
    action: value.action,
    input: value.input,
  });
  const authorityEpoch = uiEpoch(value.authorityEpoch);
  if (
    selection.state !== "enabled" ||
    selection.revision !== lease.selectionRevision ||
    pkg.packageDigest !== lease.packageDigest ||
    pkg.version !== lease.descriptor.version ||
    pkg.publisherId !== lease.descriptor.publisherId
  )
    throw new Error("plugin_project_text_context_invalid");
  const context = Object.freeze({
    actor,
    scope,
    selection,
    package: pkg,
    lease,
    authorityEpoch,
    action: request.action,
    input: request.input,
  }) as unknown as PluginUiActionContext;
  const installation = Object.freeze({
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    profileId: scope.profileId,
    pluginId: pkg.pluginId,
    publisherId: pkg.publisherId,
    version: pkg.version,
    packageDigest: pkg.packageDigest,
    selectionRevision: selection.revision,
  });
  return Object.freeze({
    context,
    installation,
    request,
    fingerprint: JSON.stringify(context),
  });
}
