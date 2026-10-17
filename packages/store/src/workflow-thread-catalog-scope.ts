import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { RunStoreError } from "@crewon/application";
import { assertSqliteWorkflowChildMembershipSchema } from "./sqlite-workflow-child-schema.ts";
import { validatePostgresSchemaName } from "./postgres-queue-schema.ts";
import {
  POSTGRES_WORKFLOW_CHILD_COLUMNS,
  postgresWorkflowChildConstraints,
  normalizePostgresWorkflowConstraint as normalize,
} from "./postgres-workflow-child-membership-schema.ts";

/** Membership is persisted authority, independent of execution opt-in or titles. */
export function sqliteWorkflowChildCatalogTable(
  db: DatabaseSync,
): string | undefined {
  return assertSqliteWorkflowChildMembershipSchema(db)
    ? "workflow_node_children"
    : undefined;
}

export async function postgresWorkflowChildCatalogTable(
  client: PoolClient,
  schema: string,
): Promise<string | undefined> {
  validatePostgresSchemaName(schema);
  const present = await client.query(
    `SELECT c.relname::text,c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
     UNION ALL SELECT '__workflow_wake_marker__','marker' FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='run_snapshots' AND t.tgname='workflow_child_terminal_wake'`,
    [schema, ["workflow_composition_schema", "workflow_node_children"]],
  );
  if (present.rows.length === 0) return undefined;
  const memberships = present.rows.filter(
    (row) => row.relname !== "__workflow_wake_marker__",
  );
  if (
    memberships.length !== 2 ||
    memberships.some((row) => row.relkind !== "r")
  )
    corrupt();
  // Two fixed catalog queries, not per-child reads or scheduler-health validation.
  const { rows } = await client.query(
    `SELECT
    (SELECT jsonb_agg(v) FROM (SELECT singleton,version FROM "${schema}".workflow_composition_schema LIMIT 2) v) AS versions,
    (SELECT jsonb_agg(c ORDER BY c.ordinal_position) FROM (SELECT column_name,data_type,is_nullable,ordinal_position FROM information_schema.columns WHERE table_schema=$1 AND table_name='workflow_node_children' ORDER BY ordinal_position LIMIT 64) c) AS columns,
    (SELECT jsonb_agg(c) FROM (SELECT x.contype AS kind,pg_get_constraintdef(x.oid) AS definition,x.convalidated AS valid,x.condeferrable AS deferred FROM pg_constraint x JOIN pg_class t ON t.oid=x.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname='workflow_node_children' LIMIT 32) c) AS constraints`,
    [schema],
  );
  if (rows.length !== 1) corrupt();
  const metadata = rows[0];
  const versions = metadata?.versions;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0]?.singleton !== true ||
    versions[0]?.version !== 1
  )
    throw new RunStoreError("workflow_composition_schema_unsupported");
  if (
    !Array.isArray(metadata.columns) ||
    metadata.columns
      .map(
        (c: { column_name: string; data_type: string; is_nullable: string }) =>
          `${c.column_name}:${c.data_type}${c.is_nullable === "NO" ? "!" : ""}`,
      )
      .join(",") !== POSTGRES_WORKFLOW_CHILD_COLUMNS
  )
    corrupt();
  const constraints: {
    kind: string;
    definition: string;
    valid: boolean;
    deferred: boolean;
  }[] = metadata.constraints;
  if (
    !Array.isArray(constraints) ||
    constraints.length >= 32 ||
    constraints.some((c) => !c.valid || c.deferred) ||
    JSON.stringify(
      constraints
        .filter((c) => c.kind !== "n")
        .map((c) => normalize(c.definition))
        .sort(),
    ) !==
      JSON.stringify(
        postgresWorkflowChildConstraints(schema).map(normalize).sort(),
      )
  )
    corrupt();
  return `"${schema}".workflow_node_children`;
}
function corrupt(): never {
  throw new RunStoreError("workflow_composition_schema_corrupt");
}
