import {
  captureSqliteCreativeProjectLegacyAccess,
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
} from "./creative-project-legacy-access.ts";
import {
  assertSqliteTextPlanProject,
  assertPostgresTextPlanProject,
  assertSqliteTextPlanReceiptProject,
  assertPostgresTextPlanReceiptProject,
} from "./project-text-plan-legacy-access.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertSqlitePlanSchema,
  assertPostgresPlanSchema,
} from "./project-text-plan-schema.ts";
import {
  decodePlanAdmission,
  planStoreFail,
} from "./project-text-plan-records.ts";

type Locator = { tenantId: string; spaceId?: string; runId: string };
function digest(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    planStoreFail("project_text_plan_marker_invalid");
  return value;
}
export function sqliteRequiredPlanDigest(
  db: DatabaseSync,
  input: Locator,
): string | null {
  const r = db
    .prepare(
      "SELECT type FROM main.sqlite_schema WHERE name='plugin_task_admissions' UNION ALL SELECT type FROM temp.sqlite_schema WHERE name='plugin_task_admissions'",
    )
    .all();
  if (r.length === 0) return null;
  if (r.length !== 1 || r[0]?.type !== "table")
    planStoreFail("project_text_plan_marker_invalid");
  const col = db
    .prepare("PRAGMA main.table_xinfo(plugin_task_admissions)")
    .all()
    .find((c) => c.name === "project_text_plan_digest");
  if (!col) return null;
  if (col.type !== "TEXT" || col.notnull !== 0 || col.hidden !== 0)
    planStoreFail("project_text_plan_marker_invalid");
  const row = db
    .prepare(
      "SELECT space_id,project_text_plan_digest FROM plugin_task_admissions WHERE tenant_id=? AND run_id=?",
    )
    .get(input.tenantId, input.runId);
  if (!row) return null;
  if (input.spaceId !== undefined && row.space_id !== input.spaceId)
    planStoreFail("project_text_plan_marker_invalid");
  return digest(row.project_text_plan_digest);
}
export async function postgresRequiredPlanDigest(
  c: PoolClient,
  schema: string,
  input: Locator,
): Promise<string | null> {
  const table = (
    await c.query(
      "SELECT c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='plugin_task_admissions'",
      [schema],
    )
  ).rows;
  if (table.length === 0) return null;
  if (table.length !== 1 || table[0]?.relkind !== "r")
    planStoreFail("project_text_plan_marker_invalid");
  const col = (
    await c.query(
      "SELECT a.atttypid,a.attnotnull,a.attgenerated FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='plugin_task_admissions' AND a.attname='project_text_plan_digest' AND a.attnum>0 AND NOT a.attisdropped",
      [schema],
    )
  ).rows;
  if (col.length === 0) return null;
  if (
    col.length !== 1 ||
    col[0]?.atttypid !== 25 ||
    col[0]?.attnotnull !== false ||
    col[0]?.attgenerated !== ""
  )
    planStoreFail("project_text_plan_marker_invalid");
  const row = (
    await c.query(
      `SELECT space_id,project_text_plan_digest FROM ${creativeProjectSchemaName(schema)}.plugin_task_admissions WHERE tenant_id=$1 AND run_id=$2`,
      [input.tenantId, input.runId],
    )
  ).rows[0];
  if (!row) return null;
  if (input.spaceId !== undefined && row.space_id !== input.spaceId)
    planStoreFail("project_text_plan_marker_invalid");
  return digest(row.project_text_plan_digest);
}
export function loadSqlitePlanAdmission(db: DatabaseSync, input: Locator) {
  if (!db.isTransaction)
    throw new Error("creative_project_legacy_transaction_required");
  captureSqliteCreativeProjectLegacyAccess(db);
  const required = sqliteRequiredPlanDigest(db, input);
  if (!assertSqlitePlanSchema(db, false)) {
    if (required !== null) planStoreFail("project_text_plan_marker_invalid");
    return null;
  }
  const row = db
    .prepare(
      "SELECT a.*,p.project_id AS legacy_project_id FROM project_text_plan_run_admissions a JOIN project_text_plans p ON p.tenant_id=a.tenant_id AND p.space_id=a.space_id AND p.plan_id=a.plan_id WHERE a.tenant_id=? AND a.run_id=?",
    )
    .get(input.tenantId, input.runId);
  if (row)
    assertSqliteTextPlanReceiptProject(db, {
      ...row,
      project_id: row.legacy_project_id,
    });
  const saved = decodePlanAdmission(row);
  if (saved && saved.projectId !== row?.legacy_project_id)
    planStoreFail("project_text_plan_marker_invalid");
  if (required !== (saved?.contentDigest ?? null))
    planStoreFail("project_text_plan_marker_invalid");
  if (
    saved &&
    input.spaceId !== undefined &&
    saved.actor.spaceId !== input.spaceId
  )
    planStoreFail("project_text_plan_marker_invalid");
  if (saved) assertSqliteTextPlanProject(db, saved.actor, saved.projectId);
  return saved;
}
export async function loadPostgresPlanAdmission(
  c: PoolClient,
  schema: string,
  input: Locator,
) {
  await lockPostgresCreativeProjectLegacySchema(c, schema);
  await capturePostgresCreativeProjectLegacyAccess(c, schema);
  const required = await postgresRequiredPlanDigest(c, schema, input);
  if (!(await assertPostgresPlanSchema(c, schema, false))) {
    if (required !== null) planStoreFail("project_text_plan_marker_invalid");
    return null;
  }
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  const row = (
    await c.query(
      `SELECT a.*,p.project_id AS legacy_project_id FROM ${prefix}project_text_plan_run_admissions a JOIN ${prefix}project_text_plans p ON p.tenant_id=a.tenant_id AND p.space_id=a.space_id AND p.plan_id=a.plan_id WHERE a.tenant_id=$1 AND a.run_id=$2`,
      [input.tenantId, input.runId],
    )
  ).rows[0];
  if (row)
    await assertPostgresTextPlanReceiptProject(c, schema, {
      ...row,
      project_id: row.legacy_project_id,
    });
  const saved = decodePlanAdmission(row);
  if (saved && saved.projectId !== row?.legacy_project_id)
    planStoreFail("project_text_plan_marker_invalid");
  if (required !== (saved?.contentDigest ?? null))
    planStoreFail("project_text_plan_marker_invalid");
  if (
    saved &&
    input.spaceId !== undefined &&
    saved.actor.spaceId !== input.spaceId
  )
    planStoreFail("project_text_plan_marker_invalid");
  if (saved)
    await assertPostgresTextPlanProject(
      c,
      schema,
      saved.actor,
      saved.projectId,
    );
  return saved;
}

/** Legacy marker presence survives entirely absent optional plan/owner schemas; it never becomes null on missing required evidence. */
export function readSqliteRequiredPlanDigest(
  db: DatabaseSync,
  input: Locator,
): string | null {
  if (!db.isTransaction)
    throw new Error("creative_project_legacy_transaction_required");
  const access = captureSqliteCreativeProjectLegacyAccess(db);
  if (access.predicate("p") === "TRUE" && !assertSqlitePlanSchema(db, false))
    return sqliteRequiredPlanDigest(db, input);
  return loadSqlitePlanAdmission(db, input)?.contentDigest ?? null;
}
export async function readPostgresRequiredPlanDigest(
  c: PoolClient,
  schema: string,
  input: Locator,
): Promise<string | null> {
  await lockPostgresCreativeProjectLegacySchema(c, schema);
  const access = await capturePostgresCreativeProjectLegacyAccess(c, schema);
  if (
    access.predicate("p") === "TRUE" &&
    !(await assertPostgresPlanSchema(c, schema, false))
  )
    return postgresRequiredPlanDigest(c, schema, input);
  return (
    (await loadPostgresPlanAdmission(c, schema, input))?.contentDigest ?? null
  );
}
