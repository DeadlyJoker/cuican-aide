import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  captureCreativeProjectRunCommitTransaction,
  captureProjectOutlineRunCommitTransaction,
  type CreativeProjectCommitAuthority,
} from "@crewon/application";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import {
  assertSqliteInstalledProjectRunExecution,
  assertSqliteProjectRunLease,
} from "./creative-project-run-commit-sqlite.ts";
import {
  assertPostgresInstalledProjectRunExecution,
  assertPostgresProjectRunLease,
} from "./creative-project-run-commit-postgres.ts";
import {
  assertSqlitePluginProjectWorkspaceMetadata,
  assertPostgresPluginProjectWorkspaceMetadata,
} from "./plugin-project-workspace-metadata-fence.ts";
import { captureSqliteOwnedProjectAccess } from "./plugin-project-owned-read-sqlite.ts";
import { capturePostgresOwnedProjectAccess } from "./plugin-project-owned-read-postgres.ts";
import {
  assertSqliteTextRunNamespace,
  assertPostgresTextRunNamespace,
} from "./project-text-run-namespace.ts";

function source(authority: CreativeProjectCommitAuthority | undefined) {
  const raw = authority?.runTransaction ?? authority?.outlineRunTransaction;
  if (!raw) return null;
  const q =
    raw.version === "crewon.project-outline-run-commit.v2"
      ? captureProjectOutlineRunCommitTransaction(raw)
      : captureCreativeProjectRunCommitTransaction(raw);
  if (!q.projectStageAdmission) return null;
  const projectId = q.projectStageAdmission.projectId;
  if (
    (JSON.parse(q.commandInput) as Record<string, unknown>).projectId !==
    projectId
  )
    denied();
  return {
    q,
    owner: parsePluginProjectWorkspaceOwner({
      ...q.actor,
      profileId: q.installation.profileId,
      pluginId: q.installation.pluginId,
      publisherId: q.installation.publisherId,
      projectId,
    }),
  };
}
/** Only a genuine currently installed Tool/Run may select this positive original-transaction path. */
export function captureSqliteTextRunProjectAccess(
  db: DatabaseSync,
  authority: CreativeProjectCommitAuthority | undefined,
) {
  const value = source(authority);
  if (!value) return undefined;
  const { q, owner } = value;
  assertSqliteInstalledProjectRunExecution(db, q);
  assertSqliteProjectRunLease(db, q);
  if (assertSqlitePluginProjectWorkspaceMetadata(db, owner) !== "protected")
    return undefined;
  assertSqliteTextRunNamespace(db, q.projectStageAdmission!);
  const access = captureSqliteOwnedProjectAccess(db, { scope: owner });
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
export async function capturePostgresTextRunProjectAccess(
  c: PoolClient,
  schema: string,
  authority: CreativeProjectCommitAuthority | undefined,
) {
  const value = source(authority);
  if (!value) return undefined;
  const { q, owner } = value;
  await assertPostgresInstalledProjectRunExecution(c, schema, q);
  await assertPostgresProjectRunLease(c, schema, q);
  if (
    (await assertPostgresPluginProjectWorkspaceMetadata(c, schema, owner)) !==
    "protected"
  )
    return undefined;
  await assertPostgresTextRunNamespace(c, schema, q.projectStageAdmission!);
  const access = await capturePostgresOwnedProjectAccess(c, schema, {
    scope: owner,
  });
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
  throw new Error("plugin_project_text_run_target_mismatch");
}
