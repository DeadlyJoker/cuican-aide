import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  parseProjectAssetStageRunAdmission,
  projectAssetFailure,
  type ProjectAssetStageRunAdmission,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
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
    (row.project_stage_digest != null || row.project_text_plan_digest != null)
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
export function loadSqliteAssetStage(db: DatabaseSync, l: Locator) {
  const r = sqliteRequiredAssetStageDigest(db, l);
  if (!assertSqliteAssetStageSchema(db, true)) return checked(r, null);
  return checked(
    r,
    decodeAssetStage(
      db
        .prepare(
          "SELECT * FROM project_asset_stage_run_admissions WHERE tenant_id=? AND run_id=?",
        )
        .get(l.tenantId, l.runId),
      l,
    ),
  );
}
export async function loadPostgresAssetStage(
  c: PoolClient,
  s: string,
  l: Locator,
) {
  const r = await postgresRequiredAssetStageDigest(c, s, l);
  if (!(await assertPostgresAssetStageSchema(c, s, true)))
    return checked(r, null);
  return checked(
    r,
    decodeAssetStage(
      (
        await c.query(
          `SELECT * FROM ${creativeProjectSchemaName(s)}.project_asset_stage_run_admissions WHERE tenant_id=$1 AND run_id=$2`,
          [l.tenantId, l.runId],
        )
      ).rows[0],
      l,
    ),
  );
}
