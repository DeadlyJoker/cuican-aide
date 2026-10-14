import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  captureProjectFoundationRunCommitTransaction,
  type ProjectFoundationRunCommitTransactionAuthority,
} from "@crewon/application";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import { assertSqliteInstalledProjectRunExecution } from "./creative-project-run-commit-sqlite.ts";
import { assertPostgresInstalledProjectRunExecution } from "./creative-project-run-commit-postgres.ts";
import {
  assertSqlitePluginProjectWorkspaceMetadata,
  assertPostgresPluginProjectWorkspaceMetadata,
} from "./plugin-project-workspace-metadata-fence.ts";
import { captureSqliteOwnedProjectAccess } from "./plugin-project-owned-read-sqlite.ts";
import { capturePostgresOwnedProjectAccess } from "./plugin-project-owned-read-postgres.ts";
function source(input: ProjectFoundationRunCommitTransactionAuthority) {
  const q = captureProjectFoundationRunCommitTransaction(input);
  return {
    q,
    owner: parsePluginProjectWorkspaceOwner({
      ...q.actor,
      profileId: q.installation.profileId,
      pluginId: q.installation.pluginId,
      publisherId: q.installation.publisherId,
      projectId: q.foundationAdmission.projectId,
    }),
  };
}
/** Borrowed original transaction only. Actual installed Run/Tool evidence precedes any positive project access. */
export function captureSqliteFoundationRunOwnedAccess(
  db: DatabaseSync,
  input: ProjectFoundationRunCommitTransactionAuthority | undefined,
) {
  if (input === undefined) return undefined;
  const { q, owner } = source(input);
  assertSqliteInstalledProjectRunExecution(db, q);
  if (assertSqlitePluginProjectWorkspaceMetadata(db, owner) !== "protected")
    return undefined;
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
export async function capturePostgresFoundationRunOwnedAccess(
  c: PoolClient,
  schema: string,
  input: ProjectFoundationRunCommitTransactionAuthority | undefined,
) {
  if (input === undefined) return undefined;
  const { q, owner } = source(input);
  await assertPostgresInstalledProjectRunExecution(c, schema, q);
  if (
    (await assertPostgresPluginProjectWorkspaceMetadata(c, schema, owner)) !==
    "protected"
  )
    return undefined;
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
  throw new Error("plugin_project_foundation_run_target_mismatch");
}
