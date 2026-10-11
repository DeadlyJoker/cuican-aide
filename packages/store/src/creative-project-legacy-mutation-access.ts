import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { CreativeProjectScope } from "@crewon/domain";
import {
  assertCreativeProjectCommitTransactionCurrent,
  type CreativeProjectCommitAuthority,
} from "@crewon/application";
import { assertPostgresProjectRunLease } from "./creative-project-run-commit-postgres.ts";
import type { ProjectRunQualification } from "./creative-project-run-commit-support.ts";
import {
  creativeOwnerValues,
  type creativeMutationIdentity,
} from "./creative-project-store-records.ts";
import {
  capturePostgresCreativeProjectLegacyAccess,
  type CreativeProjectLegacyAccess,
  type PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

type Identity = ReturnType<typeof creativeMutationIdentity>;
export type PostgresCreativeProjectLegacyMutationFence = (
  client: PoolClient,
  access: PostgresCreativeProjectLegacyAccess,
) => Promise<void>;
const receiptFilter =
  "tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND kind=$5 AND idempotency_key=$6";
const receiptValues = (identity: Identity) => [
  ...creativeOwnerValues(identity.owner),
  identity.actor.actorId,
  identity.kind,
  identity.receipt.idempotencyKey,
];
const scopeOf = (project: CreativeProjectScope): CreativeProjectScope => ({
  tenantId: project.tenantId,
  spaceId: project.spaceId,
  projectId: project.projectId,
});

/** Original transaction only. An immutable receipt's real project can differ from a retry's proposed ID. */
export function assertSqliteCreativeProjectLegacyMutation(
  db: DatabaseSync,
  access: CreativeProjectLegacyAccess,
  project: CreativeProjectScope,
  identity: Identity,
): void {
  access.assertProject(scopeOf(project));
  const row = db
    .prepare(
      `SELECT tenant_id,space_id,project_id FROM creative_project_mutation_receipts WHERE ${receiptFilter.replace(/\$[1-6]/gu, "?")}`,
    )
    .get(...receiptValues(identity));
  if (row !== undefined)
    access.assertProject({
      tenantId: String(row.tenant_id),
      spaceId: String(row.space_id),
      projectId: String(row.project_id),
    });
}

export async function assertPostgresCreativeProjectLegacyMutation(
  client: PoolClient,
  schema: string,
  access: PostgresCreativeProjectLegacyAccess,
  project: CreativeProjectScope,
  identity: Identity,
): Promise<void> {
  await access.assertProject(scopeOf(project));
  const row = (
    await client.query(
      `SELECT tenant_id,space_id,project_id FROM ${creativeProjectSchemaName(schema)}.creative_project_mutation_receipts WHERE ${receiptFilter}`,
      receiptValues(identity),
    )
  ).rows[0];
  if (row !== undefined)
    await access.assertProject({
      tenantId: String(row.tenant_id),
      spaceId: String(row.space_id),
      projectId: String(row.project_id),
    });
}

export function postgresCreativeProjectLegacyMutationFence(input: {
  schema: string;
  project: CreativeProjectScope;
  identity: Identity;
}): PostgresCreativeProjectLegacyMutationFence {
  return (client, access) =>
    assertPostgresCreativeProjectLegacyMutation(
      client,
      input.schema,
      access,
      input.project,
      input.identity,
    );
}

/** Additional SQL must finish before repeating the original final policy/Run checks. */
export async function finishPostgresCreativeProjectLegacyMutation(input: {
  client: PoolClient;
  schema: string;
  assertLegacy: PostgresCreativeProjectLegacyMutationFence | undefined;
  authority: CreativeProjectCommitAuthority | undefined;
  runQualification: ProjectRunQualification | undefined;
}): Promise<void> {
  if (input.assertLegacy === undefined) return;
  await input.assertLegacy(
    input.client,
    await capturePostgresCreativeProjectLegacyAccess(
      input.client,
      input.schema,
    ),
  );
  if (input.authority !== undefined)
    await assertCreativeProjectCommitTransactionCurrent(input.authority);
  await assertPostgresProjectRunLease(
    input.client,
    input.schema,
    input.runQualification,
  );
}
