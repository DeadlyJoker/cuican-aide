import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  parseProjectAssetStageRunAdmission,
  projectAssetFailure,
  validateCreativeProjectScope,
  type ProjectAssetStageRunAdmission,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  captureSqliteCreativeProjectLegacyAccess,
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
} from "./creative-project-legacy-access.ts";
import {
  assertSqliteAssetStageSchema,
  assertPostgresAssetStageSchema,
} from "./project-asset-stage-schema.ts";
type Locator = Readonly<{ tenantId: string; spaceId?: string; runId: string }>;
function digest(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    projectAssetFailure("project_asset_stage_marker_invalid");
  return value;
}
function marker(
  row: Record<string, unknown> | undefined,
  l: Locator,
): string | null {
  if (!row) return null;
  if (l.spaceId !== undefined && row.space_id !== l.spaceId)
    projectAssetFailure("project_asset_stage_marker_invalid");
  const required = digest(row.project_asset_stage_digest);
  if (
    required !== null &&
    (row.project_stage_digest != null ||
      row.project_text_plan_digest != null ||
      row.project_media_input_stage_digest != null)
  )
    projectAssetFailure("project_asset_stage_marker_invalid");
  return required;
}
export function sqliteRequiredAssetStageDigest(
  db: DatabaseSync,
  l: Locator,
): string | null {
  const t = db
    .prepare(
      "SELECT type FROM main.sqlite_schema WHERE name='plugin_task_admissions' UNION ALL SELECT type FROM temp.sqlite_schema WHERE name='plugin_task_admissions'",
    )
    .all();
  if (!t.length) return null;
  if (t.length !== 1 || t[0]?.type !== "table")
    projectAssetFailure("project_asset_stage_marker_invalid");
  const cols = db
    .prepare("PRAGMA main.table_xinfo(plugin_task_admissions)")
    .all();
  if (!cols.some((c) => c.name === "project_asset_stage_digest")) return null;
  return marker(
    db
      .prepare(
        "SELECT * FROM plugin_task_admissions WHERE tenant_id=? AND run_id=?",
      )
      .get(l.tenantId, l.runId),
    l,
  );
}
export async function postgresRequiredAssetStageDigest(
  c: PoolClient,
  s: string,
  l: Locator,
): Promise<string | null> {
  const t = (
    await c.query(
      "SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='plugin_task_admissions'",
      [s],
    )
  ).rows;
  if (!t.length) return null;
  if (t.length !== 1 || t[0]?.relkind !== "r")
    projectAssetFailure("project_asset_stage_marker_invalid");
  const cols = (
    await c.query(
      "SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='plugin_task_admissions' AND a.attname='project_asset_stage_digest' AND a.attnum>0 AND NOT a.attisdropped",
      [s],
    )
  ).rows;
  if (!cols.length) return null;
  return marker(
    (
      await c.query(
        `SELECT * FROM ${creativeProjectSchemaName(s)}.plugin_task_admissions WHERE tenant_id=$1 AND run_id=$2`,
        [l.tenantId, l.runId],
      )
    ).rows[0],
    l,
  );
}
export function decodeAssetStage(
  row: Record<string, unknown> | undefined,
  l: Locator,
): ProjectAssetStageRunAdmission | null {
  if (!row) return null;
  const a = parseProjectAssetStageRunAdmission(
    typeof row.record_json === "string"
      ? JSON.parse(row.record_json)
      : row.record_json,
    creativeStoreDigester,
  );
  if (
    a.actor.tenantId !== l.tenantId ||
    (l.spaceId !== undefined && a.actor.spaceId !== l.spaceId) ||
    a.runId !== l.runId ||
    row.tenant_id !== a.actor.tenantId ||
    row.space_id !== a.actor.spaceId ||
    row.run_id !== a.runId ||
    row.thread_id !== a.threadId ||
    row.binding_id !== a.bindingId ||
    String(row.binding_revision) !== String(a.bindingRevision) ||
    row.content_digest !== a.contentDigest
  )
    projectAssetFailure("project_asset_stage_record_invalid");
  return a;
}
function checked(
  required: string | null,
  actual: ProjectAssetStageRunAdmission | null,
) {
  if (required !== (actual?.contentDigest ?? null))
    projectAssetFailure("project_asset_stage_marker_invalid");
  return actual;
}
export function loadSqliteAssetStage(
  db: DatabaseSync,
  l: Locator,
  options?: Readonly<{
    projectAccess: import("./creative-project-legacy-access.ts").CreativeProjectLegacyAccess;
  }>,
) {
  if (!db.isTransaction)
    throw new Error("creative_project_legacy_transaction_required");
  const access =
    options?.projectAccess ?? captureSqliteCreativeProjectLegacyAccess(db);
  const row = assertSqliteAssetStageSchema(db, true)
    ? db
        .prepare(
          "SELECT *,json_extract(record_json,'$.projectId') AS legacy_project_id FROM project_asset_stage_run_admissions WHERE tenant_id=? AND run_id=?",
        )
        .get(l.tenantId, l.runId)
    : undefined;
  if (row) access.assertProject(stageLegacyScope(row));
  return checked(
    sqliteRequiredAssetStageDigest(db, l),
    decodeAssetStage(row, l),
  );
}
export async function loadPostgresAssetStage(
  c: PoolClient,
  s: string,
  l: Locator,
  options?: Readonly<{
    projectAccess: import("./creative-project-legacy-access.ts").PostgresCreativeProjectLegacyAccess;
  }>,
) {
  await lockPostgresCreativeProjectLegacySchema(c, s);
  const access =
    options?.projectAccess ??
    (await capturePostgresCreativeProjectLegacyAccess(c, s));
  const row = (await assertPostgresAssetStageSchema(c, s, true))
    ? (
        await c.query(
          `SELECT *,record_json->>'projectId' AS legacy_project_id FROM ${creativeProjectSchemaName(s)}.project_asset_stage_run_admissions WHERE tenant_id=$1 AND run_id=$2`,
          [l.tenantId, l.runId],
        )
      ).rows[0]
    : undefined;
  if (row) await access.assertProject(stageLegacyScope(row));
  return checked(
    await postgresRequiredAssetStageDigest(c, s, l),
    decodeAssetStage(row, l),
  );
}

/** Actual saved SQL identity and saved project scalar; this is only a negative constraint. */
function stageLegacyScope(row: Record<string, unknown>) {
  return validateCreativeProjectScope({
    tenantId: row.tenant_id,
    spaceId: row.space_id,
    projectId: row.legacy_project_id,
  });
}
