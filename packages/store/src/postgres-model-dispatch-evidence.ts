import {
  RunStoreError,
  type ObserveModelDispatchResponseInput,
  type PrepareModelDispatchInput,
  type RunAttemptLocator,
  type TerminateModelDispatchInput,
  type TransitionModelDispatchInput,
} from "@crewon/application";
import {
  ModelDispatchReceiptError,
  markModelDispatchPossiblySent,
  observeModelDispatchResponse,
  prepareModelDispatchReceipt,
  terminateModelDispatchReceipt,
  validateModelDispatchReceipt,
  type ModelDispatchReceipt,
} from "@crewon/domain";
import type { Pool, PoolClient } from "pg";

import { loadPostgresRunAttempt } from "./postgres-execution-authority.ts";
import { assertPostgresSchemaNotNewer } from "./postgres-store-support.ts";

type ReceiptRow = Readonly<{
  tenant_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  operation_id: string;
  request_sequence: string | number;
  operation: string;
  work_item_id: string;
  lease_epoch: string | number;
  request_digest: string;
  status: string;
  revision: string | number;
  state_json: unknown;
  prepared_at: Date | string;
  updated_at: Date | string;
}>;

const COLUMNS = `tenant_id, run_id, step_id, attempt_id, operation_id,
  request_sequence, operation, work_item_id, lease_epoch, request_digest,
  status, revision, state_json, prepared_at, updated_at`;

export function postgresModelDispatchEvidenceSchemaSql(schema: string): string {
  return `
    INSERT INTO ${schema}.schema_migrations(component, version)
      VALUES ('model_dispatch_evidence', 1) ON CONFLICT (component) DO NOTHING;
    CREATE TABLE IF NOT EXISTS ${schema}.model_dispatch_receipts (
      tenant_id text NOT NULL, run_id text NOT NULL, step_id text NOT NULL,
      attempt_id text NOT NULL, operation_id text NOT NULL,
      request_sequence bigint NOT NULL CHECK (request_sequence BETWEEN 1 AND 9007199254740991),
      operation text NOT NULL CHECK (operation IN ('dispatch','retrieve')),
      work_item_id text NOT NULL,
      lease_epoch bigint NOT NULL CHECK (lease_epoch BETWEEN 1 AND 9007199254740991),
      request_digest text NOT NULL,
      status text NOT NULL CHECK (status IN ('prepared','possiblySent','responseObserved','terminal')),
      revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
      prepared_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, run_id, step_id, attempt_id, operation_id),
      FOREIGN KEY (tenant_id, run_id, step_id, attempt_id)
        REFERENCES ${schema}.run_attempts(tenant_id, run_id, step_id, attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (work_item_id) REFERENCES ${schema}.work_items(work_item_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS model_dispatch_receipts_run_idx
      ON ${schema}.model_dispatch_receipts(tenant_id, run_id, status, attempt_id, request_sequence);`;
}

export async function migratePostgresModelDispatchEvidence(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await assertPostgresSchemaNotNewer(
    client,
    schema,
    "model_dispatch_evidence",
    1,
  );
  const current = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.schema_migrations WHERE component='model_dispatch_evidence'`,
  );
  if (current.rows[0] !== undefined) {
    await assertPhysicalSchema(client, schema, current.rows[0].version);
  }
  await client.query(postgresModelDispatchEvidenceSchemaSql(schema));
  const result = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.schema_migrations WHERE component='model_dispatch_evidence'`,
  );
  await assertPhysicalSchema(client, schema, result.rows[0]?.version);
}

async function assertPhysicalSchema(
  client: PoolClient,
  schema: string,
  version: number | undefined,
): Promise<void> {
  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema=$1 AND table_name='model_dispatch_receipts'
     ORDER BY ordinal_position`,
    [schema.replaceAll('"', "")],
  );
  if (
    version !== 1 ||
    columns.rows.map((row) => row.column_name).join(",") !==
      COLUMNS.replace(/\s/gu, "").split(",").join(",")
  )
    throw new RunStoreError("postgres_schema_version_unsupported");
}

export async function loadPostgresModelDispatchReceipt(
  connection: Pool | PoolClient,
  schema: string,
  locator: RunAttemptLocator & Readonly<{ operationId: string }>,
  lock = false,
): Promise<ModelDispatchReceipt | null> {
  const result = await connection.query<ReceiptRow>(
    `SELECT ${COLUMNS} FROM ${schema}.model_dispatch_receipts
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt_id=$4
       AND operation_id=$5${lock ? " FOR UPDATE" : ""}`,
    [
      locator.tenantId,
      locator.runId,
      locator.stepId,
      locator.attemptId,
      locator.operationId,
    ],
  );
  return result.rows[0] === undefined ? null : decode(result.rows[0], locator);
}

export async function preparePostgresModelDispatch(
  client: PoolClient,
  schema: string,
  input: PrepareModelDispatchInput,
): Promise<ModelDispatchReceipt> {
  const locator = {
    tenantId: input.tenantId,
    runId: input.runId,
    ...input.attempt,
    operationId: input.operationId,
  };
  const attempt = await requireFencedAttempt(
    client,
    schema,
    locator,
    input.lease,
  );
  const current = await loadPostgresModelDispatchReceipt(
    client,
    schema,
    locator,
    true,
  );
  const next = normalize(() =>
    prepareModelDispatchReceipt(current, {
      ...locator,
      requestSequence: input.requestSequence,
      operation: input.operation,
      workItemId: attempt.workItemId,
      leaseEpoch: attempt.leaseEpoch,
      requestDigest: input.requestDigest,
      provider: input.provider,
      preparedAt: input.preparedAt,
    }),
  );
  if (current === null) {
    await client.query(
      `INSERT INTO ${schema}.model_dispatch_receipts (${COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)`,
      values(next),
    );
  }
  return next;
}

export async function transitionPostgresModelDispatch(
  client: PoolClient,
  schema: string,
  input:
    | TransitionModelDispatchInput
    | ObserveModelDispatchResponseInput
    | TerminateModelDispatchInput,
  kind: "possiblySent" | "responseObserved" | "terminal",
): Promise<ModelDispatchReceipt> {
  const locator = {
    tenantId: input.tenantId,
    runId: input.runId,
    ...input.attempt,
    operationId: input.operationId,
  };
  await requireFencedAttempt(client, schema, locator, input.lease);
  const current = await loadPostgresModelDispatchReceipt(
    client,
    schema,
    locator,
    true,
  );
  if (current === null)
    throw new RunStoreError("model_dispatch_receipt_missing");
  if (current.requestSequence !== input.requestSequence)
    throw new RunStoreError("model_dispatch_receipt_conflict");
  if (
    current.revision !== input.expectedRevision &&
    current.revision !== input.expectedRevision + 1
  )
    throw new RunStoreError("model_dispatch_revision_conflict");
  const next = normalize(() =>
    kind === "possiblySent"
      ? markModelDispatchPossiblySent(current, input.transitionedAt)
      : kind === "responseObserved"
        ? observeModelDispatchResponse(current, {
            checkpointDigest: (input as ObserveModelDispatchResponseInput)
              .checkpointDigest,
            observedAt: input.transitionedAt,
          })
        : terminateModelDispatchReceipt(current, {
            outcome: (input as TerminateModelDispatchInput).outcome,
            terminalAt: input.transitionedAt,
          }),
  );
  if (next === current) return current;
  if (current.revision !== input.expectedRevision)
    throw new RunStoreError("model_dispatch_revision_conflict");
  const updated = await client.query(
    `UPDATE ${schema}.model_dispatch_receipts SET status=$1, revision=$2,
       state_json=$3::jsonb, updated_at=$4
     WHERE tenant_id=$5 AND run_id=$6 AND step_id=$7 AND attempt_id=$8
       AND operation_id=$9 AND revision=$10`,
    [
      next.status,
      next.revision,
      JSON.stringify(next),
      next.updatedAt,
      next.tenantId,
      next.runId,
      next.stepId,
      next.attemptId,
      next.operationId,
      current.revision,
    ],
  );
  if (updated.rowCount !== 1)
    throw new RunStoreError("model_dispatch_revision_conflict");
  return next;
}

async function requireFencedAttempt(
  client: PoolClient,
  schema: string,
  locator: RunAttemptLocator,
  lease: PrepareModelDispatchInput["lease"],
) {
  const attempt = await loadPostgresRunAttempt(client, schema, locator, true);
  if (
    attempt === null ||
    attempt.status !== "running" ||
    attempt.workItemId !== lease.workItemId ||
    attempt.leaseEpoch !== lease.leaseEpoch
  )
    throw new RunStoreError("model_dispatch_attempt_fence_conflict");
  return attempt;
}

function decode(
  row: ReceiptRow,
  locator: RunAttemptLocator & Readonly<{ operationId: string }>,
): ModelDispatchReceipt {
  let parsed: ModelDispatchReceipt;
  try {
    parsed = row.state_json as ModelDispatchReceipt;
    validateModelDispatchReceipt(parsed);
  } catch (error) {
    throw new RunStoreError("stored_model_dispatch_receipt_invalid", {
      cause: error,
    });
  }
  const integer = (value: string | number) => Number(value);
  const timestamp = (value: Date | string) => new Date(value).toISOString();
  if (
    parsed.tenantId !== locator.tenantId ||
    parsed.runId !== locator.runId ||
    parsed.stepId !== locator.stepId ||
    parsed.attemptId !== locator.attemptId ||
    parsed.operationId !== locator.operationId ||
    parsed.operationId !== row.operation_id ||
    parsed.requestSequence !== integer(row.request_sequence) ||
    parsed.operation !== row.operation ||
    parsed.workItemId !== row.work_item_id ||
    parsed.leaseEpoch !== integer(row.lease_epoch) ||
    parsed.requestDigest !== row.request_digest ||
    parsed.status !== row.status ||
    parsed.revision !== integer(row.revision) ||
    timestamp(parsed.preparedAt) !== timestamp(row.prepared_at) ||
    timestamp(parsed.updatedAt) !== timestamp(row.updated_at)
  )
    throw new RunStoreError("stored_model_dispatch_receipt_invalid");
  return parsed;
}

function values(receipt: ModelDispatchReceipt): unknown[] {
  return [
    receipt.tenantId,
    receipt.runId,
    receipt.stepId,
    receipt.attemptId,
    receipt.operationId,
    receipt.requestSequence,
    receipt.operation,
    receipt.workItemId,
    receipt.leaseEpoch,
    receipt.requestDigest,
    receipt.status,
    receipt.revision,
    JSON.stringify(receipt),
    receipt.preparedAt,
    receipt.updatedAt,
  ];
}

function normalize<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ModelDispatchReceiptError)
      throw new RunStoreError(error.code, { cause: error });
    throw error;
  }
}
