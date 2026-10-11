import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { RunStoreError, type CommitThreadInput } from "@crewon/application";
import {
  normalizeThreadWorkspaceId,
  type ProjectConversationBinding,
  type PluginProjectWorkspaceNamespace,
  type ThreadState,
} from "@crewon/domain";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import {
  hasSqlitePluginProjectWorkspaceSchema,
  hasPostgresPluginProjectWorkspaceSchema,
  PLUGIN_PROJECT_WORKSPACE_TABLE as table,
} from "./plugin-project-workspace-schema.ts";
import {
  decodeNamespace,
  pluginProjectWorkspaceLock,
} from "./plugin-project-workspace-store-support.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";

/** Internal transaction qualification. No public Thread input can construct or carry it. */
export type ProjectWorkspaceThreadQualification = Readonly<
  Record<never, never>
>;
const qualifications = new WeakMap<object, ProjectConversationBinding>();
/** Called only after the original Conversation Store has captured and checked its real commit authority. */
export function qualifyProjectWorkspaceConversationThread(
  binding: ProjectConversationBinding,
): ProjectWorkspaceThreadQualification {
  const value = Object.freeze(Object.create(null) as object);
  qualifications.set(value, binding);
  return value;
}
function bindingFor(
  input: ProjectWorkspaceThreadQualification | undefined,
): ProjectConversationBinding | undefined {
  if (input === undefined) return undefined;
  const binding =
    input !== null && typeof input === "object"
      ? qualifications.get(input)
      : undefined;
  if (binding === undefined) denied();
  return binding;
}
function denied(): never {
  throw new RunStoreError("plugin_project_workspace_scope_conflict");
}
function assertBinding(
  namespace: PluginProjectWorkspaceNamespace,
  b: ProjectConversationBinding,
): void {
  const o = namespace.owner,
    i = b.currentInstallation;
  if (
    b.workspaceId !== namespace.workspaceId ||
    b.projectId !== o.projectId ||
    b.profileId !== o.profileId ||
    b.owner.tenantId !== o.tenantId ||
    b.owner.spaceId !== o.spaceId ||
    b.owner.principalId !== o.principalId ||
    b.owner.actorId !== o.actorId ||
    i.profileId !== o.profileId ||
    i.pluginId !== o.pluginId ||
    i.publisherId !== o.publisherId ||
    i.tenantId !== o.tenantId ||
    i.spaceId !== o.spaceId
  )
    denied();
}
function assertCreation(
  namespace: PluginProjectWorkspaceNamespace,
  input: CommitThreadInput,
  qualification: ProjectWorkspaceThreadQualification | undefined,
  state?: ThreadState,
): void {
  const b = bindingFor(qualification),
    event = input.events[0];
  if (
    b === undefined ||
    input.sourceFence !== undefined ||
    input.expectedRevision !== 0 ||
    event?.type !== "thread.created" ||
    input.events.length !== 1 ||
    input.messages.length !== 0 ||
    input.history.items.length !== 0 ||
    input.officeBinding !== undefined ||
    input.tombstone !== undefined ||
    event.identity.threadId !== b.threadId ||
    event.data.createdByActorId !== b.owner.actorId ||
    event.data.tenantId !== b.owner.tenantId ||
    event.data.spaceId !== b.owner.spaceId ||
    (state !== undefined &&
      (state.threadId !== b.threadId || state.workspaceId !== b.workspaceId))
  )
    denied();
  assertBinding(namespace, b);
}
function creationWorkspace(
  input: CommitThreadInput,
  state?: ThreadState,
): string | null {
  if (input.expectedRevision !== 0) return null;
  const event = input.events[0];
  return state === undefined
    ? event?.type === "thread.created"
      ? normalizeThreadWorkspaceId(event.data.workspaceId)
      : null
    : normalizeThreadWorkspaceId(state.workspaceId);
}
export function assertSqlitePluginProjectWorkspaceThread(
  db: DatabaseSync,
  input: CommitThreadInput,
  qualification?: ProjectWorkspaceThreadQualification,
  state?: ThreadState,
): void {
  bindingFor(qualification);
  const workspaceId = creationWorkspace(input, state);
  if (input.expectedRevision !== 0 && input.sourceFence === undefined) return;
  if (workspaceId === null && input.sourceFence === undefined) return;
  if (!hasSqlitePluginProjectWorkspaceSchema(db)) return;
  if (input.sourceFence !== undefined) {
    const row = db
      .prepare(
        "SELECT state_json FROM threads WHERE tenant_id=? AND thread_id=?",
      )
      .get(input.tenantId, input.sourceFence.threadId);
    if (row) {
      const source = JSON.parse(row.state_json as string) as ThreadState;
      const sourceWorkspace = normalizeThreadWorkspaceId(source.workspaceId);
      if (
        sourceWorkspace !== null &&
        db
          .prepare(`SELECT 1 FROM ${table} WHERE workspace_id=?`)
          .get(sourceWorkspace)
      )
        denied();
    }
  }
  if (workspaceId === null) return;
  const namespace = decodeNamespace(
    db.prepare(`SELECT * FROM ${table} WHERE workspace_id=?`).get(workspaceId),
  );
  if (namespace !== null)
    assertCreation(namespace, input, qualification, state);
}
export function assertSqlitePluginProjectWorkspaceBinding(
  db: DatabaseSync,
  b: ProjectConversationBinding,
): void {
  if (b.workspaceId === null || !hasSqlitePluginProjectWorkspaceSchema(db))
    return;
  const namespace = decodeNamespace(
    db
      .prepare(`SELECT * FROM ${table} WHERE workspace_id=?`)
      .get(b.workspaceId),
  );
  if (namespace !== null) assertBinding(namespace, b);
}
export async function assertPostgresPluginProjectWorkspaceThread(
  c: PoolClient,
  schema: string,
  input: CommitThreadInput,
  qualification?: ProjectWorkspaceThreadQualification,
  state?: ThreadState,
): Promise<void> {
  bindingFor(qualification);
  if (input.expectedRevision !== 0 && input.sourceFence === undefined) return;
  const p = `${pluginInstallationSchemaName(schema)}.`,
    workspaceId = creationWorkspace(input, state);
  let sourceWorkspace: string | null = null;
  if (input.sourceFence !== undefined) {
    const row = (
      await c.query<{ state_json: ThreadState }>(
        `SELECT state_json FROM ${p}threads WHERE tenant_id=$1 AND thread_id=$2`,
        [input.tenantId, input.sourceFence.threadId],
      )
    ).rows[0];
    sourceWorkspace =
      row === undefined
        ? null
        : normalizeThreadWorkspaceId(row.state_json.workspaceId);
  }
  if (workspaceId === null && sourceWorkspace === null) return;
  for (const id of [
    ...new Set(
      [workspaceId, sourceWorkspace].filter((id): id is string => id !== null),
    ),
  ].sort())
    await advisoryLock(c, pluginProjectWorkspaceLock(id));
  if (!(await hasPostgresPluginProjectWorkspaceSchema(c, schema))) return;
  if (
    sourceWorkspace !== null &&
    (
      await c.query(`SELECT 1 FROM ${p}${table} WHERE workspace_id=$1`, [
        sourceWorkspace,
      ])
    ).rows.length
  )
    denied();
  if (workspaceId === null) return;
  const namespace = decodeNamespace(
    (
      await c.query(`SELECT * FROM ${p}${table} WHERE workspace_id=$1`, [
        workspaceId,
      ])
    ).rows[0],
  );
  if (namespace !== null)
    assertCreation(namespace, input, qualification, state);
}
export async function assertPostgresPluginProjectWorkspaceBinding(
  c: PoolClient,
  schema: string,
  b: ProjectConversationBinding,
): Promise<void> {
  if (b.workspaceId === null) return;
  await advisoryLock(c, pluginProjectWorkspaceLock(b.workspaceId));
  if (!(await hasPostgresPluginProjectWorkspaceSchema(c, schema))) return;
  const namespace = decodeNamespace(
    (
      await c.query(
        `SELECT * FROM ${pluginInstallationSchemaName(schema)}.${table} WHERE workspace_id=$1`,
        [b.workspaceId],
      )
    ).rows[0],
  );
  if (namespace !== null) assertBinding(namespace, b);
}
