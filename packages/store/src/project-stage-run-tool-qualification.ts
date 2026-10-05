import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { projectToolRunMutationCommand } from "@crewon/application";
import {
  assertProjectStageToolRequest,
  extensionCanonicalJson,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  conversationFail,
  decodeConversation,
} from "./project-conversation-store-support.ts";
import {
  loadSqliteStageIfAvailable,
  loadPostgresStageIfAvailable,
} from "./project-stage-run-store-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import type { ProjectRunQualification } from "./creative-project-run-commit-support.ts";

function assertStage(
  q: ProjectRunQualification,
  s: ProjectStageRunAdmission | null,
  row: Record<string, unknown> | undefined,
): void {
  const requested = q.projectStageAdmission;
  if (s === null && requested === undefined) return;
  if (
    s === null ||
    requested === undefined ||
    extensionCanonicalJson(s) !== extensionCanonicalJson(requested) ||
    s.runId !== q.run.runId ||
    s.threadId !== q.run.threadId ||
    extensionCanonicalJson(s.actor) !== extensionCanonicalJson(q.actor) ||
    extensionCanonicalJson(s.installation) !==
      extensionCanonicalJson(q.installation) ||
    s.pluginTaskAdmissionDigest !==
      creativeStoreDigester.sha256(extensionCanonicalJson(q.admission)) ||
    s.extensionBindingDigest !== q.admission.extensionBindingDigest
  )
    conversationFail("project_stage_tool_qualification_denied");
  const b = decodeConversation(row);
  if (
    b === null ||
    b.state !== "active" ||
    b.bindingId !== s.bindingId ||
    b.threadId !== s.threadId ||
    b.projectId !== s.projectId ||
    b.workspaceId !== s.workspaceId ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(s.actor) ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(s.installation)
  )
    conversationFail("project_stage_tool_qualification_denied");
  const command = projectToolRunMutationCommand(
    q,
    creativeStoreDigester,
  ).command;
  assertProjectStageToolRequest(
    s,
    q.operationId,
    command as unknown as Readonly<Record<string, unknown>>,
  );
}
/** Same current Run/Tool/claim transaction: legacy Runs never receive an inferred stage scope. */
export function assertSqliteProjectStageTool(
  db: DatabaseSync,
  q: ProjectRunQualification,
): void {
  const s = loadSqliteStageIfAvailable(db, {
    tenantId: q.actor.tenantId,
    runId: q.run.runId,
  });
  assertStage(
    q,
    s,
    s === null
      ? undefined
      : db
          .prepare(
            "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
          )
          .get(s.actor.tenantId, s.actor.spaceId, s.bindingId),
  );
}
export async function assertPostgresProjectStageTool(
  c: PoolClient,
  schema: string,
  q: ProjectRunQualification,
): Promise<void> {
  const s = await loadPostgresStageIfAvailable(c, schema, {
    tenantId: q.actor.tenantId,
    runId: q.run.runId,
  });
  assertStage(
    q,
    s,
    s === null
      ? undefined
      : (
          await c.query<Record<string, unknown>>(
            `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
            [s.actor.tenantId, s.actor.spaceId, s.bindingId],
          )
        ).rows[0],
  );
}
