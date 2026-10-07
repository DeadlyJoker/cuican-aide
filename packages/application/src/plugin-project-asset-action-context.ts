import { parseProjectAssetUiActionRequest } from "@crewon/contracts/project-assets";
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

/** Actual mount identity and detached public request; this contains no Run or task grant. */
export function projectAssetActionContext(input: PluginUiActionContext) {
  return projectAssetActionContextUsing(
    input,
    parseProjectAssetUiActionRequest,
  );
}
/** Preserve the actual wire action and full mount identity while selecting a protocol decoder. */
export function projectAssetActionContextUsing<
  R extends { action: string; input: unknown },
>(input: PluginUiActionContext, parseRequest: (input: unknown) => R) {
  const v = uiRecord(input, [
    "actor",
    "scope",
    "selection",
    "package",
    "lease",
    "authorityEpoch",
    "action",
    "input",
  ]);
  const actor = uiActor(v.actor as PluginUiActionContext["actor"]),
    scope = uiProfile(v.scope, actor),
    lease = uiPublicLease(v.lease);
  const selection = uiSelection(v.selection, scope, lease.descriptor.pluginId),
    pkg = uiPackage(v.package, scope, selection);
  const request = parseRequest({
    action: v.action,
    input: v.input,
  });
  const authorityEpoch = uiEpoch(v.authorityEpoch);
  if (
    selection.state !== "enabled" ||
    selection.revision !== lease.selectionRevision ||
    pkg.packageDigest !== lease.packageDigest ||
    pkg.version !== lease.descriptor.version ||
    pkg.publisherId !== lease.descriptor.publisherId
  )
    throw new Error("plugin_project_asset_context_invalid");
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
