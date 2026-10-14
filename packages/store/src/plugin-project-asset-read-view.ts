import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import {
  ApplicationError,
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
  type ProjectAssetStore,
} from "@crewon/application";
import type {
  CreativeProjectLegacyAccess,
  PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import {
  readSqliteOwnedCreativeProject,
  type PluginProjectReadCall,
} from "./plugin-project-owned-read-sqlite.ts";
import { readPostgresOwnedCreativeProject } from "./plugin-project-owned-read-postgres.ts";

export const PROJECT_ASSET_READ_METHODS = [
  "loadAsset",
  "loadRevision",
  "loadReferenceRevision",
  "listAssets",
  "listRevisions",
  "listReferences",
] as const;
export type ProjectAssetReadMethod =
  (typeof PROJECT_ASSET_READ_METHODS)[number];
type Readers = {
  [K in ProjectAssetReadMethod]: (
    input: Parameters<ProjectAssetStore[K]>[0],
    scope?: PluginProjectReadScope,
  ) => ReturnType<ProjectAssetStore[K]>;
};

/** Read-only facade of the existing asset manager. It cannot supply a writer,
 * mutation receipt, reference image verifier or execution authority.
 */
export function bindProjectAssetReadView(
  store: Readers,
  scope: PluginProjectReadScope,
): ProjectAssetStore {
  qualifyPluginProjectReadScope(scope);
  const denied = async (): Promise<never> => {
    throw new ApplicationError(
      "authorization",
      "project_asset_read_view_cannot_mutate",
    );
  };
  const view: ProjectAssetStore = {
    loadAsset: (input) => store.loadAsset(input, scope),
    loadRevision: (input) => store.loadRevision(input, scope),
    loadReferenceRevision: (input) => store.loadReferenceRevision(input, scope),
    listAssets: (input) => store.listAssets(input, scope),
    listRevisions: (input) => store.listRevisions(input, scope),
    listReferences: (input) => store.listReferences(input, scope),
    loadMutationReceipt: denied,
    commitMutation: denied,
  };
  return Object.freeze(view);
}

export async function readSqliteOwnedProjectAsset<T>(
  input: Readonly<{ database: DatabaseSync; assertOpen(): void }>,
  call: PluginProjectReadCall,
  read: (access: CreativeProjectLegacyAccess) => T,
): Promise<T> {
  const result = await readSqliteOwnedCreativeProject(
    input.database,
    call,
    (access) => ({
      projectId: call.query.projectId!,
      value: read(access),
    }),
    input.assertOpen,
  );
  return result.value;
}

export async function readPostgresOwnedProjectAsset<T>(
  input: Readonly<{ pool: Pool; schema: string; assertOpen(): void }>,
  call: PluginProjectReadCall,
  read: (
    client: PoolClient,
    access: PostgresCreativeProjectLegacyAccess,
  ) => Promise<T>,
): Promise<T> {
  const result = await readPostgresOwnedCreativeProject(
    input,
    call,
    async (client, access) => ({
      projectId: call.query.projectId!,
      value: await read(client, access),
    }),
  );
  return result.value;
}
