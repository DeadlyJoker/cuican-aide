import type { DatabaseSync } from "node:sqlite";
import { migrateSqlitePluginProjectMetadataOwners } from "./plugin-project-metadata-owner-schema.ts";
import { migrateSqlitePluginProjectWorkspaces } from "./plugin-project-workspace-schema.ts";

/** Explicit trusted startup DDL on the original parent connection. No project is inserted, adopted or granted. */
export function migrateSqlitePluginProjectOwnership(
  input: Readonly<{ database: DatabaseSync; assertOpen(): void }>,
): void {
  input.assertOpen();
  if (input.database.isTransaction)
    throw new Error("plugin_project_ownership_schema_nested_transaction");
  input.database.exec("BEGIN IMMEDIATE");
  try {
    migrateSqlitePluginProjectMetadataOwners(input.database);
    migrateSqlitePluginProjectWorkspaces(input.database);
    input.assertOpen();
    input.database.exec("COMMIT");
  } catch (error) {
    input.database.exec("ROLLBACK");
    throw error;
  }
}
