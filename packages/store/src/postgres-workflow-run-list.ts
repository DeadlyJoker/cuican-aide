import type { Pool } from "pg";
import {
  ApplicationError,
  RunStoreError,
  type WorkflowRunListStore,
} from "@crewon/application";
import {
  captureWorkflowRunListQuery,
  parseWorkflowRunListResponse,
  formatWorkflowRunListCursor,
  parseRunView,
} from "@crewon/contracts";
import { postgresPublicRunSummaryColumns } from "./thread-transcript-run-snapshot.ts";
import { assertPostgresWorkflowRunAdmissionSchema } from "./postgres-workflow-run-admission-schema.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { validatePostgresSchemaName } from "./postgres-queue-schema.ts";
type Input = Parameters<WorkflowRunListStore["listWorkflowRuns"]>[0];
type Row = {
  run_id: string;
  thread_id: string | null;
  updated_at: string;
  identity_valid: boolean;
  stored_bytes: number;
  run_view: unknown;
};
/** Uses existing admitted-root identities as the candidate set; no ordinary Thread/history enumeration. */
export async function listPostgresWorkflowRuns(
  pool: Pool,
  schema: string,
  input: Input,
) {
  validatePostgresSchemaName(schema);
  const query = captureWorkflowRunListQuery(input.query),
    sql = `"${schema}"`;
  for (const value of [input.tenantId, input.spaceId])
    if (
      typeof value !== "string" ||
      !value.trim() ||
      Buffer.byteLength(value) > 512
    )
      throw new RunStoreError("workflow_read_request_invalid");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const present = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])",
      [
        schema,
        [
          "workflow_run_admission_schema",
          "workflow_run_admissions",
          "workflow_run_inputs",
        ],
      ],
    );
    if (present.rows.length !== 0 && present.rows.length !== 3) corrupt();
    if (present.rows.length === 0) {
      await input.authorizeScope();
      await client.query("COMMIT");
      return { data: [], nextCursor: null };
    }
    await assertPostgresWorkflowRunAdmissionSchema(client, schema);
    const rows = await client.query<Row>(workflowRunListSql(sql), [
      input.tenantId,
      input.spaceId,
      query.workflowVersionId,
      query.threadId,
      query.before?.createdAt ?? null,
      query.before?.runId ?? null,
      query.limit,
    ]);
    const data = [];
    for (const row of rows.rows) {
      if (
        row.identity_valid !== true ||
        !Number.isSafeInteger(row.stored_bytes) ||
        row.stored_bytes < 0 ||
        row.stored_bytes > 65536 ||
        row.thread_id === null
      )
        corrupt();
      const run = parseRunView(row.run_view, row.thread_id);
      if (
        run.runId !== row.run_id ||
        Date.parse(run.updatedAt) !== Date.parse(row.updated_at)
      )
        corrupt();
      await input.authorizeRun({ runId: run.runId, threadId: run.threadId });
      data.push(run);
    }
    const last = data.at(-1);
    const result = parseWorkflowRunListResponse(
      {
        data,
        nextCursor:
          last && data.length === query.limit
            ? formatWorkflowRunListCursor(query, {
                createdAt: last.createdAt,
                runId: last.runId,
              })
            : null,
      },
      query,
    );
    for (const run of result.data)
      await input.authorizeRun({ runId: run.runId, threadId: run.threadId });
    await input.authorizeScope();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackPostgres(client);
    if (error instanceof ApplicationError) throw error;
    throw normalizePostgresError(error);
  } finally {
    client.release();
  }
}
/** Parameterized LATERAL lookup keeps ordinary Run JSON out of the root candidate scan. */
export function workflowRunListSql(sql: string) {
  return `WITH roots AS MATERIALIZED (SELECT tenant_id,run_id FROM ${sql}.workflow_run_admissions WHERE tenant_id=$1), page AS MATERIALIZED (
    SELECT s.run_id,date_trunc('milliseconds',(s.state_json->>'createdAt')::timestamptz) AS created_at FROM roots a
    CROSS JOIN LATERAL (SELECT r.run_id,r.space_id,r.updated_at,r.state_json FROM ${sql}.run_snapshots r WHERE r.tenant_id=a.tenant_id AND r.run_id=a.run_id OFFSET 0) s
    LEFT JOIN ${sql}.run_thread_bindings b ON b.tenant_id=a.tenant_id AND b.run_id=s.run_id
    WHERE s.space_id=$2 AND s.state_json->'workflowVersionBinding'->>'workflowVersionId'=$3
    AND ($4::text IS NULL OR b.thread_id=$4)
    AND ($5::timestamptz IS NULL OR (date_trunc('milliseconds',(s.state_json->>'createdAt')::timestamptz),s.run_id COLLATE "C")<($5::timestamptz,$6 COLLATE "C"))
    ORDER BY date_trunc('milliseconds',(s.state_json->>'createdAt')::timestamptz) DESC,s.run_id COLLATE "C" DESC LIMIT $7
  ) SELECT ${postgresPublicRunSummaryColumns()},b.thread_id,s.updated_at::text
    FROM page p CROSS JOIN LATERAL (SELECT r.* FROM ${sql}.run_snapshots r WHERE r.tenant_id=$1 AND r.run_id=p.run_id OFFSET 0) s
    LEFT JOIN ${sql}.run_thread_bindings b ON b.tenant_id=s.tenant_id AND b.run_id=s.run_id
    ORDER BY p.created_at DESC,s.run_id COLLATE "C" DESC`;
}
function corrupt(): never {
  throw new RunStoreError("workflow_read_authority_corrupt");
}
