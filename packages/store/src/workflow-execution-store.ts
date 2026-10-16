import {
  decodeState,
  validateState,
  validateCas,
  assertTransition,
  assertCreateReplay,
  validateLocator,
  validateReceiptLocator,
} from "./workflow-execution-state.ts";
import { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type WorkflowExecutionReceipt,
  type WorkflowExecutionState,
  type WorkflowExecutionStore,
} from "@crewon/application";
import type { Pool, PoolClient } from "pg";
import { advisoryLock } from "./postgres-thread-lock.ts";
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
    validateState(state);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      assertStandaloneSqliteWorkflowWriter(this.#database, state);
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
          state: decodeState(row.state_json),
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
      assertStandaloneSqliteWorkflowWriter(this.#database, input);
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
        const state = decodeState(replay.state_json);
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

/** Standalone CAS has no execution lease; real Workflow Runs must use atomic composition. */
function assertStandaloneSqliteWorkflowWriter(
  database: DatabaseSync,
  input: { tenantId: string; runId: string },
): void {
  if (
    !database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='run_snapshots' AND type='table'",
      )
      .get()
  )
    return;
  if (
    database
      .prepare(
        "SELECT 1 FROM run_snapshots WHERE tenant_id=? AND run_id=? AND json_extract(state_json,'$.purpose')='workflow'",
      )
      .get(input.tenantId, input.runId)
  )
    throw new RunStoreError("workflow_execution_composition_required");
}

async function assertStandalonePostgresWorkflowWriter(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; runId: string },
): Promise<void> {
  await advisoryLock(client, `run:${input.tenantId}:${input.runId}`);
  const relation = await client.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${schema}.run_snapshots`],
  );
  if (!relation.rows[0]?.present) return;
  const root = await client.query(
    `SELECT 1 FROM "${schema}".run_snapshots WHERE tenant_id=$1 AND run_id=$2 AND state_json->>'purpose'='workflow'`,
    [input.tenantId, input.runId],
  );
  if (root.rows.length)
    throw new RunStoreError("workflow_execution_composition_required");
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
    validateState(state);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await assertStandalonePostgresWorkflowWriter(client, this.#schema, state);
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
          state: decodeState(row.state_json),
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
      await assertStandalonePostgresWorkflowWriter(client, this.#schema, input);
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
        const state = decodeState(replay.state_json);
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
  return row ? decodeState(row.state_json) : null;
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
  return result.rows[0] ? decodeState(result.rows[0].state_json) : null;
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
