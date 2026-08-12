import {
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  type WorkflowAgentAttemptAuthority,
  type WorkflowNodeContinuationCheckpoint,
} from "@crewon/application";
import type { PoolClient } from "pg";

import {
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import { assertPostgresSchemaNotNewer } from "./postgres-store-support.ts";
import { stableJson } from "./store-invariants.ts";
import { loadPostgresWorkflowExecution } from "./postgres-workflow-run-composition-transactions.ts";

type Row = Readonly<{
  tenant_id: string;
  run_id: string;
  node_id: string;
  attempt_id: string;
  revision: string | number;
  state_json: unknown;
  updated_at: Date | string;
}>;

const COLUMNS = [
  "tenant_id",
  "run_id",
  "node_id",
  "attempt_id",
  "revision",
  "state_json",
  "updated_at",
] as const;

export async function migratePostgresWorkflowNodeContinuations(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await assertPostgresSchemaNotNewer(
    client,
    schema,
    "workflow_node_continuation",
    1,
  );
  const current = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.schema_migrations
     WHERE component='workflow_node_continuation'`,
  );
  if (current.rows[0] !== undefined)
    await assertPhysicalSchema(client, schema, current.rows[0].version);
  await client.query(`
    INSERT INTO ${schema}.schema_migrations(component, version)
      VALUES ('workflow_node_continuation', 1) ON CONFLICT (component) DO NOTHING;
    CREATE TABLE IF NOT EXISTS ${schema}.workflow_node_continuations (
      tenant_id text NOT NULL, run_id text NOT NULL, node_id text NOT NULL,
      attempt_id text NOT NULL,
      revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json)='object'),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, run_id, node_id),
      FOREIGN KEY (tenant_id, run_id, node_id, attempt_id)
        REFERENCES ${schema}.run_attempts(tenant_id, run_id, step_id, attempt_id)
        ON DELETE CASCADE
    );`);
  await assertPhysicalSchema(client, schema, 1);
}

export async function loadPostgresWorkflowNodeContinuation(
  connection: PoolClient,
  schema: string,
  authority: WorkflowAgentAttemptAuthority,
  lock = false,
): Promise<WorkflowNodeContinuationCheckpoint | null> {
  await assertAuthority(connection, schema, authority, lock);
  const result = await connection.query<Row>(
    `SELECT ${COLUMNS.join(",")} FROM ${schema}.workflow_node_continuations
     WHERE tenant_id=$1 AND run_id=$2 AND node_id=$3${lock ? " FOR UPDATE" : ""}`,
    [authority.tenantId, authority.runId, authority.nodeId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  let checkpoint: WorkflowNodeContinuationCheckpoint;
  try {
    checkpoint = validateWorkflowNodeContinuationCheckpoint(row.state_json);
  } catch (error) {
    throw new RunStoreError("workflow_continuation_corrupt", { cause: error });
  }
  if (
    stableJson(checkpoint.authority) !== stableJson(authority) ||
    row.tenant_id !== authority.tenantId ||
    row.run_id !== authority.runId ||
    row.node_id !== authority.nodeId ||
    row.attempt_id !== authority.attempt.attemptId ||
    checkpoint.revision !== Number(row.revision) ||
    Date.parse(checkpoint.updatedAt) !== new Date(row.updated_at).getTime()
  )
    throw new RunStoreError("workflow_continuation_corrupt");
  return checkpoint;
}

export async function writePostgresWorkflowNodeContinuation(
  client: PoolClient,
  schema: string,
  authority: WorkflowAgentAttemptAuthority,
  expectedRevision: number | null,
  next: Omit<WorkflowNodeContinuationCheckpoint, "revision" | "updatedAt">,
  updatedAt: string,
): Promise<WorkflowNodeContinuationCheckpoint> {
  const candidate = validateWorkflowNodeContinuationCheckpoint({
    ...next,
    revision: (expectedRevision ?? 0) + 1,
    updatedAt,
  });
  if (stableJson(candidate.authority) !== stableJson(authority))
    throw new RunStoreError("workflow_continuation_authority_mismatch");
  const current = await loadPostgresWorkflowNodeContinuation(
    client,
    schema,
    authority,
    true,
  );
  if ((current?.revision ?? null) !== expectedRevision)
    throw new RunStoreError("workflow_continuation_revision_mismatch");
  const checkpoint = candidate;
  const result = await client.query(
    `INSERT INTO ${schema}.workflow_node_continuations
       (tenant_id,run_id,node_id,attempt_id,revision,state_json,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (tenant_id,run_id,node_id) DO UPDATE SET
       attempt_id=excluded.attempt_id,revision=excluded.revision,
       state_json=excluded.state_json,updated_at=excluded.updated_at
     WHERE ${schema}.workflow_node_continuations.revision=$8`,
    [
      authority.tenantId,
      authority.runId,
      authority.nodeId,
      authority.attempt.attemptId,
      checkpoint.revision,
      JSON.stringify(checkpoint),
      checkpoint.updatedAt,
      expectedRevision,
    ],
  );
  if (result.rowCount !== 1)
    throw new RunStoreError("workflow_continuation_revision_mismatch");
  return checkpoint;
}

async function assertAuthority(
  connection: PoolClient,
  schema: string,
  authority: WorkflowAgentAttemptAuthority,
  lock: boolean,
): Promise<void> {
  const step = await loadPostgresRunStep(
    connection,
    schema,
    {
      tenantId: authority.tenantId,
      runId: authority.runId,
      stepId: authority.nodeId,
    },
    lock,
  );
  const attempt = await loadPostgresRunAttempt(
    connection,
    schema,
    {
      tenantId: authority.tenantId,
      runId: authority.runId,
      ...authority.attempt,
    },
    lock,
  );
  const execution = await loadPostgresWorkflowExecution(
    connection,
    schema,
    authority,
    lock,
  );
  const node = execution?.nodes.find(
    (item) => item.nodeId === authority.nodeId,
  );
  if (
    authority.attempt.stepId !== authority.nodeId ||
    step?.kind !== authority.nodeKind ||
    step.status !== "running" ||
    step.currentAttemptId !== authority.attempt.attemptId ||
    attempt?.status !== "running" ||
    attempt.workItemId !== authority.workItemId ||
    attempt.leaseEpoch !== authority.leaseEpoch ||
    node?.status !== "running" ||
    node.claimId !== authority.claimId ||
    node.claimEpoch !== authority.claimEpoch ||
    node.agentVersionId !== authority.agentVersionId
  )
    throw new RunStoreError("workflow_continuation_authority_mismatch");
}

async function assertPhysicalSchema(
  client: PoolClient,
  schema: string,
  version: number,
): Promise<void> {
  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema=$1 AND table_name='workflow_node_continuations'
     ORDER BY ordinal_position`,
    [schema.replaceAll('"', "")],
  );
  if (
    version !== 1 ||
    columns.rows.map((row) => row.column_name).join(",") !== COLUMNS.join(",")
  )
    throw new RunStoreError("postgres_schema_version_unsupported");
}
