import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import type { ExtensionRunLocator, ExtensionStore } from "@crewon/application";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import { assertPluginTaskAdmissionSchemaVersion } from "./plugin-task-admission-schema.ts";
import { validateRunScopedLocator } from "./store-invariants.ts";

type AdmissionReader = Required<
  Pick<ExtensionStore, "pluginAdmissionVersion" | "loadPluginTaskAdmission">
>;
type Lifetime = Readonly<{
  assertOpen(): void;
  extensionStore(): AdmissionReader;
}>;
const names = [
  "plugin_task_admission_schema_version",
  "plugin_task_admissions",
] as const;

/** Construction performs no SQL or extension-store access; schema absence is checked anew for every Run. */
export function createSqlitePluginTaskAdmissionProbe(
  input: Lifetime & Readonly<{ database: DatabaseSync }>,
): AdmissionReader {
  return Object.freeze({
    pluginAdmissionVersion: "crewon.plugin-task-admission.v1" as const,
    async loadPluginTaskAdmission(request: ExtensionRunLocator) {
      input.assertOpen();
      const locator = captureLocator(request);
      const rows = input.database
        .prepare(
          `SELECT name,type,'main' AS source FROM main.sqlite_master WHERE name IN (?,?)
           UNION ALL SELECT name,type,'temp' AS source FROM temp.sqlite_master WHERE name IN (?,?) LIMIT 3`,
        )
        .all(...names, ...names) as {
        name: unknown;
        type: unknown;
        source: unknown;
      }[];
      input.assertOpen();
      if (rows.length === 0) return null;
      assertTables(
        rows.map((row) => ({
          name: row.name,
          table: row.type === "table" && row.source === "main",
        })),
      );
      assertPluginTaskAdmissionSchemaVersion(
        input.database
          .prepare(
            "SELECT id,version FROM main.plugin_task_admission_schema_version LIMIT 2",
          )
          .all() as { id: unknown; version: unknown }[],
      );
      const present = input.database
        .prepare(
          "SELECT 1 AS present FROM main.plugin_task_admissions WHERE tenant_id=? AND run_id=? LIMIT 1",
        )
        .get(locator.tenantId, locator.runId);
      input.assertOpen();
      if (present === undefined) return null;
      const result = await input
        .extensionStore()
        .loadPluginTaskAdmission(locator);
      input.assertOpen();
      if (result === null)
        throw new Error("plugin_task_admission_record_invalid");
      return result;
    },
  });
}

/** Queries only the configured namespace's catalog until both current v1 tables are known to exist. */
export function createPostgresPluginTaskAdmissionProbe(
  input: Lifetime & Readonly<{ pool: Pool; schema: string }>,
): AdmissionReader {
  const prefix = `${pluginInstallationSchemaName(input.schema)}.`;
  return Object.freeze({
    pluginAdmissionVersion: "crewon.plugin-task-admission.v1" as const,
    async loadPluginTaskAdmission(request: ExtensionRunLocator) {
      input.assertOpen();
      const locator = captureLocator(request);
      const catalog = await input.pool.query<{ name: unknown; kind: unknown }>(
        `SELECT c.relname AS name,c.relkind AS kind FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) LIMIT 3`,
        [input.schema, names],
      );
      input.assertOpen();
      if (catalog.rows.length === 0) return null;
      assertTables(
        catalog.rows.map((row) => ({
          name: row.name,
          table: row.kind === "r",
        })),
      );
      const version = await input.pool.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${prefix}plugin_task_admission_schema_version LIMIT 2`,
      );
      input.assertOpen();
      assertPluginTaskAdmissionSchemaVersion(version.rows);
      const present = await input.pool.query(
        `SELECT 1 AS present FROM ${prefix}plugin_task_admissions WHERE tenant_id=$1 AND run_id=$2 LIMIT 1`,
        [locator.tenantId, locator.runId],
      );
      input.assertOpen();
      if (present.rows.length === 0) return null;
      const result = await input
        .extensionStore()
        .loadPluginTaskAdmission(locator);
      input.assertOpen();
      if (result === null)
        throw new Error("plugin_task_admission_record_invalid");
      return result;
    },
  });
}

function assertTables(
  rows: readonly { name: unknown; table: boolean }[],
): void {
  if (
    rows.length !== 2 ||
    names.some(
      (name) => rows.filter((row) => row.name === name).length !== 1,
    ) ||
    rows.some((row) => !row.table)
  )
    throw new Error("plugin_task_admission_schema_incomplete");
}

function captureLocator(input: ExtensionRunLocator): ExtensionRunLocator {
  if (typeof input !== "object" || input === null)
    throw new Error("plugin_task_admission_locator_invalid");
  const value = (name: keyof ExtensionRunLocator) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string"
    )
      throw new Error("plugin_task_admission_locator_invalid");
    return descriptor.value;
  };
  const locator = Object.freeze({
    tenantId: value("tenantId"),
    spaceId: value("spaceId"),
    runId: value("runId"),
  });
  validateRunScopedLocator(locator);
  return locator;
}
