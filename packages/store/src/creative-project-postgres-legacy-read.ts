import type { Pool, PoolClient } from "pg";
import {
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
  type PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  creativeOwnerValues,
  decodeCreativeReceipt,
  type creativeMutationIdentity,
} from "./creative-project-store-records.ts";

export type PostgresCreativeProjectLegacyRead<T> = (
  client: PoolClient,
  access: PostgresCreativeProjectLegacyAccess,
) => Promise<T>;

/** Filter the actual receipt parent while preserving corruption detection for orphan legacy rows. */
export async function readPostgresLegacyCreativeProjectReceipt(input: {
  client: PoolClient;
  schema: string;
  identity: ReturnType<typeof creativeMutationIdentity>;
  access: PostgresCreativeProjectLegacyAccess;
  assertOpen(): void;
}) {
  const prefix = `${creativeProjectSchemaName(input.schema)}.`;
  const { identity } = input;
  input.assertOpen();
  const rows = await input.client.query<Record<string, unknown>>(
    `SELECT r.*,p.project_id AS legacy_parent_project_id,p.owner_principal_id AS legacy_parent_principal_id FROM ${prefix}creative_project_mutation_receipts r LEFT JOIN ${prefix}creative_projects p ON p.tenant_id=r.tenant_id AND p.space_id=r.space_id AND p.project_id=r.project_id
     WHERE r.tenant_id=$1 AND r.space_id=$2 AND r.principal_id=$3 AND r.actor_id=$4 AND r.kind=$5 AND r.idempotency_key=$6 AND ${input.access.predicate("r")}`,
    [
      ...creativeOwnerValues(identity.owner),
      identity.actor.actorId,
      identity.kind,
      identity.receipt.idempotencyKey,
    ],
  );
  input.assertOpen();
  const row = rows.rows[0];
  if (
    row !== undefined &&
    (row.legacy_parent_project_id !== row.project_id ||
      row.legacy_parent_principal_id !== identity.owner.principalId)
  )
    throw new Error("creative_project_receipt_invalid");
  return decodeCreativeReceipt(row, identity);
}

/** Same original pool and read transaction; each project query carries its own negative SQL predicate. */
export async function readPostgresLegacyCreativeProject<T>(
  input: Readonly<{ pool: Pool; schema: string; assertOpen(): void }>,
  read: PostgresCreativeProjectLegacyRead<T>,
): Promise<T> {
  input.assertOpen();
  const client = await input.pool.connect();
  try {
    input.assertOpen();
    // READ COMMITTED observes a migration that finished while the shared lock
    // waited; holding that lock prevents first migration after inspection.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    await lockPostgresCreativeProjectLegacySchema(client, input.schema);
    const access = await capturePostgresCreativeProjectLegacyAccess(
      client,
      input.schema,
    );
    input.assertOpen();
    const result = await read(client, access);
    input.assertOpen();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackPostgres(client);
    throw error;
  } finally {
    client.release();
  }
}
