import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { conversationFail } from "./project-conversation-store-support.ts";

export function sqliteRequiredStageDigest(
  db: DatabaseSync,
  input: { tenantId: string; spaceId?: string; runId: string },
): string | null {
  const tables = db
    .prepare(
      "SELECT type FROM main.sqlite_schema WHERE name='plugin_task_admissions' UNION ALL SELECT type FROM temp.sqlite_schema WHERE name='plugin_task_admissions'",
    )
    .all();
  if (tables.length === 0) return null;
  if (tables.length !== 1 || tables[0]?.type !== "table")
    conversationFail("project_stage_marker_invalid");
  const columns = db
    .prepare("PRAGMA main.table_xinfo(plugin_task_admissions)")
    .all();
  if (!columns.some((c) => c.name === "project_stage_digest")) return null;
  const row = db
    .prepare(
      "SELECT space_id,project_stage_digest FROM plugin_task_admissions WHERE tenant_id=? AND run_id=?",
    )
    .get(input.tenantId, input.runId);
  if (row === undefined) return null;
  if (input.spaceId !== undefined && row.space_id !== input.spaceId)
    conversationFail("project_stage_marker_invalid");
  return stageDigest(row.project_stage_digest);
}
export async function postgresRequiredStageDigest(
  c: PoolClient,
  schema: string,
  input: { tenantId: string; spaceId?: string; runId: string },
): Promise<string | null> {
  const table = (
    await c.query<{ relkind: string }>(
      "SELECT c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='plugin_task_admissions'",
      [schema],
    )
  ).rows;
  if (table.length === 0) return null;
  if (table.length !== 1 || table[0]?.relkind !== "r")
    conversationFail("project_stage_marker_invalid");
  const columns = (
    await c.query(
      "SELECT a.attname FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='plugin_task_admissions' AND a.attname='project_stage_digest' AND a.attnum>0 AND NOT a.attisdropped",
      [schema],
    )
  ).rows;
  if (columns.length === 0) return null;
  const row = (
    await c.query<Record<string, unknown>>(
      `SELECT space_id,project_stage_digest FROM ${creativeProjectSchemaName(schema)}.plugin_task_admissions WHERE tenant_id=$1 AND run_id=$2`,
      [input.tenantId, input.runId],
    )
  ).rows[0];
  if (row === undefined) return null;
  if (input.spaceId !== undefined && row.space_id !== input.spaceId)
    conversationFail("project_stage_marker_invalid");
  return stageDigest(row.project_stage_digest);
}
export function assertStageMarker(
  required: string | null,
  actual: { contentDigest: string } | null,
): void {
  if (required === (actual?.contentDigest ?? null)) return;
  conversationFail("project_stage_marker_invalid");
}
function stageDigest(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    conversationFail("project_stage_marker_invalid");
  return value;
}
export function sqliteThreadBindingMarker(
  db: DatabaseSync,
  input: { tenantId: string; spaceId: string; threadId: string },
): string | null {
  const tables = db
    .prepare(
      "SELECT type FROM main.sqlite_schema WHERE name='threads' UNION ALL SELECT type FROM temp.sqlite_schema WHERE name='threads'",
    )
    .all();
  if (tables.length !== 1 || tables[0]?.type !== "table")
    conversationFail("project_conversation_marker_invalid");
  if (
    !db
      .prepare("PRAGMA main.table_xinfo(threads)")
      .all()
      .some((c) => c.name === "project_conversation_binding_id")
  )
    return null;
  const row = db
    .prepare(
      "SELECT project_conversation_binding_id FROM threads WHERE tenant_id=? AND space_id=? AND thread_id=?",
    )
    .get(input.tenantId, input.spaceId, input.threadId);
  return bindingMarker(row?.project_conversation_binding_id ?? null);
}
export async function postgresThreadBindingMarker(
  c: PoolClient,
  schema: string,
  input: { tenantId: string; spaceId: string; threadId: string },
): Promise<string | null> {
  const tables = (
    await c.query(
      "SELECT c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='threads'",
      [schema],
    )
  ).rows;
  if (tables.length !== 1 || tables[0]?.relkind !== "r")
    conversationFail("project_conversation_marker_invalid");
  const columns = (
    await c.query(
      "SELECT a.attname FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='threads' AND a.attname='project_conversation_binding_id' AND a.attnum>0 AND NOT a.attisdropped",
      [schema],
    )
  ).rows;
  if (columns.length === 0) return null;
  const row = (
    await c.query<Record<string, unknown>>(
      `SELECT project_conversation_binding_id FROM ${creativeProjectSchemaName(schema)}.threads WHERE tenant_id=$1 AND space_id=$2 AND thread_id=$3`,
      [input.tenantId, input.spaceId, input.threadId],
    )
  ).rows[0];
  return bindingMarker(row?.project_conversation_binding_id ?? null);
}
function bindingMarker(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 128)
    conversationFail("project_conversation_marker_invalid");
  return value;
}
