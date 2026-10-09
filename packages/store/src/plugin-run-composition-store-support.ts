import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type { PluginCompositionLock } from "@crewon/contracts/plugins";
import type {
  ExtensionRunBinding,
  ExtensionRunBindingV1,
  ExtensionConfiguration,
  PluginProfileScope,
} from "@crewon/domain";
import {
  assertCompositionVersion,
  compositionScopeValues,
  compositionStoreFail,
  decodeCompositionRow,
} from "./plugin-composition-store-records.ts";
import {
  admitSqliteProjectToolInstallationPin,
  admitPostgresProjectToolInstallationPin,
  assertSqlitePluginInstallationPinSchema,
  assertPostgresPluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import {
  lockPostgresCompositionSnapshot,
  assertPostgresCompositionSnapshotSchema,
} from "./plugin-composition-snapshot-lock.ts";
const where = "tenant_id=$1 AND space_id=$2 AND profile_id=$3";
export function runCompositionScope(
  binding: ExtensionRunBindingV1,
): PluginProfileScope {
  return {
    tenantId: binding.tenantId,
    spaceId: binding.spaceId,
    profileId: binding.composition.profileId,
  };
}
function assertReference(
  binding: ExtensionRunBindingV1,
  lock: PluginCompositionLock,
): void {
  if (
    lock.lockDigest !== binding.composition.lockDigest ||
    lock.revision !== binding.composition.revision ||
    lock.scope.authorityEpoch !== binding.composition.authorityEpoch ||
    !lock.nodes.some((node) => node.pluginId === binding.pluginId)
  )
    compositionStoreFail("plugin_run_composition_reference_conflict");
}
/** Reads only the Run's original lock. Current selections and head are deliberately irrelevant to history. */
export function readSqliteRunComposition(
  database: DatabaseSync,
  binding: ExtensionRunBinding,
): PluginCompositionLock | null {
  if (binding.schemaVersion === "crewon.extension-run-binding.v0") return null;
  assertCompositionVersion(
    database
      .prepare(
        "SELECT id,version FROM plugin_composition_schema_version LIMIT 2",
      )
      .all(),
  );
  const scope = runCompositionScope(binding);
  const row = database
    .prepare(
      `SELECT * FROM plugin_composition_locks WHERE ${where.replaceAll(/\$[1-3]/gu, "?")} AND lock_digest=?`,
    )
    .get(...compositionScopeValues(scope), binding.composition.lockDigest);
  if (!row) compositionStoreFail("plugin_run_composition_missing");
  const lock = decodeCompositionRow(row, scope);
  assertReference(binding, lock);
  return lock;
}
export async function readPostgresRunComposition(
  client: Pool | PoolClient,
  schema: string,
  binding: ExtensionRunBinding,
): Promise<PluginCompositionLock | null> {
  if (binding.schemaVersion === "crewon.extension-run-binding.v0") return null;
  const prefix = `${pluginInstallationSchemaName(schema)}.`;
  assertCompositionVersion(
    (
      await client.query(
        `SELECT id,version FROM ${prefix}plugin_composition_schema_version LIMIT 2`,
      )
    ).rows,
  );
  const scope = runCompositionScope(binding);
  const row = (
    await client.query(
      `SELECT * FROM ${prefix}plugin_composition_locks WHERE ${where} AND lock_digest=$4`,
      [...compositionScopeValues(scope), binding.composition.lockDigest],
    )
  ).rows[0];
  if (!row) compositionStoreFail("plugin_run_composition_missing");
  const lock = decodeCompositionRow(row, scope);
  assertReference(binding, lock);
  return lock;
}
/** Acquire before any installation row locks in the existing Turn transaction. Never acquire the owner's session lease. */
export async function lockPostgresRunComposition(
  client: PoolClient,
  schema: string,
  binding: ExtensionRunBinding,
): Promise<void> {
  if (binding.schemaVersion === "crewon.extension-run-binding.v0") return;
  await assertPostgresCompositionSnapshotSchema(client, schema);
  await lockPostgresCompositionSnapshot({
    client,
    schema,
    scope: runCompositionScope(binding),
    mode: "read",
  });
}
export function admitSqliteRunComposition(
  database: DatabaseSync,
  binding: ExtensionRunBinding,
): PluginCompositionLock | null {
  const lock = readSqliteRunComposition(database, binding);
  if (lock === null) return null;
  if (binding.source !== null)
    compositionStoreFail("plugin_run_composition_query_unsupported");
  const scope = lock.scope;
  const head = database
    .prepare(
      `SELECT revision,lock_digest FROM plugin_composition_heads WHERE ${where.replaceAll(/\$[1-3]/gu, "?")}`,
    )
    .get(...compositionScopeValues(scope));
  if (
    Number(head?.revision) !== lock.revision ||
    head?.lock_digest !== lock.lockDigest
  )
    compositionStoreFail("plugin_run_composition_current_conflict");
  assertSqlitePluginInstallationPinSchema(database);
  const count = database
    .prepare(
      `SELECT count(*) AS count FROM plugin_profile_selections WHERE ${where.replaceAll(/\$[1-3]/gu, "?")} AND state='enabled'`,
    )
    .get(...compositionScopeValues(scope))!;
  if (Number(count.count) !== lock.nodes.length)
    compositionStoreFail("plugin_run_composition_selection_conflict");
  for (const node of lock.nodes)
    admitSqliteProjectToolInstallationPin(database, { ...scope, ...node });
  return lock;
}
export async function admitPostgresRunComposition(
  client: PoolClient,
  schema: string,
  binding: ExtensionRunBinding,
): Promise<PluginCompositionLock | null> {
  await lockPostgresRunComposition(client, schema, binding);
  const lock = await readPostgresRunComposition(client, schema, binding);
  if (lock === null) return null;
  if (binding.source !== null)
    compositionStoreFail("plugin_run_composition_query_unsupported");
  const prefix = `${pluginInstallationSchemaName(schema)}.`,
    scope = lock.scope;
  const head = (
    await client.query(
      `SELECT revision,lock_digest FROM ${prefix}plugin_composition_heads WHERE ${where} FOR SHARE`,
      compositionScopeValues(scope),
    )
  ).rows[0];
  if (
    Number(head?.revision) !== lock.revision ||
    head?.lock_digest !== lock.lockDigest
  )
    compositionStoreFail("plugin_run_composition_current_conflict");
  await assertPostgresPluginInstallationPinSchema(client, schema);
  const count = (
    await client.query(
      `SELECT count(*) AS count FROM ${prefix}plugin_profile_selections WHERE ${where} AND state='enabled'`,
      compositionScopeValues(scope),
    )
  ).rows[0];
  if (Number(count?.count) !== lock.nodes.length)
    compositionStoreFail("plugin_run_composition_selection_conflict");
  for (const node of lock.nodes)
    await admitPostgresProjectToolInstallationPin(client, schema, {
      ...scope,
      ...node,
    });
  return lock;
}

export function assertRunCompositionConfiguration(
  lock: PluginCompositionLock | null,
  binding: ExtensionRunBinding,
  configuration: ExtensionConfiguration | null,
): void {
  if (lock === null) return;
  const root = lock.nodes.find((node) => node.pluginId === binding.pluginId);
  if (configuration === null || root?.version !== configuration.pluginVersion)
    compositionStoreFail("plugin_run_composition_configuration_conflict");
}
