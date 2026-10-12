import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  pluginTaskReceiptKey,
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
  type ProjectConversationCommitAuthority,
} from "@crewon/application";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS } from "@crewon/contracts/project-conversations";
import {
  extensionCanonicalJson,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import { captureSqliteOwnedProjectAccess } from "./plugin-project-owned-read-sqlite.ts";
import { capturePostgresOwnedProjectAccess } from "./plugin-project-owned-read-postgres.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
function source(
  scope: PluginProjectReadScope,
  stage: ProjectStageRunAdmission,
  authority: ProjectConversationCommitAuthority,
) {
  const s = qualifyPluginProjectReadScope(scope);
  if (
    s.purpose !== "read" ||
    s.request.action !== PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage ||
    !s.methods.includes("loadFoundation") ||
    s.runAuthority !== undefined ||
    s.foundationRunAuthority !== undefined
  )
    throw new Error("project_foundation_stage_read_scope_invalid");
  const r = s.request.input;
  if (
    r.projectId !== stage.projectId ||
    r.threadId !== stage.threadId ||
    r.expectedBindingRevision !== stage.bindingRevision ||
    pluginTaskReceiptKey(
      {
        actor: authority.actor,
        profileId: authority.installation.profileId,
        pluginId: authority.installation.pluginId,
        idempotencyKey: r.idempotencyKey,
      },
      creativeStoreDigester,
    ) !== stage.idempotencyKey ||
    extensionCanonicalJson(r.stage) !== extensionCanonicalJson(stage.stage) ||
    creativeStoreDigester.sha256(r.content) !== stage.userContentDigest ||
    extensionCanonicalJson(s.snapshot.pin) !==
      extensionCanonicalJson(authority.pin) ||
    extensionCanonicalJson(s.snapshot.context.selection) !==
      extensionCanonicalJson(authority.selection) ||
    extensionCanonicalJson(s.snapshot.context.package) !==
      extensionCanonicalJson(authority.package)
  )
    throw new Error("project_foundation_stage_read_scope_mismatch");
  s.assertActive();
  return s;
}
export function sqliteFoundationStageReadAccess(
  db: DatabaseSync,
  input: Readonly<{
    scope: PluginProjectReadScope;
    stage: ProjectStageRunAdmission;
    authority: ProjectConversationCommitAuthority;
  }>,
) {
  return {
    projectAccess: captureSqliteOwnedProjectAccess(
      db,
      source(input.scope, input.stage, input.authority),
    ),
  };
}
export async function postgresFoundationStageReadAccess(
  client: PoolClient,
  schema: string,
  input: Readonly<{
    scope: PluginProjectReadScope;
    stage: ProjectStageRunAdmission;
    authority: ProjectConversationCommitAuthority;
  }>,
) {
  return {
    projectAccess: await capturePostgresOwnedProjectAccess(
      client,
      schema,
      source(input.scope, input.stage, input.authority),
    ),
  };
}
