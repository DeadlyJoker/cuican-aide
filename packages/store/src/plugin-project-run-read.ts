import { ApplicationError } from "@crewon/application";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { CreativeProjectRunReadAuthority } from "@crewon/application/host-project-workspaces";
import {
  extensionCanonicalJson,
  assertProjectStageToolRequest,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
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

function check(
  q: CreativeProjectRunReadAuthority,
  stage: ProjectStageRunAdmission | null,
  row: Record<string, unknown> | undefined,
) {
  const binding = decodeConversation(row);
  if (
    stage === null ||
    q.projectStageAdmission === undefined ||
    extensionCanonicalJson(stage) !==
      extensionCanonicalJson(q.projectStageAdmission) ||
    binding === null ||
    binding.state !== "active" ||
    binding.bindingId !== stage.bindingId ||
    binding.threadId !== stage.threadId ||
    binding.projectId !== stage.projectId ||
    binding.workspaceId !== stage.workspaceId ||
    binding.revision !== stage.bindingRevision ||
    extensionCanonicalJson(binding.owner) !==
      extensionCanonicalJson(stage.actor) ||
    extensionCanonicalJson(binding.currentInstallation) !==
      extensionCanonicalJson(stage.installation)
  )
    throw new Error("plugin_project_run_read_stage_mismatch");
  assertProjectStageToolRequest(
    stage,
    q.operationId,
    JSON.parse(q.commandInput),
  );
}
/** Caller owns the original transaction. No extra connection or read-to-write conversion. */
export function assertSqlitePluginProjectRunRead(
  db: DatabaseSync,
  q: CreativeProjectRunReadAuthority | undefined,
): void {
  if (q === undefined) return;
  try {
    if (!db.isTransaction)
      throw new Error("plugin_project_run_read_transaction_required");
    assertSqliteInstalledProjectRunExecution(db, q);
    assertSqliteProjectRunLease(db, q);
    const stage = loadSqliteStageIfAvailable(db, {
      tenantId: q.actor.tenantId,
      runId: q.run.runId,
    });
    check(
      q,
      stage,
      stage === null
        ? undefined
        : db
            .prepare(
              "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
            )
            .get(stage.actor.tenantId, stage.actor.spaceId, stage.bindingId),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "creative_project_run_commit_not_current"
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_run_read_not_current",
        { cause: error },
      );
    throw error;
  }
}
export async function assertPostgresPluginProjectRunRead(
  client: PoolClient,
  schema: string,
  q: CreativeProjectRunReadAuthority | undefined,
): Promise<void> {
  if (q === undefined) return;
  try {
    await assertPostgresInstalledProjectRunExecution(client, schema, q);
    await assertPostgresProjectRunLease(client, schema, q);
    const stage = await loadPostgresStageIfAvailable(client, schema, {
      tenantId: q.actor.tenantId,
      runId: q.run.runId,
    });
    check(
      q,
      stage,
      stage === null
        ? undefined
        : (
            await client.query<Record<string, unknown>>(
              `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
              [stage.actor.tenantId, stage.actor.spaceId, stage.bindingId],
            )
          ).rows[0],
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "creative_project_run_commit_not_current"
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_run_read_not_current",
        { cause: error },
      );
    throw error;
  }
}
