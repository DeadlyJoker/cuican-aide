import { DatabaseSync } from "node:sqlite";

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

import { loadSqliteRunAttempt } from "./sqlite-execution-authority.ts";
import { stableJson } from "./store-invariants.ts";

type ReceiptRow = Readonly<{
  tenant_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  operation_id: string;
  request_sequence: number;
  operation: string;
  work_item_id: string;
  lease_epoch: number;
  request_digest: string;
  status: string;
  revision: number;
  state_json: string;
  prepared_at: string;
  updated_at: string;
}>;

const COLUMNS = `tenant_id, run_id, step_id, attempt_id, operation_id, request_sequence, operation, work_item_id,
  lease_epoch, request_digest, status, revision, state_json, prepared_at, updated_at`;

export function sqliteModelDispatchEvidenceTableSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS model_dispatch_receipts (
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_sequence INTEGER NOT NULL CHECK (request_sequence >= 1),
      operation TEXT NOT NULL CHECK (operation IN ('dispatch', 'retrieve')),
      work_item_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
      request_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'possiblySent', 'responseObserved', 'terminal')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      prepared_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, run_id, step_id, attempt_id, operation_id),
      FOREIGN KEY (tenant_id, run_id, step_id, attempt_id)
        REFERENCES run_attempts(tenant_id, run_id, step_id, attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (work_item_id)
        REFERENCES work_items(work_item_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS model_dispatch_receipts_run_idx
      ON model_dispatch_receipts(tenant_id, run_id, status, attempt_id, request_sequence);`;
}

export function migrateSqliteModelDispatchEvidence(
  database: DatabaseSync,
): void {
  database.exec(sqliteModelDispatchEvidenceTableSql());
  assertSqliteModelDispatchEvidenceSchema(database);
}

export function assertSqliteModelDispatchEvidenceSchema(
  database: DatabaseSync,
): void {
  const table = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_dispatch_receipts'",
    )
    .get() as { sql: string } | undefined;
  const columns = database
    .prepare("PRAGMA table_info(model_dispatch_receipts)")
    .all()
    .map((row) => String(row.name));
  const index = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'model_dispatch_receipts_run_idx'",
    )
    .get() as { sql: string } | undefined;
  if (
    table === undefined ||
    !/\)\s*STRICT\s*$/iu.test(table.sql) ||
    !table.sql.includes("responseObserved") ||
    JSON.stringify(columns) !==
      JSON.stringify([
        "tenant_id",
        "run_id",
        "step_id",
        "attempt_id",
        "operation_id",
        "request_sequence",
        "operation",
        "work_item_id",
        "lease_epoch",
        "request_digest",
        "status",
        "revision",
        "state_json",
        "prepared_at",
        "updated_at",
      ]) ||
    index?.sql?.includes(
      "tenant_id, run_id, status, attempt_id, request_sequence",
    ) !== true
  ) {
    throw new RunStoreError("sqlite_schema_version_unsupported");
  }
  const foreignTables = new Set(
    database
      .prepare("PRAGMA foreign_key_list(model_dispatch_receipts)")
      .all()
      .map((row) => String(row.table)),
  );
  if (!foreignTables.has("run_attempts") || !foreignTables.has("work_items")) {
    throw new RunStoreError("sqlite_schema_version_unsupported");
  }
}

export function loadSqliteModelDispatchReceipt(
  database: DatabaseSync,
  locator: RunAttemptLocator & Readonly<{ operationId: string }>,
): ModelDispatchReceipt | null {
  const row = database
    .prepare(
      `SELECT ${COLUMNS} FROM model_dispatch_receipts
       WHERE tenant_id = ? AND run_id = ? AND step_id = ? AND attempt_id = ?
         AND operation_id = ?`,
    )
    .get(
      locator.tenantId,
      locator.runId,
      locator.stepId,
      locator.attemptId,
      locator.operationId,
    ) as ReceiptRow | undefined;
  return row === undefined ? null : decode(row, locator);
}

export function prepareSqliteModelDispatch(
  database: DatabaseSync,
  input: PrepareModelDispatchInput,
): ModelDispatchReceipt {
  const locator = {
    tenantId: input.tenantId,
    runId: input.runId,
    ...input.attempt,
    operationId: input.operationId,
    requestSequence: input.requestSequence,
  };
  const attempt = requireFencedAttempt(database, locator, input.lease);
  const current = loadSqliteModelDispatchReceipt(database, locator);
  const next = normalize(() =>
    prepareModelDispatchReceipt(current, {
      ...locator,
      operation: input.operation,
      workItemId: attempt.workItemId,
      leaseEpoch: attempt.leaseEpoch,
      requestDigest: input.requestDigest,
      provider: input.provider,
      preparedAt: input.preparedAt,
    }),
  );
  if (current === null) insert(database, next);
  return next;
}

export function markSqliteModelDispatchPossiblySent(
  database: DatabaseSync,
  input: TransitionModelDispatchInput,
): ModelDispatchReceipt {
  return transition(database, input, (current) =>
    markModelDispatchPossiblySent(current, input.transitionedAt),
  );
}

export function observeSqliteModelDispatchResponse(
  database: DatabaseSync,
  input: ObserveModelDispatchResponseInput,
): ModelDispatchReceipt {
  return transition(database, input, (current) =>
    observeModelDispatchResponse(current, {
      checkpointDigest: input.checkpointDigest,
      observedAt: input.transitionedAt,
    }),
  );
}

export function terminateSqliteModelDispatch(
  database: DatabaseSync,
  input: TerminateModelDispatchInput,
): ModelDispatchReceipt {
  return transition(database, input, (current) =>
    terminateModelDispatchReceipt(current, {
      outcome: input.outcome,
      terminalAt: input.transitionedAt,
    }),
  );
}

function transition(
  database: DatabaseSync,
  input: TransitionModelDispatchInput,
  mutate: (current: ModelDispatchReceipt) => ModelDispatchReceipt,
): ModelDispatchReceipt {
  const locator = {
    tenantId: input.tenantId,
    runId: input.runId,
    ...input.attempt,
    operationId: input.operationId,
    requestSequence: input.requestSequence,
  };
  requireFencedAttempt(database, locator, input.lease);
  const current = loadSqliteModelDispatchReceipt(database, locator);
  if (current === null)
    throw new RunStoreError("model_dispatch_receipt_missing");
  if (
    current.revision !== input.expectedRevision &&
    current.revision !== input.expectedRevision + 1
  ) {
    throw new RunStoreError("model_dispatch_revision_conflict");
  }
  const next = normalize(() => mutate(current));
  if (next === current) return current;
  if (current.revision !== input.expectedRevision) {
    throw new RunStoreError("model_dispatch_revision_conflict");
  }
  const result = database
    .prepare(
      `UPDATE model_dispatch_receipts
       SET status = ?, revision = ?, state_json = ?, updated_at = ?
       WHERE tenant_id = ? AND run_id = ? AND step_id = ? AND attempt_id = ?
         AND operation_id = ? AND revision = ?`,
    )
    .run(
      next.status,
      next.revision,
      stableJson(next),
      next.updatedAt,
      next.tenantId,
      next.runId,
      next.stepId,
      next.attemptId,
      next.operationId,
      current.revision,
    );
  if (result.changes !== 1)
    throw new RunStoreError("model_dispatch_revision_conflict");
  return next;
}

function requireFencedAttempt(
  database: DatabaseSync,
  locator: RunAttemptLocator,
  lease: PrepareModelDispatchInput["lease"],
) {
  const attempt = loadSqliteRunAttempt(database, locator);
  if (
    attempt === null ||
    attempt.status !== "running" ||
    attempt.workItemId !== lease.workItemId ||
    attempt.leaseEpoch !== lease.leaseEpoch
  ) {
    throw new RunStoreError("model_dispatch_attempt_fence_conflict");
  }
  return attempt;
}

function insert(database: DatabaseSync, receipt: ModelDispatchReceipt): void {
  database
    .prepare(
      `INSERT INTO model_dispatch_receipts (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
      stableJson(receipt),
      receipt.preparedAt,
      receipt.updatedAt,
    );
}

function decode(
  row: ReceiptRow,
  locator: RunAttemptLocator & Readonly<{ operationId: string }>,
): ModelDispatchReceipt {
  let parsed: ModelDispatchReceipt;
  try {
    parsed = JSON.parse(row.state_json) as ModelDispatchReceipt;
    validateModelDispatchReceipt(parsed);
  } catch (error) {
    throw new RunStoreError("stored_model_dispatch_receipt_invalid", {
      cause: error,
    });
  }
  if (
    parsed.tenantId !== locator.tenantId ||
    parsed.runId !== locator.runId ||
    parsed.stepId !== locator.stepId ||
    parsed.attemptId !== locator.attemptId ||
    parsed.operationId !== locator.operationId ||
    parsed.operationId !== row.operation_id ||
    parsed.requestSequence !== row.request_sequence ||
    parsed.operation !== row.operation ||
    parsed.workItemId !== row.work_item_id ||
    parsed.leaseEpoch !== row.lease_epoch ||
    parsed.requestDigest !== row.request_digest ||
    parsed.status !== row.status ||
    parsed.revision !== row.revision ||
    parsed.preparedAt !== row.prepared_at ||
    parsed.updatedAt !== row.updated_at
  ) {
    throw new RunStoreError("stored_model_dispatch_receipt_invalid");
  }
  return parsed;
}

function normalize<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ModelDispatchReceiptError) {
      throw new RunStoreError(error.code, { cause: error });
    }
    throw error;
  }
}
