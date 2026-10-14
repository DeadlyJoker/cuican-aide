import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  extensionCanonicalJson,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import { decodeConversation } from "./project-conversation-store-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertSqlitePluginProjectWorkspaceBinding,
  assertPostgresPluginProjectWorkspaceBinding,
} from "./plugin-project-workspace-thread-fence.ts";

function binding(
  stage: ProjectStageRunAdmission,
  row: Record<string, unknown> | undefined,
) {
  const b = decodeConversation(row);
  if (
    !b ||
    b.state !== "active" ||
    b.bindingId !== stage.bindingId ||
    b.threadId !== stage.threadId ||
    b.projectId !== stage.projectId ||
    b.revision !== stage.bindingRevision ||
    b.workspaceId !== stage.workspaceId ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(stage.actor) ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(stage.installation)
  )
    throw new Error("project_text_run_namespace_binding_mismatch");
  return b;
}
/** Original current binding and namespace, on caller's real Run-qualified transaction. */
export function assertSqliteTextRunNamespace(
  db: DatabaseSync,
  stage: ProjectStageRunAdmission,
) {
  const b = binding(
    stage,
    db
      .prepare(
        "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
      )
      .get(stage.actor.tenantId, stage.actor.spaceId, stage.bindingId),
  );
  assertSqlitePluginProjectWorkspaceBinding(db, b);
}
export async function assertPostgresTextRunNamespace(
  c: PoolClient,
  schema: string,
  stage: ProjectStageRunAdmission,
) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-project",
      schema,
      stage.actor.tenantId,
      stage.actor.spaceId,
      stage.projectId,
    ]),
  ]);
  const b = binding(
    stage,
    (
      await c.query<Record<string, unknown>>(
        `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
        [stage.actor.tenantId, stage.actor.spaceId, stage.bindingId],
      )
    ).rows[0],
  );
  await assertPostgresPluginProjectWorkspaceBinding(c, schema, b);
}
