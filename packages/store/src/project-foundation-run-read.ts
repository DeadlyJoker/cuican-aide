import type {
  CreativeProjectLegacyAccess,
  PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  ApplicationError,
  captureProjectFoundationRunReadAuthority,
  type ProjectFoundationRunReadAuthority,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  assertProjectFoundationRunFoundation,
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
import {
  loadSqliteFoundationRun,
  loadPostgresFoundationRun,
} from "./project-foundation-run-store.ts";
import {
  captureSqliteFoundationRunFacts,
  capturePostgresFoundationRunFacts,
} from "./project-foundation-run-facts.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
function same(actual: unknown, expected: unknown) {
  if (extensionCanonicalJson(actual) !== extensionCanonicalJson(expected))
    throw new ApplicationError(
      "authorization",
      "project_foundation_run_read_facts_mismatch",
    );
}
/** Original caller-owned SQL transaction only. This check lends no project/Store read scope. */
export function assertSqliteFoundationRunRead(
  db: DatabaseSync,
  input: ProjectFoundationRunReadAuthority,
  options?: Readonly<{ projectAccess: CreativeProjectLegacyAccess }>,
): void {
  if (!db.isTransaction)
    throw new Error("project_foundation_run_read_transaction_required");
  const q = captureProjectFoundationRunReadAuthority(input);
  assertSqliteInstalledProjectRunExecution(db, q);
  same(
    loadSqliteStageIfAvailable(db, {
      tenantId: q.actor.tenantId,
      runId: q.run.runId,
    }),
    q.projectStageAdmission,
  );
  same(
    loadSqliteFoundationRun(
      db,
      {
        tenantId: q.actor.tenantId,
        spaceId: q.actor.spaceId,
        runId: q.run.runId,
      },
      options,
    ),
    q.foundationAdmission,
  );
  const facts = captureSqliteFoundationRunFacts(
    db,
    q.projectStageAdmission,
    false,
    options,
  );
  if (facts === null)
    throw new ApplicationError(
      "authorization",
      "project_foundation_run_read_facts_missing",
    );
  assertProjectFoundationRunFoundation(
    q.foundationAdmission,
    facts.foundation,
    creativeStoreDigester,
  );
  assertSqliteProjectRunLease(db, q);
}
export async function assertPostgresFoundationRunRead(
  client: PoolClient,
  schema: string,
  input: ProjectFoundationRunReadAuthority,
  options?: Readonly<{ projectAccess: PostgresCreativeProjectLegacyAccess }>,
): Promise<void> {
  const q = captureProjectFoundationRunReadAuthority(input);
  await assertPostgresInstalledProjectRunExecution(client, schema, q);
  same(
    await loadPostgresStageIfAvailable(client, schema, {
      tenantId: q.actor.tenantId,
      runId: q.run.runId,
    }),
    q.projectStageAdmission,
  );
  same(
    await loadPostgresFoundationRun(
      client,
      schema,
      {
        tenantId: q.actor.tenantId,
        spaceId: q.actor.spaceId,
        runId: q.run.runId,
      },
      options,
    ),
    q.foundationAdmission,
  );
  const facts = await capturePostgresFoundationRunFacts(
    client,
    schema,
    q.projectStageAdmission,
    false,
    options,
  );
  if (facts === null)
    throw new ApplicationError(
      "authorization",
      "project_foundation_run_read_facts_missing",
    );
  assertProjectFoundationRunFoundation(
    q.foundationAdmission,
    facts.foundation,
    creativeStoreDigester,
  );
  // Physical lease time is checked after all awaited reads on this same connection.
  await assertPostgresProjectRunLease(client, schema, q);
}
