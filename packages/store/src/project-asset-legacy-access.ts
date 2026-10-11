import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { ProjectAssetMutationIdentity } from "@crewon/application";
import {
  validateCreativeProjectScope,
  type CreativeProjectScope,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import type {
  CreativeProjectLegacyAccess,
  PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";

export function assetLegacyProjectScope(
  owner: Readonly<{ tenantId: string; spaceId: string }>,
  projectId: string,
): CreativeProjectScope {
  return validateCreativeProjectScope({
    tenantId: owner.tenantId,
    spaceId: owner.spaceId,
    projectId,
  });
}

const receiptWhere =
  "tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND kind=$5 AND idempotency_key=$6";
function receiptValues(identity: ProjectAssetMutationIdentity) {
  const actor = identity.actor;
  return [
    actor.tenantId,
    actor.spaceId,
    actor.principalId,
    actor.actorId,
    identity.kind,
    identity.receipt.idempotencyKey,
  ];
}

/** Inspect the actual receipt owner before decoding, including a changed retry command. */
export function assertSqliteAssetReceiptLegacyAccess(
  db: DatabaseSync,
  access: CreativeProjectLegacyAccess,
  identity: ProjectAssetMutationIdentity,
): void {
  const row = db
    .prepare(
      `SELECT project_id FROM project_asset_mutation_receipts WHERE ${receiptWhere.replace(/\$[0-9]+/gu, "?")}`,
    )
    .get(...receiptValues(identity));
  if (row)
    access.assertProject(
      assetLegacyProjectScope(identity.actor, String(row.project_id)),
    );
}

export async function assertPostgresAssetReceiptLegacyAccess(
  client: PoolClient,
  schema: string,
  access: PostgresCreativeProjectLegacyAccess,
  identity: ProjectAssetMutationIdentity,
): Promise<void> {
  const row = (
    await client.query<{ project_id: string }>(
      `SELECT project_id FROM ${creativeProjectSchemaName(schema)}.project_asset_mutation_receipts WHERE ${receiptWhere}`,
      receiptValues(identity),
    )
  ).rows[0];
  if (row)
    await access.assertProject(
      assetLegacyProjectScope(identity.actor, row.project_id),
    );
}
