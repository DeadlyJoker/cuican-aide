import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import {
  ApplicationError,
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
  type ProjectStructuredOutlineStore,
} from "@crewon/application";
import {
  readSqliteOwnedCreativeProject,
  type PluginProjectReadCall,
} from "./plugin-project-owned-read-sqlite.ts";
import { readPostgresOwnedCreativeProject } from "./plugin-project-owned-read-postgres.ts";
import {
  readSqliteLegacyText,
  readPostgresLegacyText,
  textLegacyScope,
} from "./project-text-legacy-access.ts";

export const PROJECT_TEXT_READ_METHODS = [
  "loadOutline",
  "loadScript",
  "loadArtifact",
  "loadRevision",
  "loadOutlineSourceRevision",
  "listArtifacts",
  "listRevisions",
  "loadStructuredRevision",
  "listStructuredRevisions",
] as const;
export type ProjectTextReadMethod = (typeof PROJECT_TEXT_READ_METHODS)[number];
type Readers = {
  [K in ProjectTextReadMethod]: (
    input: Parameters<NonNullable<ProjectStructuredOutlineStore[K]>>[0],
    scope?: PluginProjectReadScope,
  ) => ReturnType<NonNullable<ProjectStructuredOutlineStore[K]>>;
};
/** A read-only projection of the same manager. It lends neither receipts nor mutations. */
export function bindProjectTextReadView(
  store: Readers,
  scope: PluginProjectReadScope,
): ProjectStructuredOutlineStore {
  qualifyPluginProjectReadScope(scope);
  const denied = async (): Promise<never> => {
    throw new ApplicationError(
      "authorization",
      "project_text_read_view_cannot_mutate",
    );
  };
  const view: ProjectStructuredOutlineStore = {
    loadOutline: (input) => store.loadOutline(input, scope),
    loadScript: (input) => store.loadScript(input, scope),
    loadArtifact: (input) => store.loadArtifact(input, scope),
    loadRevision: (input) => store.loadRevision(input, scope),
    loadOutlineSourceRevision: (input) =>
      store.loadOutlineSourceRevision(input, scope),
    listArtifacts: (input) => store.listArtifacts(input, scope),
    listRevisions: (input) => store.listRevisions(input, scope),
    loadStructuredRevision: (input) =>
      store.loadStructuredRevision(input, scope),
    listStructuredRevisions: (input) =>
      store.listStructuredRevisions(input, scope),
    loadMutationReceipt: denied,
    commitCandidate: denied,
    commitSelection: denied,
    commitLock: denied,
    loadStructuredMutationReceipt: denied,
    commitStructuredOutlineCandidate: denied,
    commitStructuredOutlineSelection: denied,
  };
  return Object.freeze(view);
}
/** Original query and decoder on the original transaction connection. */
export async function readSqliteOwnedProjectText<T>(
  input: Readonly<{ database: DatabaseSync; assertOpen(): void }>,
  call: PluginProjectReadCall,
  read: () => T,
): Promise<T> {
  const result = await readSqliteOwnedCreativeProject(
    input.database,
    call,
    (access) => {
      const projectId = call.query.projectId!;
      access.assertProject({
        tenantId: call.query.owner.tenantId,
        spaceId: call.query.owner.spaceId,
        projectId,
      });
      return { projectId, value: read() };
    },
    input.assertOpen,
  );
  return result.value;
}
export async function readPostgresOwnedProjectText<T>(
  input: Readonly<{ pool: Pool; schema: string; assertOpen(): void }>,
  call: PluginProjectReadCall,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const result = await readPostgresOwnedCreativeProject(
    input,
    call,
    async (client, access) => {
      const projectId = call.query.projectId!;
      await access.assertProject({
        tenantId: call.query.owner.tenantId,
        spaceId: call.query.owner.spaceId,
        projectId,
      });
      return { projectId, value: await read(client) };
    },
  );
  return result.value;
}
export function readSqliteProjectText<T>(
  context: Readonly<{ database: DatabaseSync; assertOpen(): void }>,
  query: PluginProjectReadCall["query"] & { projectId: string },
  method: ProjectTextReadMethod,
  read: () => T,
  absent: T,
  scope?: PluginProjectReadScope,
): T | Promise<T> {
  context.assertOpen();
  return scope === undefined
    ? readSqliteLegacyText(
        context.database,
        textLegacyScope(query.owner, query.projectId),
        read,
        absent,
      )
    : readSqliteOwnedProjectText(context, { scope, method, query }, read);
}
export function readPostgresProjectText<T>(
  context: Readonly<{ pool: Pool; schema: string; assertOpen(): void }>,
  query: PluginProjectReadCall["query"] & { projectId: string },
  method: ProjectTextReadMethod,
  read: (client: PoolClient) => Promise<T>,
  absent: T,
  scope?: PluginProjectReadScope,
): Promise<T> {
  return scope === undefined
    ? readPostgresLegacyText(
        context,
        textLegacyScope(query.owner, query.projectId),
        read,
        absent,
      )
    : readPostgresOwnedProjectText(context, { scope, method, query }, read);
}
