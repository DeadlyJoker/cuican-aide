import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  type PluginSelection,
  type InstalledPluginPackage,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  assertPluginInstallationSchemaVersion,
  pluginInstallationSchemaName,
} from "./plugin-installation-schema.ts";

type Row = Record<string, unknown>;
export type QualifiedPluginInstallation = Readonly<{
  selection: PluginSelection;
  package: InstalledPluginPackage;
}>;

/** Installation qualification is independent of task and personal-credit migrations. */
export function assertSqlitePluginInstallationPinSchema(
  database: DatabaseSync,
): void {
  assertPluginInstallationSchemaVersion(
    database
      .prepare(
        "SELECT id,version FROM plugin_installation_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
}

export async function assertPostgresPluginInstallationPinSchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  assertPluginInstallationSchemaVersion(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${prefix(schema)}plugin_installation_schema_version LIMIT 2`,
      )
    ).rows,
  );
}

const selectionQuery = (prefix: string) => `SELECT
  s.tenant_id AS selection_tenant_id,s.space_id AS selection_space_id,s.profile_id AS selection_profile_id,
  s.plugin_id AS selection_plugin_id,s.publisher_id AS selection_publisher_id,
  s.revision AS selection_revision,s.state AS selection_state,s.selected_package_digest AS selection_package_digest,
  s.record_json AS selection_json,
  p.tenant_id AS package_tenant_id,p.space_id AS package_space_id,p.profile_id AS package_profile_id,
  p.plugin_id AS package_plugin_id,p.publisher_id AS package_publisher_id,p.version AS package_version,
  p.package_digest,p.record_json AS package_json
  FROM ${prefix}plugin_profile_selections s
  JOIN ${prefix}installed_plugin_packages p ON p.tenant_id=s.tenant_id AND p.space_id=s.space_id AND p.profile_id=s.profile_id AND p.package_digest=s.selected_package_digest
  WHERE s.tenant_id=$1 AND s.space_id=$2 AND s.profile_id=$3 AND s.plugin_id=$4 LIMIT 2`;

/** Caller already owns BEGIN IMMEDIATE; no asynchronous work or second connection is used. */
export function admitSqlitePluginInstallationPin(
  database: DatabaseSync,
  input: PluginTaskAdmissionPin,
): QualifiedPluginInstallation {
  const pin = parsePluginTaskAdmissionPin(input);
  const rows = database
    .prepare(selectionQuery("").replaceAll(/\$[1-4]/gu, "?"))
    .all(...values(pin));
  return assertSelection(pin, rows);
}

/** Selection updates and uninstallation wait for these exact rows until the caller's COMMIT. */
export async function admitPostgresPluginInstallationPin(
  client: PoolClient,
  schema: string,
  input: PluginTaskAdmissionPin,
): Promise<QualifiedPluginInstallation> {
  const pin = parsePluginTaskAdmissionPin(input);
  const rows = await client.query<Row>(
    `${selectionQuery(prefix(schema))} FOR SHARE OF s,p`,
    values(pin),
  );
  return assertSelection(pin, rows.rows);
}

function assertSelection(
  pin: PluginTaskAdmissionPin,
  rows: readonly Row[],
): QualifiedPluginInstallation {
  if (rows.length !== 1) conflict();
  const row = rows[0]!;
  const selection = parsePluginSelection(json(row.selection_json));
  const pkg = parseInstalledPluginPackage(json(row.package_json));
  if (
    selection.state !== "enabled" ||
    selection.revision !== pin.selectionRevision ||
    selection.selectedPackageDigest !== pin.packageDigest ||
    [selection, pkg].some(
      (value) =>
        value.tenantId !== pin.tenantId ||
        value.spaceId !== pin.spaceId ||
        value.profileId !== pin.profileId ||
        value.pluginId !== pin.pluginId ||
        value.publisherId !== pin.publisherId,
    ) ||
    pkg.packageDigest !== pin.packageDigest ||
    pkg.version !== pin.version ||
    Object.entries({
      tenantId: "tenant_id",
      spaceId: "space_id",
      profileId: "profile_id",
      pluginId: "plugin_id",
      publisherId: "publisher_id",
    }).some(
      ([field, column]) =>
        row[`selection_${column}`] !==
          selection[field as keyof typeof selection] ||
        row[`package_${column}`] !== pkg[field as keyof typeof pkg],
    ) ||
    String(row.selection_revision) !== String(selection.revision) ||
    row.selection_state !== selection.state ||
    row.selection_package_digest !== selection.selectedPackageDigest ||
    row.package_digest !== pkg.packageDigest ||
    row.package_version !== pkg.version
  )
    conflict();
  return Object.freeze({ selection, package: pkg });
}

function conflict(): never {
  throw new Error("plugin_installation_pin_conflict");
}
function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
function prefix(schema: string): string {
  return `${pluginInstallationSchemaName(schema)}.`;
}
function values(pin: PluginTaskAdmissionPin): [string, string, string, string] {
  return [pin.tenantId, pin.spaceId, pin.profileId, pin.pluginId];
}
