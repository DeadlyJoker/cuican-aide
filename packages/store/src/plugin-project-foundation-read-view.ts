import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import {
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
  type ProjectFoundationStore,
} from "@crewon/application";
import type {
  CreativeProjectLegacyAccess,
  PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { readSqliteOwnedCreativeProject } from "./plugin-project-owned-read-sqlite.ts";
import { readPostgresOwnedCreativeProject } from "./plugin-project-owned-read-postgres.ts";
import type { PluginProjectReadCall } from "./plugin-project-owned-read-sqlite.ts";
export const PROJECT_FOUNDATION_SOURCE_READ_METHODS = [
  "loadFoundation",
  "loadSource",
  "readSourcePage",
  "listSourceChapters",
] as const;
export type ProjectFoundationSourceReadMethod =
  (typeof PROJECT_FOUNDATION_SOURCE_READ_METHODS)[number];
type Readers = {
  [K in ProjectFoundationSourceReadMethod]: (
    input: Parameters<ProjectFoundationStore[K]>[0],
    scope?: PluginProjectReadScope,
  ) => ReturnType<ProjectFoundationStore[K]>;
};
/** The original immutable dependency readers only; no upload, proposal or mutation port. */
export function bindProjectFoundationReadView(
  store: Readers,
  scope: PluginProjectReadScope,
) {
  qualifyPluginProjectReadScope(scope);
  return Object.freeze({
    loadFoundation: (
      input: Parameters<ProjectFoundationStore["loadFoundation"]>[0],
    ) => store.loadFoundation(input, scope),
    loadSource: (input: Parameters<ProjectFoundationStore["loadSource"]>[0]) =>
      store.loadSource(input, scope),
    readSourcePage: (
      input: Parameters<ProjectFoundationStore["readSourcePage"]>[0],
    ) => store.readSourcePage(input, scope),
    listSourceChapters: (
      input: Parameters<ProjectFoundationStore["listSourceChapters"]>[0],
    ) => store.listSourceChapters(input, scope),
  });
}
export async function readSqliteOwnedProjectFoundation<T>(
  context: Readonly<{ database: DatabaseSync; assertOpen(): void }>,
  call: PluginProjectReadCall,
  read: (access: CreativeProjectLegacyAccess) => T,
): Promise<T> {
  const result = await readSqliteOwnedCreativeProject(
    context.database,
    call,
    (access) => {
      const projectId = call.query.projectId!;
      access.assertProject({
        tenantId: call.query.owner.tenantId,
        spaceId: call.query.owner.spaceId,
        projectId,
      });
      return { projectId, value: read(access) };
    },
    context.assertOpen,
  );
  return result.value;
}
export async function readPostgresOwnedProjectFoundation<T>(
  context: Readonly<{ pool: Pool; schema: string; assertOpen(): void }>,
  call: PluginProjectReadCall,
  read: (
    client: PoolClient,
    access: PostgresCreativeProjectLegacyAccess,
  ) => Promise<T>,
): Promise<T> {
  const result = await readPostgresOwnedCreativeProject(
    context,
    call,
    async (client, access) => {
      const projectId = call.query.projectId!;
      await access.assertProject({
        tenantId: call.query.owner.tenantId,
        spaceId: call.query.owner.spaceId,
        projectId,
      });
      return { projectId, value: await read(client, access) };
    },
  );
  return result.value;
}
