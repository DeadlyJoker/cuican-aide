import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { RunStoreError } from "@crewon/application";

export const AUTOMATION_SCHEDULE_INDEX = "automations_scheduled_cursor_idx";

export function sqliteAutomationScheduleIndexSql(): string {
  return `CREATE INDEX IF NOT EXISTS ${AUTOMATION_SCHEDULE_INDEX}
    ON automations(updated_at DESC, automation_id DESC)
    WHERE json_extract(definition_json, '$.executionMode') = 'scheduled'`;
}

export function assertSqliteAutomationScheduleIndex(
  database: DatabaseSync,
): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
    .get(AUTOMATION_SCHEDULE_INDEX);
  const normalize = (sql: string) =>
    sql
      .replace(/'(?:''|[^'])*'|\s+/g, (part) =>
        part.startsWith("'") ? part : "",
      )
      .replace("IFNOTEXISTS", "")
      .replace(/;$/, "");
  if (
    typeof row?.sql !== "string" ||
    normalize(row.sql) !== normalize(sqliteAutomationScheduleIndexSql())
  )
    throw new RunStoreError("sqlite_automation_schedule_index_invalid");
}

export function postgresAutomationScheduleIndexSql(schema: string): string {
  return `CREATE INDEX IF NOT EXISTS ${AUTOMATION_SCHEDULE_INDEX}
    ON ${schema}.automations(updated_at DESC, automation_id COLLATE "C" DESC)
    WHERE definition_json ->> 'executionMode' = 'scheduled'`;
}

export async function assertPostgresAutomationScheduleIndex(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const result = await client.query<{
    valid: boolean;
    ready: boolean;
    unique_index: boolean;
    method: string;
    keys: string[];
    options: number[];
    predicate: string;
    collation: string;
  }>(
    `SELECT i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique_index,
      am.amname AS method,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY n) AS keys,
      i.indoption::smallint[] AS options, pg_get_expr(i.indpred,i.indrelid) AS predicate,
      (SELECT c.collname FROM pg_collation c WHERE c.oid=i.indcollation[1]) AS collation
    FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_am am ON am.oid=idx.relam
    WHERE i.indrelid='${schema}.automations'::regclass AND idx.relname=$1`,
    [AUTOMATION_SCHEDULE_INDEX],
  );
  const index = result.rows[0];
  if (
    result.rowCount !== 1 ||
    !index?.valid ||
    !index.ready ||
    index.unique_index ||
    index.method !== "btree" ||
    JSON.stringify(index.keys) !==
      JSON.stringify(["updated_at", "automation_id"]) ||
    JSON.stringify(index.options) !== "[3,3]" ||
    index.collation !== "C" ||
    index.predicate !==
      "((definition_json ->> 'executionMode'::text) = 'scheduled'::text)"
  )
    throw new RunStoreError("postgres_automation_schedule_index_invalid");
}
