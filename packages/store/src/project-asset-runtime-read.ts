import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import {
  qualifyProjectAssetRuntimeReadObservation,
  type ProjectAssetRuntimeReadObservation,
} from "@crewon/application/host-project-workspaces";
import type {
  CreativeProjectLegacyAccess,
  PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { lockPostgresCreativeProjectLegacySchema } from "./creative-project-legacy-access.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import {
  proveSqliteAssetRuntimeRead,
  provePostgresAssetRuntimeRead,
} from "./project-asset-runtime-read-proof.ts";

export type ProjectAssetRuntimeReadOptions = Readonly<{
  projectAssetRuntimeReadObservation: ProjectAssetRuntimeReadObservation;
}>;
function source(
  options: ProjectAssetRuntimeReadOptions,
  request: Readonly<{
    tenantId: string;
    spaceId: string;
    pluginId?: string;
    runId?: string;
    receipt?: unknown;
  }>,
) {
  if (options === null || typeof options !== "object") denied();
  const d = Object.getOwnPropertyDescriptor(
    options,
    "projectAssetRuntimeReadObservation",
  );
  if (
    typeof options !== "object" ||
    Reflect.ownKeys(options).length !== 1 ||
    !d?.enumerable ||
    !Object.hasOwn(d, "value")
  )
    denied();
  const s = qualifyProjectAssetRuntimeReadObservation(d.value);
  if (
    request.tenantId !== s.binding.tenantId ||
    request.spaceId !== s.binding.spaceId ||
    (request.pluginId !== undefined &&
      request.pluginId !== s.binding.pluginId) ||
    (request.runId !== undefined && request.runId !== s.binding.runId)
  )
    denied();
  if (request.receipt !== undefined) {
    const r = request.receipt as Record<string, unknown>;
    if (
      r.actorId !== s.receipt.actorId ||
      r.idempotencyKey !== s.receipt.idempotencyKey ||
      r.requestDigest !== s.receipt.requestDigest
    )
      denied();
  }
  return s;
}
/** Host-only observation is re-proved using original SQL facts, on the original
 * connection. It is never asserted to have already verified a receipt or Tool.
 */
export async function readSqliteAssetRuntimeMetadata<T>(
  input: Readonly<{
    database: DatabaseSync;
    assertOpen(): void;
    request: Parameters<typeof source>[1];
    options: ProjectAssetRuntimeReadOptions;
  }>,
  read: (access: CreativeProjectLegacyAccess) => T,
): Promise<T> {
  const s = source(input.options, input.request);
  await s.assertCurrent();
  input.assertOpen();
  if (input.database.isTransaction)
    throw new Error("project_asset_runtime_read_nested_transaction");
  input.database.exec("BEGIN DEFERRED");
  let result: T;
  try {
    const proof = proveSqliteAssetRuntimeRead(input.database, s);
    result = read(proof.access);
    proveSqliteAssetRuntimeRead(input.database, s);
    s.assertActive();
    input.assertOpen();
    input.database.exec("COMMIT");
  } catch (error) {
    input.database.exec("ROLLBACK");
    throw error;
  }
  await s.assertCurrent();
  input.assertOpen();
  return result;
}
export async function readPostgresAssetRuntimeMetadata<T>(
  input: Readonly<{
    pool: Pool;
    schema: string;
    assertOpen(): void;
    request: Parameters<typeof source>[1];
    options: ProjectAssetRuntimeReadOptions;
  }>,
  read: (
    c: PoolClient,
    access: PostgresCreativeProjectLegacyAccess,
  ) => Promise<T>,
): Promise<T> {
  const s = source(input.options, input.request);
  await s.assertCurrent();
  input.assertOpen();
  const c = await input.pool.connect();
  let result: T;
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockPostgresCreativeProjectLegacySchema(c, input.schema);
    const proof = await provePostgresAssetRuntimeRead(c, input.schema, s);
    result = await read(c, proof.access);
    await provePostgresAssetRuntimeRead(c, input.schema, s);
    s.assertActive();
    input.assertOpen();
    await c.query("COMMIT");
  } catch (error) {
    await rollbackPostgres(c);
    throw error;
  } finally {
    c.release();
  }
  await s.assertCurrent();
  input.assertOpen();
  return result;
}
function denied(): never {
  throw new Error("project_asset_runtime_read_observation_mismatch");
}
