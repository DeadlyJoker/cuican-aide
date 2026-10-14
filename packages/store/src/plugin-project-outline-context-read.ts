import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { qualifyPluginProjectReadScope } from "@crewon/application";
import type { ProjectOutlineRunReadAuthority } from "@crewon/application/host-project-workspaces";
import {
  extensionCanonicalJson,
  parsePluginProjectWorkspaceOwnerScope,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import type {
  CreativeProjectLegacyAccess,
  PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import {
  assertSqliteInstalledProjectRunExecution,
  assertSqliteProjectRunLease,
} from "./creative-project-run-commit-sqlite.ts";
import {
  assertPostgresInstalledProjectRunExecution,
  assertPostgresProjectRunLease,
} from "./creative-project-run-commit-postgres.ts";
import {
  loadSqliteStageIfAvailable,
  loadPostgresStageIfAvailable,
} from "./project-stage-run-store-support.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { parseProjectOutlineToolContextRequest } from "@crewon/contracts/project-outline-tools";
import {
  assertSqlitePluginProjectWorkspaceBinding,
  assertPostgresPluginProjectWorkspaceBinding,
} from "./plugin-project-workspace-thread-fence.ts";

type Source = ReturnType<typeof qualifyPluginProjectReadScope>;
function target(source: Source) {
  const q = source.outlineRunReadAuthority;
  if (q === undefined) return null;
  const owner = parsePluginProjectWorkspaceOwnerScope({
    ...q.actor,
    profileId: q.installation.profileId,
    pluginId: q.installation.pluginId,
    publisherId: q.installation.publisherId,
  });
  if (
    source.request.action !== "crewon.project-outline-context-read.v1" ||
    source.request.input.projectId !== q.projectStageAdmission.projectId ||
    extensionCanonicalJson(source.scope) !== extensionCanonicalJson(owner)
  )
    denied();
  return {
    q,
    project: {
      tenantId: owner.tenantId,
      spaceId: owner.spaceId,
      projectId: q.projectStageAdmission.projectId,
    },
  };
}
function binding(
  q: ProjectOutlineRunReadAuthority,
  stage: ProjectStageRunAdmission | null,
  row: Record<string, unknown> | undefined,
) {
  const b = decodeConversation(row);
  if (
    !stage ||
    stage.stage.kind !== "outline" ||
    extensionCanonicalJson(stage) !==
      extensionCanonicalJson(q.projectStageAdmission) ||
    !b ||
    b.state !== "active" ||
    b.bindingId !== stage.bindingId ||
    b.threadId !== stage.threadId ||
    b.projectId !== stage.projectId ||
    b.workspaceId !== stage.workspaceId ||
    b.revision !== stage.bindingRevision ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(stage.actor) ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(stage.installation) ||
    parseProjectOutlineToolContextRequest(JSON.parse(q.commandInput))
      .projectId !== stage.projectId
  )
    denied();
  return b;
}
/** True outline_context receipt, lease and binding re-read on the original transaction. */
export function assertSqlitePluginProjectOutlineContextRead(
  db: DatabaseSync,
  source: Source,
  access: CreativeProjectLegacyAccess,
) {
  const scoped = target(source);
  if (!scoped) return;
  if (!db.isTransaction) denied();
  access.assertProject(scoped.project);
  assertSqliteInstalledProjectRunExecution(db, scoped.q);
  const stage = loadSqliteStageIfAvailable(db, {
    tenantId: scoped.q.actor.tenantId,
    runId: scoped.q.run.runId,
  });
  const b = binding(
    scoped.q,
    stage,
    stage === null
      ? undefined
      : db
          .prepare(
            "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
          )
          .get(stage.actor.tenantId, stage.actor.spaceId, stage.bindingId),
  );
  assertSqlitePluginProjectWorkspaceBinding(db, b);
  assertSqliteProjectRunLease(db, scoped.q);
}
export async function assertPostgresPluginProjectOutlineContextRead(
  c: PoolClient,
  schema: string,
  source: Source,
  access: PostgresCreativeProjectLegacyAccess,
) {
  const scoped = target(source);
  if (!scoped) return;
  await assertPostgresInstalledProjectRunExecution(c, schema, scoped.q);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-project",
      schema,
      scoped.q.actor.tenantId,
      scoped.q.actor.spaceId,
      scoped.project.projectId,
    ]),
  ]);
  const stage = await loadPostgresStageIfAvailable(c, schema, {
    tenantId: scoped.q.actor.tenantId,
    runId: scoped.q.run.runId,
  });
  const b = binding(
    scoped.q,
    stage,
    stage === null
      ? undefined
      : (
          await c.query<Record<string, unknown>>(
            `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
            [stage.actor.tenantId, stage.actor.spaceId, stage.bindingId],
          )
        ).rows[0],
  );
  await assertPostgresPluginProjectWorkspaceBinding(c, schema, b);
  await access.assertProject(scoped.project);
  await assertPostgresProjectRunLease(c, schema, scoped.q);
}
function denied(): never {
  throw new Error("plugin_project_outline_context_read_denied");
}
