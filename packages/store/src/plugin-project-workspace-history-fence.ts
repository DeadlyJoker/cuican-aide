import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { PluginProjectWorkspaceOwner } from "@crewon/domain";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import {
  hasPostgresConversationSchema,
  hasSqliteConversationSchema,
} from "./project-conversation-schema.ts";
import {
  namespaceProjectValues,
  namespaceProjectWhere,
} from "./plugin-project-workspace-store-support.ts";

// Creating a namespace never adopts an existing project's conversations, including revoked history.
function denied(): never {
  throw new Error("plugin_project_workspace_existing_project_conflict");
}
export function assertSqlitePluginProjectWorkspaceHistory(
  db: DatabaseSync,
  owner: PluginProjectWorkspaceOwner,
): void {
  if (!hasSqliteConversationSchema(db)) return;
  if (
    db
      .prepare(
        `SELECT 1 FROM project_conversation_bindings WHERE ${namespaceProjectWhere} LIMIT 1`,
      )
      .get(...namespaceProjectValues(owner))
  )
    denied();
}
export async function assertPostgresPluginProjectWorkspaceHistory(
  c: PoolClient,
  schema: string,
  owner: PluginProjectWorkspaceOwner,
): Promise<void> {
  if (!(await hasPostgresConversationSchema(c, schema))) return;
  let i = 0;
  if (
    (
      await c.query(
        `SELECT 1 FROM ${pluginInstallationSchemaName(schema)}.project_conversation_bindings WHERE ${namespaceProjectWhere.replaceAll("?", () => `$${++i}`)} LIMIT 1`,
        namespaceProjectValues(owner),
      )
    ).rows.length !== 0
  )
    denied();
}
