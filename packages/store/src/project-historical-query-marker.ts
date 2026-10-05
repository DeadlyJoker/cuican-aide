import {
  sqliteHasHistoricalQueryObjects,
  postgresHasHistoricalQueryObjects,
} from "./project-historical-query-catalog.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { ExtensionRunLocator } from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  type PreparedProjectHistoricalQuery,
  loadSqliteProjectHistoricalQueryLink,
  loadPostgresProjectHistoricalQueryLink,
} from "./project-historical-query-store-support.ts";
import {
  assertSqliteProjectHistoricalQuerySchema,
  assertPostgresProjectHistoricalQuerySchema,
} from "./project-historical-query-schema.ts";
export const historicalQueryMarkerColumn = "project_historical_query_digest";
export function migrateSqliteHistoricalQueryMarker(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA main.table_info(plugin_query_task_admissions)")
    .all();
  if (!columns.some((c) => c.name === historicalQueryMarkerColumn))
    db.exec(
      `ALTER TABLE plugin_query_task_admissions ADD COLUMN ${historicalQueryMarkerColumn} TEXT CHECK(${historicalQueryMarkerColumn} IS NULL OR length(${historicalQueryMarkerColumn})=71);`,
    );
}
export async function migratePostgresHistoricalQueryMarker(
  c: PoolClient,
  schema: string,
): Promise<void> {
  const columns = (
    await c.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='plugin_query_task_admissions'",
      [schema],
    )
  ).rows;
  if (!columns.some((x) => x.column_name === historicalQueryMarkerColumn))
    await c.query(
      `ALTER TABLE ${creativeProjectSchemaName(schema)}.plugin_query_task_admissions ADD COLUMN ${historicalQueryMarkerColumn} TEXT CHECK(${historicalQueryMarkerColumn} IS NULL OR length(${historicalQueryMarkerColumn})=71)`,
    );
}
function check(
  marker: unknown,
  link: import("@crewon/domain").ProjectHistoricalQueryLink | null,
  prepared: PreparedProjectHistoricalQuery | null,
): void {
  if (marker === null || marker === undefined) {
    if (link !== null || prepared !== null)
      throw new Error("project_historical_query_marker_missing");
    return;
  }
  if (
    typeof marker !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(marker) ||
    link === null ||
    link.contentDigest !== marker
  )
    throw new Error("project_historical_query_marker_invalid");
  if (prepared === null)
    throw new Error("project_historical_query_authority_required");
  if (
    extensionCanonicalJson(prepared.publication.publication) !==
    extensionCanonicalJson(link.publication)
  )
    throw new Error("project_historical_query_receipt_conflict");
}
export function assertSqliteHistoricalQueryMarker(
  db: DatabaseSync,
  locator: ExtensionRunLocator,
  prepared: PreparedProjectHistoricalQuery | null,
): void {
  const columns = db
    .prepare("PRAGMA main.table_info(plugin_query_task_admissions)")
    .all();
  if (!columns.some((c) => c.name === historicalQueryMarkerColumn)) {
    if (prepared !== null || sqliteHasHistoricalQueryObjects(db))
      throw new Error("project_historical_query_marker_missing");
    return;
  }
  const marker = db
    .prepare(
      `SELECT ${historicalQueryMarkerColumn} AS digest FROM plugin_query_task_admissions WHERE tenant_id=? AND space_id=? AND run_id=?`,
    )
    .get(locator.tenantId, locator.spaceId, locator.runId)?.digest;
  if (marker === null || marker === undefined) {
    if (sqliteHasHistoricalQueryObjects(db)) {
      assertSqliteProjectHistoricalQuerySchema(db);
      const sidecar = db
        .prepare(
          "SELECT 1 FROM creative_project_historical_query_links WHERE tenant_id=? AND space_id=? AND run_id=?",
        )
        .get(locator.tenantId, locator.spaceId, locator.runId);
      if (sidecar !== undefined)
        throw new Error("project_historical_query_marker_missing");
    }
    check(marker, null, prepared);
    return;
  }
  assertSqliteProjectHistoricalQuerySchema(db);
  check(marker, loadSqliteProjectHistoricalQueryLink(db, locator), prepared);
}
export async function assertPostgresHistoricalQueryMarker(
  c: PoolClient,
  schema: string,
  locator: ExtensionRunLocator,
  prepared: PreparedProjectHistoricalQuery | null,
): Promise<void> {
  const columns = (
    await c.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='plugin_query_task_admissions'",
      [schema],
    )
  ).rows;
  if (!columns.some((x) => x.column_name === historicalQueryMarkerColumn)) {
    if (
      prepared !== null ||
      (await postgresHasHistoricalQueryObjects(c, schema))
    )
      throw new Error("project_historical_query_marker_missing");
    return;
  }
  const marker = (
    await c.query(
      `SELECT ${historicalQueryMarkerColumn} AS digest FROM ${creativeProjectSchemaName(schema)}.plugin_query_task_admissions WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3`,
      [locator.tenantId, locator.spaceId, locator.runId],
    )
  ).rows[0]?.digest;
  if (marker === null || marker === undefined) {
    if (await postgresHasHistoricalQueryObjects(c, schema)) {
      await assertPostgresProjectHistoricalQuerySchema(c, schema);
      const sidecar = await c.query(
        `SELECT 1 FROM ${creativeProjectSchemaName(schema)}.creative_project_historical_query_links WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3`,
        [locator.tenantId, locator.spaceId, locator.runId],
      );
      if (sidecar.rows.length !== 0)
        throw new Error("project_historical_query_marker_missing");
    }
    check(marker, null, prepared);
    return;
  }
  await assertPostgresProjectHistoricalQuerySchema(c, schema);
  check(
    marker,
    await loadPostgresProjectHistoricalQueryLink(c, schema, locator),
    prepared,
  );
}
