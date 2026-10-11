import type { DatabaseSync } from "node:sqlite";
import type { DesktopNativePluginPackageIdentity } from "@crewon/contracts/plugins";
import {
  parsePluginProjectWorkspaceOwner,
  type PluginProjectWorkspaceOwner,
} from "@crewon/domain";
import { SqlitePluginInstallationStore } from "./sqlite-plugin-installation-store.ts";
import { assertSqlitePluginProjectWorkspaceMetadata } from "./plugin-project-workspace-metadata-fence.ts";
import { decodeCreativeProject } from "./creative-project-store-records.ts";

/** Trusted Native read only on the existing database. Persistent facts are not a UI/Task permission grant. */
export function readSqliteNativeProjectWorkspaceState(
  input: Readonly<{
    database: DatabaseSync;
    owner: PluginProjectWorkspaceOwner;
    packageIdentity: DesktopNativePluginPackageIdentity;
  }>,
) {
  const { database: db, packageIdentity: pkg } = input;
  const owner = parsePluginProjectWorkspaceOwner(input.owner);
  if (!db.isTransaction)
    throw new Error("native_project_workspace_state_transaction_required");
  if (assertSqlitePluginProjectWorkspaceMetadata(db, owner) !== "protected")
    throw new Error("native_project_workspace_state_metadata_required");
  const project = db
    .prepare(
      "SELECT tenant_id,space_id,project_id,owner_principal_id,revision,state,latest_brief_revision,updated_at,CASE WHEN length(CAST(record_json AS BLOB))<=8192 THEN record_json ELSE NULL END AS record_json FROM creative_projects WHERE tenant_id=? AND space_id=? AND project_id=? AND owner_principal_id=?",
    )
    .get(owner.tenantId, owner.spaceId, owner.projectId, owner.principalId);
  if (decodeCreativeProject(project, owner)?.state !== "active")
    throw new Error("native_project_workspace_state_project_inactive");
  const installations = new SqlitePluginInstallationStore({
    database: db,
    assertOpen() {},
  });
  const scope = {
    tenantId: owner.tenantId,
    spaceId: owner.spaceId,
    profileId: owner.profileId,
  };
  const selection = installations.currentSelection({
    scope,
    pluginId: owner.pluginId,
  });
  const installed = installations.currentPackage({
    scope,
    packageDigest: pkg.packageDigest,
  });
  if (
    !selection ||
    selection.state !== "enabled" ||
    selection.publisherId !== owner.publisherId ||
    selection.selectedPackageDigest !== pkg.packageDigest ||
    !installed ||
    ["pluginId", "publisherId", "version", "packageDigest"].some(
      (key) =>
        installed[key as keyof typeof pkg] !== pkg[key as keyof typeof pkg],
    )
  )
    throw new Error("native_project_workspace_state_selection_mismatch");
  return Object.freeze({ selectionRevision: selection.revision });
}
