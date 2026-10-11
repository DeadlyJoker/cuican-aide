import {
  extensionCanonicalJson,
  parsePluginProjectWorkspaceNamespace,
  parsePluginProjectWorkspaceOwner,
  parsePluginProjectWorkspaceOwnerScope,
  pluginInstallationOpaqueId,
  pluginInstallationRecord,
  type PluginProjectWorkspaceNamespace,
  type PluginProjectWorkspaceOwner,
  type PluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";
import type { PluginProjectWorkspaceReadStore } from "@crewon/application";
export const namespaceColumns =
  "tenant_id,space_id,principal_id,actor_id,profile_id,plugin_id,publisher_id,project_id,workspace_id,created_at,record_json";
export const namespaceOwnerWhere =
  "tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND profile_id=? AND plugin_id=? AND publisher_id=?";
export function namespaceOwnerValues(
  o: PluginProjectWorkspaceOwner | PluginProjectWorkspaceOwnerScope,
): [string, string, string, string, string, string, string] {
  return [
    o.tenantId,
    o.spaceId,
    o.principalId,
    o.actorId,
    o.profileId,
    o.pluginId,
    o.publisherId,
  ];
}
export function namespaceValues(
  n: PluginProjectWorkspaceNamespace,
): readonly string[] {
  return [
    ...namespaceOwnerValues(n.owner),
    n.owner.projectId,
    n.workspaceId,
    n.createdAt,
    JSON.stringify(n),
  ];
}
export function namespaceLoad(
  input: Parameters<PluginProjectWorkspaceReadStore["loadNamespace"]>[0],
) {
  return parsePluginProjectWorkspaceOwner(
    pluginInstallationRecord(input, ["owner"]).owner,
  );
}
export function namespaceList(
  input: Parameters<PluginProjectWorkspaceReadStore["listNamespaces"]>[0],
) {
  const v = pluginInstallationRecord(input, [
    "owner",
    "afterProjectId",
    "limit",
  ]);
  if (
    typeof v.limit !== "number" ||
    !Number.isSafeInteger(v.limit) ||
    v.limit < 1 ||
    v.limit > 50
  )
    throw new Error("plugin_project_workspace_limit_invalid");
  return Object.freeze({
    owner: parsePluginProjectWorkspaceOwnerScope(v.owner),
    afterProjectId:
      v.afterProjectId === null
        ? null
        : pluginInstallationOpaqueId(v.afterProjectId),
    limit: v.limit,
  });
}
export function decodeNamespace(
  row: Record<string, unknown> | null | undefined,
  owner?: PluginProjectWorkspaceOwner | PluginProjectWorkspaceOwnerScope,
): PluginProjectWorkspaceNamespace | null {
  if (row == null) return null;
  const n = parsePluginProjectWorkspaceNamespace(
    typeof row.record_json === "string"
      ? JSON.parse(row.record_json)
      : row.record_json,
  );
  const expected = [
    ...namespaceOwnerValues(n.owner),
    n.owner.projectId,
    n.workspaceId,
    n.createdAt,
  ];
  if (
    namespaceColumns
      .split(",")
      .slice(0, -1)
      .some((column, i) => row[column] !== expected[i]) ||
    (owner &&
      Object.keys(owner).some(
        (key) =>
          owner[key as keyof typeof owner] !==
          n.owner[key as keyof typeof n.owner],
      ))
  )
    throw new Error("plugin_project_workspace_record_invalid");
  return n;
}
export function assertNamespaceReplay(
  previous: PluginProjectWorkspaceNamespace,
  next: PluginProjectWorkspaceNamespace,
): void {
  if (extensionCanonicalJson(previous) !== extensionCanonicalJson(next))
    throw new Error("plugin_project_workspace_namespace_conflict");
}
export function pluginProjectWorkspaceLock(workspaceId: string): string {
  return `plugin-project-workspace:${workspaceId}`;
}
