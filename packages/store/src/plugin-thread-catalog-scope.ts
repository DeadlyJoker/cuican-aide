import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  hasSqliteConversationSchema,
  hasPostgresConversationSchema,
} from "./project-conversation-schema.ts";
import {
  hasSqlitePluginProjectWorkspaceSchema,
  hasPostgresPluginProjectWorkspaceSchema,
} from "./plugin-project-workspace-schema.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

/** Only ordinary navigation uses this projection. Plugin reads retain their own qualified scope. */
export type OrdinaryThreadCatalogTables = Readonly<{
  conversations?: string;
  officeBindings?: string;
  workspaces?: string;
}>;

export function sqliteOrdinaryThreadCatalogTables(
  db: DatabaseSync,
): OrdinaryThreadCatalogTables {
  return {
    officeBindings: "office_thread_bindings",
    ...(hasSqliteConversationSchema(db)
      ? { conversations: "project_conversation_bindings" }
      : {}),
    ...(hasSqlitePluginProjectWorkspaceSchema(db)
      ? { workspaces: "plugin_project_workspace_namespaces" }
      : {}),
  };
}

export async function postgresOrdinaryThreadCatalogTables(
  client: PoolClient,
  schema: string,
): Promise<OrdinaryThreadCatalogTables> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  return {
    officeBindings: `${prefix}office_thread_bindings`,
    ...((await hasPostgresConversationSchema(client, schema))
      ? { conversations: `${prefix}project_conversation_bindings` }
      : {}),
    ...((await hasPostgresPluginProjectWorkspaceSchema(client, schema))
      ? { workspaces: `${prefix}plugin_project_workspace_namespaces` }
      : {}),
  };
}
