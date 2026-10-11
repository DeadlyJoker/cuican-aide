import {
  pluginInstallationNamespaceId,
  pluginInstallationOpaqueId,
  pluginInstallationRecord,
  pluginInstallationTimestamp,
} from "./plugin-installation-validation.ts";
import { validateCreativeProjectActor } from "./creative-project-validation.ts";
import { normalizeThreadWorkspaceId } from "./thread-lifecycle.ts";
import type { CreativeProjectActor } from "./creative-project.ts";

/** Stable ownership, independent of selected package bytes and transient leases. */
export type PluginProjectWorkspaceOwner = CreativeProjectActor &
  Readonly<{
    profileId: string;
    pluginId: string;
    publisherId: string;
    projectId: string;
  }>;
export type PluginProjectWorkspaceOwnerScope = Omit<
  PluginProjectWorkspaceOwner,
  "projectId"
>;
export type PluginProjectWorkspaceNamespace = Readonly<{
  schemaVersion: "crewon.plugin-project-workspace-namespace.v1";
  owner: PluginProjectWorkspaceOwner;
  workspaceId: string;
  createdAt: string;
}>;
export const PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS = [
  "tenantId",
  "spaceId",
  "principalId",
  "actorId",
  "profileId",
  "pluginId",
  "publisherId",
  "projectId",
] as const;

export function parsePluginProjectWorkspaceOwner(
  input: unknown,
): PluginProjectWorkspaceOwner {
  const v = pluginInstallationRecord(
    input,
    PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS,
  );
  return Object.freeze({
    ...validateCreativeProjectActor({
      tenantId: v.tenantId,
      spaceId: v.spaceId,
      principalId: v.principalId,
      actorId: v.actorId,
    }),
    profileId: pluginInstallationOpaqueId(v.profileId),
    pluginId: pluginInstallationNamespaceId(v.pluginId),
    publisherId: pluginInstallationNamespaceId(v.publisherId),
    projectId: pluginInstallationOpaqueId(v.projectId),
  });
}

export function parsePluginProjectWorkspaceOwnerScope(
  input: unknown,
): PluginProjectWorkspaceOwnerScope {
  const v = pluginInstallationRecord(
    input,
    PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS.slice(0, -1),
  );
  const { projectId: _projectId, ...scope } = parsePluginProjectWorkspaceOwner({
    ...v,
    projectId: "scope-only",
  });
  return Object.freeze(scope);
}

export function parsePluginProjectWorkspaceNamespace(
  input: unknown,
): PluginProjectWorkspaceNamespace {
  const v = pluginInstallationRecord(input, [
    "schemaVersion",
    "owner",
    "workspaceId",
    "createdAt",
  ]);
  if (v.schemaVersion !== "crewon.plugin-project-workspace-namespace.v1")
    throw new Error("plugin_project_workspace_schema_unsupported");
  const workspaceId = normalizeThreadWorkspaceId(v.workspaceId);
  if (workspaceId === null)
    throw new Error("plugin_project_workspace_id_invalid");
  return Object.freeze({
    schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
    owner: parsePluginProjectWorkspaceOwner(v.owner),
    workspaceId,
    createdAt: pluginInstallationTimestamp(v.createdAt),
  });
}
