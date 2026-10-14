import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  qualifyPluginProjectReadScope,
  projectOutlineRunMutation,
  type ProjectAssetCommitAuthority,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";
import { assertSqliteProjectRunCommit } from "./creative-project-run-commit-sqlite.ts";
import { assertPostgresProjectRunCommit } from "./creative-project-run-commit-postgres.ts";
import { assertPostgresInstalledProjectRunExecution } from "./creative-project-run-commit-postgres.ts";
import {
  assertSqliteProjectOutlineRunCommit,
  assertPostgresProjectOutlineRunCommit,
} from "./project-outline-run-qualification.ts";
import {
  assertSqliteProjectAssetQualification,
  assertPostgresProjectAssetQualification,
} from "./project-asset-qualification.ts";
import type {
  CreativeProjectLegacyAccess,
  PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  assertSqliteProjectAssetStageNamespace,
  assertPostgresProjectAssetStageNamespace,
} from "./project-asset-stage-tool.ts";
import {
  assertSqliteTextRunNamespace,
  assertPostgresTextRunNamespace,
} from "./project-text-run-namespace.ts";

type Source = ReturnType<typeof qualifyPluginProjectReadScope>;
function target(source: Source) {
  const q =
    source.creativeRunMutationAuthority ??
    source.outlineRunMutationAuthority ??
    source.assetRunMutationAuthority;
  if (!q) return null;
  const projectId =
    "assetStageAdmission" in q
      ? q.assetStageAdmission.projectId
      : q.projectStageAdmission?.projectId;
  const owner = parsePluginProjectWorkspaceOwnerScope({
    ...q.actor,
    profileId: q.installation.profileId,
    pluginId: q.installation.pluginId,
    publisherId: q.installation.publisherId,
  });
  if (
    !projectId ||
    !("projectId" in source.request.input) ||
    source.request.input.projectId !== projectId ||
    extensionCanonicalJson(source.scope) !== extensionCanonicalJson(owner)
  )
    throw new Error("plugin_project_run_dependency_target_mismatch");
  return { tenantId: owner.tenantId, spaceId: owner.spaceId, projectId };
}
function assetAuthority(source: Source): ProjectAssetCommitAuthority {
  return {
    runTransaction: source.assetRunMutationAuthority!,
    assertCurrent: source.assertCurrent,
    assertTransactionCurrent: source.assertCurrent,
    assertActive: source.assertActive,
  };
}
/** Original Tool/Run/stage/physical-lease qualifications, on the same committing snapshot. */
export function assertSqliteProjectRunMutationRead(
  db: DatabaseSync,
  source: Source,
  access: CreativeProjectLegacyAccess,
) {
  const scope = target(source);
  if (!scope) return;
  if (source.assetRunMutationAuthority)
    assertSqliteProjectAssetStageNamespace(
      db,
      source.assetRunMutationAuthority.assetStageAdmission,
    );
  access.assertProject(scope);
  const stage =
    source.creativeRunMutationAuthority?.projectStageAdmission ??
    source.outlineRunMutationAuthority?.projectStageAdmission;
  if (stage) assertSqliteTextRunNamespace(db, stage);
  if (source.creativeRunMutationAuthority)
    assertSqliteProjectRunCommit(db, source.creativeRunMutationAuthority);
  if (source.outlineRunMutationAuthority) {
    const q = source.outlineRunMutationAuthority;
    assertSqliteProjectOutlineRunCommit(
      db,
      { ...q, ...projectOutlineRunMutation(q, creativeStoreDigester) },
      "receipt-publication",
      { projectAccess: access },
    );
  }
  if (source.assetRunMutationAuthority)
    assertSqliteProjectAssetQualification(db, assetAuthority(source), {
      projectAccess: access,
    });
}
export async function assertPostgresProjectRunMutationRead(
  c: PoolClient,
  schema: string,
  source: Source,
  access: PostgresCreativeProjectLegacyAccess,
) {
  const scope = target(source);
  if (!scope) return;
  const execution =
    source.creativeRunMutationAuthority ??
    source.outlineRunMutationAuthority ??
    source.assetRunMutationAuthority;
  if (execution)
    await assertPostgresInstalledProjectRunExecution(c, schema, execution);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-project",
      schema,
      scope.tenantId,
      scope.spaceId,
      scope.projectId,
    ]),
  ]);
  const stage =
    source.creativeRunMutationAuthority?.projectStageAdmission ??
    source.outlineRunMutationAuthority?.projectStageAdmission;
  if (stage) await assertPostgresTextRunNamespace(c, schema, stage);
  if (source.assetRunMutationAuthority)
    await assertPostgresProjectAssetStageNamespace(
      c,
      schema,
      source.assetRunMutationAuthority.assetStageAdmission,
    );
  await access.assertProject(scope);
  if (source.creativeRunMutationAuthority)
    await assertPostgresProjectRunCommit(
      c,
      schema,
      source.creativeRunMutationAuthority,
    );
  if (source.outlineRunMutationAuthority) {
    const q = source.outlineRunMutationAuthority;
    await assertPostgresProjectOutlineRunCommit(
      c,
      schema,
      { ...q, ...projectOutlineRunMutation(q, creativeStoreDigester) },
      "receipt-publication",
      { projectAccess: access },
    );
  }
  if (source.assetRunMutationAuthority)
    await assertPostgresProjectAssetQualification(
      c,
      schema,
      assetAuthority(source),
      { projectAccess: access },
    );
}
