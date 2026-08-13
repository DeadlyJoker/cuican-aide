import {
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  type CommitWorkflowToolContinuationInput,
  type WorkflowAgentAttemptAuthority,
  type WorkflowNodeContinuationCheckpoint,
} from "@crewon/application";
import { parseCanonicalAgentEvent } from "@crewon/contracts/runtime";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { PoolClient } from "pg";

import {
  finishPostgresRunAttempt,
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import {
  loadPostgresToolExecutionReceipt,
  updatePostgresToolExecutionReceipt,
} from "./postgres-tool-execution.ts";
import { assertPostgresSchemaNotNewer } from "./postgres-store-support.ts";
import {
  applyToolExecutionTransition,
  stableJson,
} from "./store-invariants.ts";
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
    2,
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
    );
    CREATE TABLE IF NOT EXISTS ${schema}.workflow_agent_events (
      tenant_id text NOT NULL, run_id text NOT NULL, node_id text NOT NULL,
      attempt_id text NOT NULL, segment_id text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
      event_type text NOT NULL, event_json jsonb NOT NULL CHECK (jsonb_typeof(event_json)='object'),
      PRIMARY KEY (tenant_id,run_id,node_id,attempt_id,segment_id,sequence),
      FOREIGN KEY (tenant_id,run_id,node_id,attempt_id)
        REFERENCES ${schema}.run_attempts(tenant_id,run_id,step_id,attempt_id) ON DELETE CASCADE
    );
    UPDATE ${schema}.schema_migrations SET version=2
      WHERE component='workflow_node_continuation' AND version=1;`);
  await assertPhysicalSchema(client, schema, 2);
}

export async function commitPostgresWorkflowToolContinuation(
  client: PoolClient,
  schema: string,
  input: CommitWorkflowToolContinuationInput,
  digester: WorkflowContentDigester,
): Promise<
  Readonly<{
    receipt: import("@crewon/domain").ToolExecutionReceiptState;
    continuation: WorkflowNodeContinuationCheckpoint;
  }>
> {
  const event = parseCanonicalAgentEvent(input.completedEvent);
  if (
    event.type !== "tool.completed" ||
    event.runId !== input.authority.runId ||
    event.segmentId !== input.receipt.call.segmentId ||
    event.data.callId !== input.receipt.call.callId ||
    event.data.kind !== input.receipt.call.kind ||
    event.data.name !== input.receipt.call.name
  )
    throw new RunStoreError("workflow_tool_continuation_mismatch");
  await assertAuthority(client, schema, input.authority, true);
  const current = await loadPostgresToolExecutionReceipt(
    client,
    schema,
    input.receipt,
    true,
  );
  if (
    current === null ||
    (current.status !== "completed" &&
      stableJson(current) !== stableJson(input.receipt)) ||
    (current.status === "completed" &&
      current.revision !== input.receipt.revision + 1) ||
    current.stepId !== input.toolAttempt.stepId ||
    current.attemptId !== input.toolAttempt.attemptId ||
    current.workItemId !== input.lease.workItemId
  )
    throw new RunStoreError("workflow_tool_receipt_mismatch");
  const result = {
    output: input.completedEvent.data.output,
    outputDigest: digester.sha256(input.completedEvent.data.output),
    isError: input.completedEvent.data.isError,
    artifactRef: input.completedEvent.data.artifactRef,
  };
  let receipt = current;
  if (current.status !== "completed") {
    receipt = applyToolExecutionTransition(current, {
      tenantId: current.tenantId,
      runId: current.runId,
      receiptId: current.receiptId,
      lease: input.lease,
      expectedRevision: current.revision,
      transition: {
        kind: "complete",
        occurredAt: input.committedAt,
        providerReceiptId: input.providerReceiptId,
        result,
      },
    });
    await finishPostgresRunAttempt(client, schema, {
      tenantId: input.authority.tenantId,
      runId: input.authority.runId,
      workItemId: input.lease.workItemId,
      leaseEpoch: input.lease.leaseEpoch,
      attempt: {
        ...input.toolAttempt,
        status: "completed",
        finishedAt: input.committedAt,
        checkpointDigest: null,
      },
    });
    await updatePostgresToolExecutionReceipt(client, schema, current, receipt);
    await client.query(
      `INSERT INTO ${schema}.workflow_agent_events
       (tenant_id,run_id,node_id,attempt_id,segment_id,sequence,event_type,event_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        input.authority.tenantId,
        input.authority.runId,
        input.authority.nodeId,
        input.authority.attempt.attemptId,
        event.segmentId,
        event.sequence,
        event.type,
        JSON.stringify(input.completedEvent),
      ],
    );
  } else {
    await validateToolReplay(client, schema, input, current, result);
  }
  const continuation = await writePostgresWorkflowNodeContinuation(
    client,
    schema,
    input.authority,
    input.expectedContinuationRevision,
    { ...input.next, terminalCandidate: null },
    input.committedAt,
  );
  return { receipt, continuation };
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
  if (
    current?.revision === (expectedRevision ?? 0) + 1 &&
    stableJson(current) === stableJson(candidate)
  )
    return current;
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

async function validateToolReplay(
  client: PoolClient,
  schema: string,
  input: CommitWorkflowToolContinuationInput,
  receipt: import("@crewon/domain").ToolExecutionReceiptState,
  result: import("@crewon/domain").ToolExecutionResult,
): Promise<void> {
  const attempt = await loadPostgresRunAttempt(
    client,
    schema,
    {
      tenantId: input.authority.tenantId,
      runId: input.authority.runId,
      ...input.toolAttempt,
    },
    true,
  );
  const event = await client.query<{
    segment_id: string;
    sequence: string | number;
    event_type: string;
    event_json: unknown;
  }>(
    `SELECT segment_id,sequence,event_type,event_json FROM ${schema}.workflow_agent_events
     WHERE tenant_id=$1 AND run_id=$2 AND node_id=$3 AND attempt_id=$4
       AND segment_id=$5 AND sequence=$6 FOR UPDATE`,
    [
      input.authority.tenantId,
      input.authority.runId,
      input.authority.nodeId,
      input.authority.attempt.attemptId,
      input.completedEvent.segmentId,
      input.completedEvent.sequence,
    ],
  );
  const row = event.rows[0];
  if (
    receipt.revision !== input.receipt.revision + 1 ||
    receipt.providerReceiptId !== input.providerReceiptId ||
    receipt.resolvedAt !== input.committedAt ||
    stableJson(receipt.result) !== stableJson(result) ||
    attempt?.status !== "completed" ||
    attempt.workItemId !== input.lease.workItemId ||
    attempt.leaseEpoch !== input.lease.leaseEpoch ||
    attempt.terminalAt !== input.committedAt ||
    row?.segment_id !== input.completedEvent.segmentId ||
    Number(row.sequence) !== input.completedEvent.sequence ||
    row.event_type !== "tool.completed" ||
    stableJson(row.event_json) !== stableJson(input.completedEvent)
  )
    throw new RunStoreError("workflow_tool_continuation_replay_conflict");
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
  const events = await client.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${schema.replaceAll('"', "")}.workflow_agent_events`],
  );
  if (
    (version !== 1 && version !== 2) ||
    (version === 2 && events.rows[0]?.present !== true) ||
    columns.rows.map((row) => row.column_name).join(",") !== COLUMNS.join(",")
  )
    throw new RunStoreError("postgres_schema_version_unsupported");
}
