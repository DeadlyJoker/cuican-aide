import {
  PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS,
  parsePluginProjectWorkspaceOwner,
  pluginInstallationRecord,
  pluginInstallationTimestamp,
  type PluginProjectWorkspaceOwner,
} from "@crewon/domain";

/** Persisted data only: this record does not grant project creation or adoption. */
export type PluginProjectMetadataOwnerRecord = Readonly<{
  schemaVersion: "crewon.plugin-project-metadata-owner.v1";
  owner: PluginProjectWorkspaceOwner;
  createdAt: string;
}>;
export const pluginProjectMetadataOwnerColumns = [
  "tenant_id",
  "space_id",
  "principal_id",
  "actor_id",
  "profile_id",
  "plugin_id",
  "publisher_id",
  "project_id",
  "created_at",
  "record_json",
] as const;

export function parsePluginProjectMetadataOwnerRecord(
  input: unknown,
): PluginProjectMetadataOwnerRecord {
  const value = pluginInstallationRecord(input, [
    "schemaVersion",
    "owner",
    "createdAt",
  ]);
  if (value.schemaVersion !== "crewon.plugin-project-metadata-owner.v1")
    throw new Error("plugin_project_metadata_owner_record_invalid");
  const parsed: PluginProjectMetadataOwnerRecord = Object.freeze({
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner: parsePluginProjectWorkspaceOwner(value.owner),
    createdAt: pluginInstallationTimestamp(value.createdAt),
  });
  if (Buffer.byteLength(JSON.stringify(parsed)) > 4096)
    throw new Error("plugin_project_metadata_owner_record_invalid");
  return parsed;
}

/** The later original Store reader must supply both its actual owner and joined principal. */
export function decodePluginProjectMetadataOwnerRecord(
  row: Record<string, unknown> | null | undefined,
  input: Readonly<{
    expectedOwner: PluginProjectWorkspaceOwner;
    storedProjectPrincipalId: string;
  }>,
): PluginProjectMetadataOwnerRecord | null {
  const expectedOwner = parsePluginProjectWorkspaceOwner(input.expectedOwner);
  if (row == null) return null;
  const record = parsePluginProjectMetadataOwnerRecord(
    typeof row.record_json === "string"
      ? JSON.parse(row.record_json)
      : row.record_json,
  );
  if (
    input.storedProjectPrincipalId !== record.owner.principalId ||
    row.created_at !== record.createdAt ||
    PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS.some(
      (field, index) =>
        record.owner[field] !== expectedOwner[field] ||
        row[pluginProjectMetadataOwnerColumns[index]!] !== record.owner[field],
    )
  )
    throw new Error("plugin_project_metadata_owner_record_invalid");
  return record;
}
