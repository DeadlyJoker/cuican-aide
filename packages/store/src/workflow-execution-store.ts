import { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type WorkflowExecutionReceipt,
  type WorkflowExecutionState,
  type WorkflowExecutionStore,
} from "@crewon/application";
import type { Pool, PoolClient } from "pg";
import {
  migratePostgresWorkflowExecutions,
  migrateSqliteWorkflowExecutions,
} from "./workflow-execution-schema.ts";

export class SqliteWorkflowExecutionStore implements WorkflowExecutionStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
    migrateSqliteWorkflowExecutions(database);
  }

  async createWorkflowExecution(state: WorkflowExecutionState) {
    validateWorkflowExecutionState(state);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const inserted = this.#database
        .prepare(
          `INSERT INTO workflow_executions
           (tenant_id, run_id, revision, state_json, updated_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(
          state.tenantId,
          state.runId,
          state.revision,
          stableJson(state),
          state.updatedAt,
        );
      const stored = loadSqlite(this.#database, state.tenantId, state.runId);
      if (!stored) throw new RunStoreError("workflow_execution_store_failed");
      assertCreateReplay(stored, state);
      this.#database.exec("COMMIT");
      return {
        disposition:
          inserted.changes === 1 ? ("created" as const) : ("existing" as const),
        state: stored,
      };
    } catch (error) {
      rollbackSqlite(this.#database);
      throw normalize(error);
    }
  }

  async loadWorkflowExecution(input: { tenantId: string; runId: string }) {
    validateLocator(input);
    try {
      return loadSqlite(this.#database, input.tenantId, input.runId);
    } catch (error) {
      throw normalize(error);
    }
  }

  async loadWorkflowExecutionReceipt(input: {
    tenantId: string;
    runId: string;
    operationId: string;
  }) {
    validateReceiptLocator(input);
    const row = this.#database
      .prepare(
        `SELECT fingerprint, state_json FROM workflow_execution_receipts
         WHERE tenant_id=? AND run_id=? AND operation_id=?`,
      )
      .get(input.tenantId, input.runId, input.operationId) as
      | { fingerprint: string; state_json: string }
      | undefined;
    return row
      ? {
          operationId: input.operationId,
          fingerprint: row.fingerprint,
          state: decodeWorkflowExecutionState(row.state_json),
        }
      : null;
  }

  async compareAndSwapWorkflowExecution(
    input: Parameters<
      WorkflowExecutionStore["compareAndSwapWorkflowExecution"]
    >[0],
  ) {
    validateCas(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#database
        .prepare(
          `SELECT fingerprint, state_json FROM workflow_execution_receipts
           WHERE tenant_id = ? AND run_id = ? AND operation_id = ?`,
        )
        .get(input.tenantId, input.runId, input.receipt.operationId) as
        | { fingerprint: string; state_json: string }
        | undefined;
      if (replay) {
        if (replay.fingerprint !== input.receipt.fingerprint)
          throw new RunStoreError("workflow_execution_idempotency_conflict");
        const state = decodeWorkflowExecutionState(replay.state_json);
        this.#database.exec("COMMIT");
        return { disposition: "replayed" as const, state };
      }
      const current = loadSqlite(this.#database, input.tenantId, input.runId);
      if (!current) throw new RunStoreError("workflow_execution_not_found");
      if (current.revision !== input.expectedRevision) {
        this.#database.exec("COMMIT");
        return { disposition: "conflict" as const, state: current };
      }
      assertTransition(current, input.next);
      const updated = this.#database
        .prepare(
          `UPDATE workflow_executions
           SET revision = ?, state_json = ?, updated_at = ?
           WHERE tenant_id = ? AND run_id = ? AND revision = ?`,
        )
        .run(
          input.next.revision,
          stableJson(input.next),
          input.next.updatedAt,
          input.tenantId,
          input.runId,
          input.expectedRevision,
        );
      if (updated.changes !== 1)
        throw new RunStoreError("workflow_execution_revision_conflict");
      this.#database
        .prepare(
          `INSERT INTO workflow_execution_receipts
           (tenant_id, run_id, operation_id, fingerprint, state_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.runId,
          input.receipt.operationId,
          input.receipt.fingerprint,
          stableJson(input.next),
        );
      this.#database.exec("COMMIT");
      return { disposition: "committed" as const, state: input.next };
    } catch (error) {
      rollbackSqlite(this.#database);
      throw normalize(error);
    }
  }
}

export class PostgresWorkflowExecutionStore implements WorkflowExecutionStore {
  readonly #pool: Pool;
  readonly #schema: string;

  constructor(pool: Pool, schema: string) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema))
      throw new RunStoreError("postgres_schema_invalid");
    this.#pool = pool;
    this.#schema = schema;
  }

  async migrate(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await migratePostgresWorkflowExecutions(client, this.#schema);
      await client.query("COMMIT");
    } catch (error) {
      await rollbackPostgres(client);
      throw normalize(error);
    } finally {
      client.release();
    }
  }

  async createWorkflowExecution(state: WorkflowExecutionState) {
    validateWorkflowExecutionState(state);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO ${this.#schema}.workflow_executions
         (tenant_id, run_id, revision, state_json, updated_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [state.tenantId, state.runId, state.revision, state, state.updatedAt],
      );
      const stored = await loadPostgres(
        client,
        this.#schema,
        state.tenantId,
        state.runId,
      );
      if (!stored) throw new RunStoreError("workflow_execution_store_failed");
      assertCreateReplay(stored, state);
      await client.query("COMMIT");
      return {
        disposition:
          inserted.rowCount === 1
            ? ("created" as const)
            : ("existing" as const),
        state: stored,
      };
    } catch (error) {
      await rollbackPostgres(client);
      throw normalize(error);
    } finally {
      client.release();
    }
  }

  async loadWorkflowExecution(input: { tenantId: string; runId: string }) {
    validateLocator(input);
    try {
      return await loadPostgres(
        this.#pool,
        this.#schema,
        input.tenantId,
        input.runId,
      );
    } catch (error) {
      throw normalize(error);
    }
  }

  async loadWorkflowExecutionReceipt(input: {
    tenantId: string;
    runId: string;
    operationId: string;
  }) {
    validateReceiptLocator(input);
    const result = await this.#pool.query<{
      fingerprint: string;
      state_json: unknown;
    }>(
      `SELECT fingerprint, state_json FROM ${this.#schema}.workflow_execution_receipts
       WHERE tenant_id=$1 AND run_id=$2 AND operation_id=$3`,
      [input.tenantId, input.runId, input.operationId],
    );
    const row = result.rows[0];
    return row
      ? {
          operationId: input.operationId,
          fingerprint: row.fingerprint,
          state: decodeWorkflowExecutionState(row.state_json),
        }
      : null;
  }

  async compareAndSwapWorkflowExecution(
    input: Parameters<
      WorkflowExecutionStore["compareAndSwapWorkflowExecution"]
    >[0],
  ) {
    validateCas(input);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const receipt = await client.query<{
        fingerprint: string;
        state_json: unknown;
      }>(
        `SELECT fingerprint, state_json FROM ${this.#schema}.workflow_execution_receipts
         WHERE tenant_id=$1 AND run_id=$2 AND operation_id=$3`,
        [input.tenantId, input.runId, input.receipt.operationId],
      );
      const replay = receipt.rows[0];
      if (replay) {
        if (replay.fingerprint !== input.receipt.fingerprint)
          throw new RunStoreError("workflow_execution_idempotency_conflict");
        const state = decodeWorkflowExecutionState(replay.state_json);
        await client.query("COMMIT");
        return { disposition: "replayed" as const, state };
      }
      const current = await loadPostgres(
        client,
        this.#schema,
        input.tenantId,
        input.runId,
        true,
      );
      if (!current) throw new RunStoreError("workflow_execution_not_found");
      if (current.revision !== input.expectedRevision) {
        await client.query("COMMIT");
        return { disposition: "conflict" as const, state: current };
      }
      assertTransition(current, input.next);
      const updated = await client.query(
        `UPDATE ${this.#schema}.workflow_executions
         SET revision=$1, state_json=$2, updated_at=$3
         WHERE tenant_id=$4 AND run_id=$5 AND revision=$6`,
        [
          input.next.revision,
          input.next,
          input.next.updatedAt,
          input.tenantId,
          input.runId,
          input.expectedRevision,
        ],
      );
      if (updated.rowCount !== 1)
        throw new RunStoreError("workflow_execution_revision_conflict");
      await client.query(
        `INSERT INTO ${this.#schema}.workflow_execution_receipts
         (tenant_id, run_id, operation_id, fingerprint, state_json)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          input.tenantId,
          input.runId,
          input.receipt.operationId,
          input.receipt.fingerprint,
          input.next,
        ],
      );
      await client.query("COMMIT");
      return { disposition: "committed" as const, state: input.next };
    } catch (error) {
      await rollbackPostgres(client);
      throw normalize(error);
    } finally {
      client.release();
    }
  }
}

function loadSqlite(database: DatabaseSync, tenantId: string, runId: string) {
  const row = database
    .prepare(
      `SELECT state_json FROM workflow_executions WHERE tenant_id=? AND run_id=?`,
    )
    .get(tenantId, runId) as { state_json: string } | undefined;
  return row ? decodeWorkflowExecutionState(row.state_json) : null;
}

async function loadPostgres(
  client: Pool | PoolClient,
  schema: string,
  tenantId: string,
  runId: string,
  forUpdate = false,
) {
  const result = await client.query<{ state_json: unknown }>(
    `SELECT state_json FROM ${schema}.workflow_executions
     WHERE tenant_id=$1 AND run_id=$2${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, runId],
  );
  return result.rows[0]
    ? decodeWorkflowExecutionState(result.rows[0].state_json)
    : null;
}

export function decodeWorkflowExecutionState(
  input: unknown,
): WorkflowExecutionState {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new RunStoreError("workflow_execution_store_corrupt", {
        cause: error,
      });
    }
  }
  validateWorkflowExecutionState(value);
  return structuredClone(value);
}

export function validateWorkflowExecutionState(
  input: unknown,
): asserts input is WorkflowExecutionState {
  if (!plain(input))
    throw new RunStoreError("workflow_execution_state_invalid");
  const state = input as unknown as WorkflowExecutionState;
  if (
    !exactKeys(state, [
      "cancelRequested",
      "nodes",
      "revision",
      "runId",
      "schemaVersion",
      "status",
      "tenantId",
      "updatedAt",
      "workflowId",
      "contentDigest",
      "workflowVersionId",
    ]) ||
    state.schemaVersion !== "crewon.workflow-execution.v0" ||
    !boundedId(state.tenantId) ||
    !boundedId(state.runId) ||
    !boundedId(state.workflowId) ||
    !boundedId(state.workflowVersionId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(state.contentDigest) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1 ||
    !["running", "waitingHuman", "completed", "failed", "canceled"].includes(
      state.status,
    ) ||
    typeof state.cancelRequested !== "boolean" ||
    !canonicalUtc(state.updatedAt) ||
    !Array.isArray(state.nodes) ||
    state.nodes.length < 1 ||
    state.nodes.length > 64 ||
    new Set(state.nodes.map((node) => node.nodeId)).size !== state.nodes.length
  )
    throw new RunStoreError("workflow_execution_state_invalid");
  for (const node of state.nodes) validateNode(node);
  const active = state.nodes.some(
    (node) => node.status === "running" || node.status === "unknown",
  );
  const projected =
    state.cancelRequested && !active
      ? "canceled"
      : state.nodes.some((node) => node.status === "failed")
        ? "failed"
        : state.nodes.every((node) => node.status === "completed")
          ? "completed"
          : state.nodes.some((node) => node.status === "waitingHuman") &&
              !active
            ? "waitingHuman"
            : "running";
  if (state.status !== projected)
    throw new RunStoreError("workflow_execution_state_invalid");
}

function validateNode(node: unknown): void {
  if (!plain(node)) throw new RunStoreError("workflow_execution_state_invalid");
  const value = node as unknown as WorkflowExecutionState["nodes"][number];
  if (
    !exactKeys(value, [
      "agentVersionId",
      "claimEpoch",
      "claimId",
      "claimOperationId",
      "failureCode",
      "gateRequestId",
      "inputDigest",
      "kind",
      "leaseExpiresAt",
      "nodeId",
      "resultDigest",
      "status",
    ]) ||
    !boundedId(value.nodeId) ||
    !["agent", "humanGate", "verification"].includes(value.kind) ||
    (value.agentVersionId !== null && !boundedId(value.agentVersionId)) ||
    (value.kind === "humanGate") !== (value.agentVersionId === null) ||
    ![
      "pending",
      "running",
      "waitingHuman",
      "completed",
      "failed",
      "canceled",
      "unknown",
    ].includes(value.status) ||
    !Number.isSafeInteger(value.claimEpoch) ||
    value.claimEpoch < 0 ||
    (value.claimId !== null && !boundedId(value.claimId)) ||
    (value.claimOperationId !== null && !boundedId(value.claimOperationId)) ||
    (value.gateRequestId !== null && !boundedId(value.gateRequestId)) ||
    (value.inputDigest !== null &&
      !/^sha256:[a-f0-9]{64}$/u.test(value.inputDigest)) ||
    (value.leaseExpiresAt !== null && !canonicalUtc(value.leaseExpiresAt)) ||
    (value.resultDigest !== null &&
      !/^sha256:[a-f0-9]{64}$/u.test(value.resultDigest)) ||
    (value.failureCode !== null && !boundedId(value.failureCode))
  )
    throw new RunStoreError("workflow_execution_state_invalid");
  const unclaimed = value.status === "pending";
  const active =
    value.status === "running" ||
    value.status === "waitingHuman" ||
    value.status === "unknown";
  if (
    (unclaimed &&
      (value.claimId !== null ||
        value.claimOperationId !== null ||
        value.claimEpoch !== 0 ||
        value.inputDigest !== null)) ||
    (active &&
      (value.claimId === null ||
        value.claimOperationId === null ||
        value.claimEpoch < 1 ||
        value.inputDigest === null)) ||
    (value.status === "running") !== (value.leaseExpiresAt !== null) ||
    (value.status === "waitingHuman" && value.gateRequestId === null) ||
    (value.kind !== "humanGate" && value.gateRequestId !== null) ||
    (value.status === "completed") !== (value.resultDigest !== null) ||
    (value.status === "failed") !== (value.failureCode !== null) ||
    ((value.status === "canceled" || value.status === "unknown") &&
      (value.resultDigest !== null || value.failureCode !== null))
  )
    throw new RunStoreError("workflow_execution_state_invalid");
}

function validateCas(
  input: Parameters<
    WorkflowExecutionStore["compareAndSwapWorkflowExecution"]
  >[0],
): void {
  validateLocator(input);
  validateWorkflowExecutionState(input.next);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    input.next.revision !== input.expectedRevision + 1 ||
    !boundedId(input.receipt.operationId) ||
    typeof input.receipt.fingerprint !== "string" ||
    Buffer.byteLength(input.receipt.fingerprint) > 4096
  )
    throw new RunStoreError("workflow_execution_cas_invalid");
}

function assertTransition(
  current: WorkflowExecutionState,
  next: WorkflowExecutionState,
): void {
  if (
    current.tenantId !== next.tenantId ||
    current.runId !== next.runId ||
    current.workflowId !== next.workflowId ||
    current.workflowVersionId !== next.workflowVersionId ||
    current.contentDigest !== next.contentDigest ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    (current.cancelRequested && !next.cancelRequested) ||
    current.nodes.length !== next.nodes.length ||
    current.nodes.some(
      (node, index) =>
        node.nodeId !== next.nodes[index]?.nodeId ||
        node.kind !== next.nodes[index]?.kind ||
        node.agentVersionId !== next.nodes[index]?.agentVersionId,
    )
  )
    throw new RunStoreError("workflow_execution_authority_mismatch");
  for (const [index, node] of current.nodes.entries()) {
    const candidate = next.nodes[index]!;
    if (!validNodeTransition(node, candidate))
      throw new RunStoreError("workflow_execution_transition_invalid");
  }
}

function validNodeTransition(
  current: WorkflowExecutionState["nodes"][number],
  next: WorkflowExecutionState["nodes"][number],
): boolean {
  if (stableJson(current) === stableJson(next)) return true;
  if (current.status === "pending")
    return (
      next.status === "running" ||
      next.status === "waitingHuman" ||
      next.status === "canceled"
    );
  if (current.status === "running")
    return ["completed", "failed", "canceled", "unknown"].includes(next.status);
  if (current.status === "waitingHuman" || current.status === "unknown")
    return ["completed", "failed", "canceled", "unknown"].includes(next.status);
  return false;
}

function assertCreateReplay(
  current: WorkflowExecutionState,
  requested: WorkflowExecutionState,
): void {
  if (
    current.tenantId !== requested.tenantId ||
    current.runId !== requested.runId ||
    current.workflowId !== requested.workflowId ||
    current.workflowVersionId !== requested.workflowVersionId ||
    current.contentDigest !== requested.contentDigest ||
    current.nodes.length !== requested.nodes.length ||
    current.nodes.some(
      (node, index) =>
        node.nodeId !== requested.nodes[index]?.nodeId ||
        node.kind !== requested.nodes[index]?.kind ||
        node.agentVersionId !== requested.nodes[index]?.agentVersionId,
    )
  )
    throw new RunStoreError("workflow_execution_create_conflict");
}

function validateLocator(input: { tenantId: string; runId: string }): void {
  if (!plain(input) || !boundedId(input.tenantId) || !boundedId(input.runId))
    throw new RunStoreError("workflow_execution_locator_invalid");
}

function validateReceiptLocator(input: {
  tenantId: string;
  runId: string;
  operationId: string;
}): void {
  validateLocator(input);
  if (!boundedId(input.operationId))
    throw new RunStoreError("workflow_execution_receipt_locator_invalid");
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= 512 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function canonicalUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function normalize(error: unknown): Error {
  return error instanceof RunStoreError
    ? error
    : new RunStoreError("workflow_execution_store_failed", {
        cause: error instanceof Error ? error : undefined,
      });
}

function rollbackSqlite(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    /* no active transaction */
  }
}

async function rollbackPostgres(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* preserve original error */
  }
}
