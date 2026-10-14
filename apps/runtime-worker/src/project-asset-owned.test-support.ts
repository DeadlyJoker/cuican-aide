import { type assetToolsFixture } from "./project-asset-tools-service-owner.test-support.ts";
import { pluginProjectMetadataOwnerColumns } from "../../../packages/store/src/plugin-project-metadata-owner-records.ts";
import { namespaceColumns } from "../../../packages/store/src/plugin-project-workspace-store-support.ts";
import { PLUGIN_PROJECT_WORKSPACE_TABLE } from "../../../packages/store/src/plugin-project-workspace-schema.ts";
const sql = (value: unknown) => "'" + String(value).replaceAll("'", "''") + "'";
type Fixture = Awaited<ReturnType<typeof assetToolsFixture>>;
export async function markAssetToolsOwnedProject(
  f: Fixture,
  variant: "matching" | "foreign" | "missing" | "workspace",
) {
  await f.parent.migratePluginProjectOwnership();
  await f.parent.migratePluginProjectWorkspaceNamespaces();
  const a = f.admitted!.assetStageAdmission;
  const owner = {
    ...f.actor,
    profileId:
      variant === "foreign" ? "foreign-profile" : f.admission.profileId,
    pluginId: f.admission.pluginId,
    publisherId: f.admission.publisherId,
    projectId: a.projectId,
  };
  const at = new Date().toISOString();
  const metadata = {
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner,
    createdAt: at,
  };
  const namespace = {
    schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
    owner,
    workspaceId: variant === "workspace" ? "foreign-workspace" : a.workspaceId,
    createdAt: at,
  };
  const values = [
    owner.tenantId,
    owner.spaceId,
    owner.principalId,
    owner.actorId,
    owner.profileId,
    owner.pluginId,
    owner.publisherId,
    owner.projectId,
  ];
  // Persisted sidecars over an original admitted Stage/Run/Tool fixture; this is neither adoption nor a fabricated grant.
  await f.sql(
    `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${[...values, at, JSON.stringify(metadata)].map(sql).join(",")})`,
  );
  if (variant !== "missing")
    await f.sql(
      `INSERT INTO ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE}(${namespaceColumns}) VALUES(${[...values, namespace.workspaceId, at, JSON.stringify(namespace)].map(sql).join(",")})`,
    );
}
