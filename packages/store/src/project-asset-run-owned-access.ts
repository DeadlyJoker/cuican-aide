import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  captureProjectAssetRunCommitTransaction,
  type ProjectAssetRunCommitTransactionAuthority,
} from "@crewon/application";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import { assertSqliteInstalledProjectRunExecution } from "./creative-project-run-commit-sqlite.ts";
import { assertPostgresInstalledProjectRunExecution } from "./creative-project-run-commit-postgres.ts";
import {
  assertSqlitePluginProjectWorkspaceMetadata,
  assertPostgresPluginProjectWorkspaceMetadata,
} from "./plugin-project-workspace-metadata-fence.ts";
import {
  assertSqliteProjectAssetQualification,
  assertPostgresProjectAssetQualification,
} from "./project-asset-qualification.ts";
import { captureSqliteOwnedProjectAccess } from "./plugin-project-owned-read-sqlite.ts";
import { capturePostgresOwnedProjectAccess } from "./plugin-project-owned-read-postgres.ts";
import {
  assertSqlitePluginProjectWorkspaceBinding,
  assertPostgresPluginProjectWorkspaceBinding,
} from "./plugin-project-workspace-thread-fence.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

function source(input: ProjectAssetRunCommitTransactionAuthority) {
  const q = captureProjectAssetRunCommitTransaction(input);
  const owner = parsePluginProjectWorkspaceOwner({
    ...q.actor,
    profileId: q.installation.profileId,
    pluginId: q.installation.pluginId,
    publisherId: q.installation.publisherId,
    projectId: q.assetStageAdmission.projectId,
  });
  return { q, owner };
}

/** Original borrowed transaction only, after actual installed Run and independent
 * asset Stage/Tool evidence. Protected projects retain their workspace namespace
 * fence; ordinary projects retain the unchanged legacy route.
 */
export function captureSqliteAssetRunOwnedAccess(
  db: DatabaseSync,
  input: ProjectAssetRunCommitTransactionAuthority | undefined,
) {
  if (input === undefined) return undefined;
  const { q, owner } = source(input);
  assertSqliteInstalledProjectRunExecution(db, q);
  if (assertSqlitePluginProjectWorkspaceMetadata(db, owner) !== "protected") {
    assertSqliteProjectAssetQualification(db, { runTransaction: q });
    return undefined;
  }
  const binding = decodeConversation(
    db
      .prepare(
        "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
      )
      .get(q.actor.tenantId, q.actor.spaceId, q.assetStageAdmission.bindingId),
  );
  if (!binding) denied();
  assertSqlitePluginProjectWorkspaceBinding(db, binding);
  const access = captureSqliteOwnedProjectAccess(db, { scope: owner });
  access.assertProject(owner);
  assertSqliteProjectAssetQualification(
    db,
    { runTransaction: q },
    { projectAccess: access },
  );
  return Object.freeze({
    predicate: access.predicate,
    assertProject(scope: Parameters<typeof access.assertProject>[0]) {
      if (
        scope.tenantId !== owner.tenantId ||
        scope.spaceId !== owner.spaceId ||
        scope.projectId !== owner.projectId
      )
        denied();
      access.assertProject(scope);
    },
  });
}

export async function capturePostgresAssetRunOwnedAccess(
  c: PoolClient,
  schema: string,
  input: ProjectAssetRunCommitTransactionAuthority | undefined,
) {
  if (input === undefined) return undefined;
  const { q, owner } = source(input);
  await assertPostgresInstalledProjectRunExecution(c, schema, q);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-project",
      schema,
      q.actor.tenantId,
      q.actor.spaceId,
      q.assetStageAdmission.projectId,
    ]),
  ]);
  if (
    (await assertPostgresPluginProjectWorkspaceMetadata(c, schema, owner)) !==
    "protected"
  ) {
    await assertPostgresProjectAssetQualification(c, schema, {
      runTransaction: q,
    });
    return undefined;
  }
  const binding = decodeConversation(
    (
      await c.query(
        `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
        [q.actor.tenantId, q.actor.spaceId, q.assetStageAdmission.bindingId],
      )
    ).rows[0],
  );
  if (!binding) denied();
  await assertPostgresPluginProjectWorkspaceBinding(c, schema, binding);
  const access = await capturePostgresOwnedProjectAccess(c, schema, {
    scope: owner,
  });
  await access.assertProject(owner);
  await assertPostgresProjectAssetQualification(
    c,
    schema,
    { runTransaction: q },
    { projectAccess: access },
  );
  return Object.freeze({
    predicate: access.predicate,
    async assertProject(
      scope: Parameters<typeof access.assertProject>[0] & {
        tenantId: string;
        spaceId: string;
      },
    ) {
      if (
        scope.tenantId !== owner.tenantId ||
        scope.spaceId !== owner.spaceId ||
        scope.projectId !== owner.projectId
      )
        denied();
      await access.assertProject(scope);
    },
  });
}

function denied(): never {
  throw new Error("plugin_project_asset_run_namespace_mismatch");
}
