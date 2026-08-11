import type { Pool, PoolClient } from "pg";

import {
  RunStoreError,
  type IdempotencyDescriptor,
  type PrepareWorkspaceReadFileActionInput,
  type PrepareWorkspaceReadFileInput,
  type WorkspaceReadFileLocator,
  type WorkspaceReadFileMutationResult,
  type WorkspaceReadFileReceiptQuery,
  type WorkspaceReadFileRecord,
  type WorkspaceReadFileStore,
} from "@crewon/application";

import {
  exactResolution,
  validateFrozenWorkspaceReadFileDispatch,
  validateWorkspaceReadFileLocator,
  validateWorkspaceReadFileRecord,
  withResolution,
} from "./workspace-read-file-store-support.ts";

type OperationRow = { record_json: WorkspaceReadFileRecord };
type ReceiptRow = { request_fingerprint: string; execution_id: string };

export class PostgresWorkspaceReadFileStore implements WorkspaceReadFileStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #schemaSql: string;

  constructor(pool: Pool, schema: string) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) throw new RunStoreError("postgres_schema_invalid");
    this.#pool = pool;
    this.#schema = schema;
    this.#schemaSql = `"${schema}"`;
  }

  async initialize() {
    await this.#pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.#schemaSql};
      CREATE TABLE IF NOT EXISTS ${this.#schemaSql}.workspace_read_file_operations (
        tenant_id text NOT NULL, space_id text NOT NULL, execution_id text NOT NULL,
        record_json jsonb NOT NULL, PRIMARY KEY (tenant_id, space_id, execution_id)
      );
      CREATE TABLE IF NOT EXISTS ${this.#schemaSql}.workspace_read_file_receipts (
        tenant_id text NOT NULL, space_id text NOT NULL, phase text NOT NULL,
        idempotency_scope text NOT NULL, idempotency_key text NOT NULL,
        request_fingerprint text NOT NULL, execution_id text NOT NULL,
        PRIMARY KEY (tenant_id, space_id, phase, idempotency_scope, idempotency_key),
        FOREIGN KEY (tenant_id, space_id, execution_id)
          REFERENCES ${this.#schemaSql}.workspace_read_file_operations (tenant_id, space_id, execution_id)
      )`);
  }

  async loadWorkspaceReadFileReceipt(query: WorkspaceReadFileReceiptQuery) {
    const receipt = await this.#receipt(this.#pool, query.tenantId, query.spaceId, query.phase, query.idempotency);
    if (receipt === null) return null;
    fingerprint(receipt, query.idempotency);
    return result("replayed", await this.#required(this.#pool, query.tenantId, query.spaceId, receipt.execution_id));
  }

  async prepareWorkspaceReadFile(input: PrepareWorkspaceReadFileInput) {
    return this.#transaction(async (client) => {
      const locator = validateWorkspaceReadFileLocator(locatorOf(input));
      const receipt = await this.#receipt(client, locator.tenantId, locator.spaceId, "execute", input.idempotency);
      if (receipt !== null) {
        fingerprint(receipt, input.idempotency);
        return result("replayed", await this.#required(client, locator.tenantId, locator.spaceId, receipt.execution_id, true));
      }
      const frozen = validateFrozenWorkspaceReadFileDispatch(input.frozen);
      const existing = await this.#load(client, locator.tenantId, locator.spaceId, locator.executionId, true);
      if (existing !== null) {
        if (JSON.stringify(existing.frozen) !== JSON.stringify(frozen)) conflict();
        await this.#insertReceipt(client, locator, "execute", input.idempotency);
        return result("replayed", existing);
      }
      const operation = validateWorkspaceReadFileRecord({
        schemaVersion: "crewon.workspace-read-file-operation.v0", ...locator,
        revision: 1, status: "prepared", frozen, resolution: null,
      });
      await client.query(`INSERT INTO ${this.#schemaSql}.workspace_read_file_operations
        (tenant_id, space_id, execution_id, record_json) VALUES ($1, $2, $3, $4::jsonb)`,
      [locator.tenantId, locator.spaceId, locator.executionId, JSON.stringify(operation)]);
      await this.#insertReceipt(client, locator, "execute", input.idempotency);
      return result("committed", operation);
    });
  }

  async prepareWorkspaceReadFileAction(input: PrepareWorkspaceReadFileActionInput) {
    return this.#transaction(async (client) => {
      const locator = validateWorkspaceReadFileLocator(locatorOf(input));
      const operation = await this.#required(client, locator.tenantId, locator.spaceId, locator.executionId, true);
      const receipt = await this.#receipt(client, locator.tenantId, locator.spaceId, input.phase, input.idempotency);
      if (receipt !== null) {
        fingerprint(receipt, input.idempotency);
        return result("replayed", await this.#required(client, locator.tenantId, locator.spaceId, receipt.execution_id));
      }
      await this.#insertReceipt(client, locator, input.phase, input.idempotency);
      return result("committed", operation);
    });
  }

  async markWorkspaceReadFilePossiblySent(input: WorkspaceReadFileLocator & { expectedRevision: number }) {
    return this.#transaction(async (client) => {
      const current = await this.#expected(client, input);
      if (current.resolution !== null || current.status === "possiblySent") return current;
      const next = validateWorkspaceReadFileRecord({ ...current, revision: current.revision + 1, status: "possiblySent" });
      await this.#update(client, input, current.revision, next);
      return next;
    });
  }

  async abandonWorkspaceReadFileSend(input: WorkspaceReadFileLocator & { expectedRevision: number }) {
    return this.#transaction(async (client) => {
      const current = await this.#expected(client, input);
      if (current.status !== "possiblySent" || current.resolution !== null) conflict();
      const next = validateWorkspaceReadFileRecord({ ...current, revision: current.revision + 1, status: "prepared" });
      await this.#update(client, input, current.revision, next);
      return next;
    });
  }

  async commitWorkspaceReadFileResolution(input: Parameters<WorkspaceReadFileStore["commitWorkspaceReadFileResolution"]>[0]) {
    return this.#transaction(async (client) => {
      const current = await this.#required(client, input.tenantId, input.spaceId, input.executionId, true);
      if (current.resolution !== null) {
        const parsed = exactResolution(current, input.phase, input.resolution);
        if (JSON.stringify(parsed) !== JSON.stringify(current.resolution)) conflict();
        return result("replayed", current);
      }
      if (current.revision !== input.expectedRevision && current.status !== "possiblySent") conflict();
      const next = withResolution(current, exactResolution(current, input.phase, input.resolution));
      await this.#update(client, input, current.revision, next);
      const receipt = await this.#receipt(client, input.tenantId, input.spaceId, input.phase, input.idempotency);
      if (receipt !== null) fingerprint(receipt, input.idempotency);
      else await this.#insertReceipt(client, input, input.phase, input.idempotency);
      return result("committed", next);
    });
  }

  async #load(client: Pool | PoolClient, tenantId: string, spaceId: string, executionId: string, lock = false) {
    const rows = await client.query<OperationRow>(`SELECT record_json FROM ${this.#schemaSql}.workspace_read_file_operations
      WHERE tenant_id = $1 AND space_id = $2 AND execution_id = $3${lock ? " FOR UPDATE" : ""}`,
    [tenantId, spaceId, executionId]);
    return rows.rows[0] === undefined ? null : validateWorkspaceReadFileRecord(rows.rows[0].record_json);
  }
  async #required(client: Pool | PoolClient, tenantId: string, spaceId: string, executionId: string, lock = false) {
    const value = await this.#load(client, tenantId, spaceId, executionId, lock);
    if (value === null) throw new RunStoreError("workspace_read_file_not_found");
    return value;
  }
  async #expected(client: PoolClient, input: WorkspaceReadFileLocator & { expectedRevision: number }) {
    const current = await this.#required(client, input.tenantId, input.spaceId, input.executionId, true);
    if (current.revision !== input.expectedRevision) conflict();
    return current;
  }
  async #receipt(client: Pool | PoolClient, tenantId: string, spaceId: string, phase: string, value: IdempotencyDescriptor) {
    const rows = await client.query<ReceiptRow>(`SELECT request_fingerprint, execution_id
      FROM ${this.#schemaSql}.workspace_read_file_receipts WHERE tenant_id = $1 AND space_id = $2
      AND phase = $3 AND idempotency_scope = $4 AND idempotency_key = $5`,
    [tenantId, spaceId, phase, value.scope, value.key]);
    return rows.rows[0] ?? null;
  }
  #insertReceipt(client: PoolClient, locator: WorkspaceReadFileLocator, phase: string, value: IdempotencyDescriptor) {
    return client.query(`INSERT INTO ${this.#schemaSql}.workspace_read_file_receipts
      (tenant_id, space_id, phase, idempotency_scope, idempotency_key, request_fingerprint, execution_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, [locator.tenantId, locator.spaceId, phase,
      value.scope, value.key, value.requestFingerprint, locator.executionId]);
  }
  async #update(client: PoolClient, locator: WorkspaceReadFileLocator, revision: number, next: WorkspaceReadFileRecord) {
    const changed = await client.query(`UPDATE ${this.#schemaSql}.workspace_read_file_operations SET record_json = $1::jsonb
      WHERE tenant_id = $2 AND space_id = $3 AND execution_id = $4
      AND (record_json->>'revision')::integer = $5`, [JSON.stringify(next), locator.tenantId,
      locator.spaceId, locator.executionId, revision]);
    if (changed.rowCount !== 1) conflict();
  }
  async #transaction<T>(call: (client: PoolClient) => Promise<T>) {
    const client = await this.#pool.connect();
    try { await client.query("BEGIN"); const result = await call(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}

function locatorOf(value: WorkspaceReadFileLocator): WorkspaceReadFileLocator { return {
  tenantId: value.tenantId, spaceId: value.spaceId, runId: value.runId,
  stepId: value.stepId, attemptId: value.attemptId, executionId: value.executionId,
}; }
function fingerprint(row: ReceiptRow, value: IdempotencyDescriptor) { if (row.request_fingerprint !== value.requestFingerprint) conflict(); }
function result(disposition: "committed" | "replayed", operation: WorkspaceReadFileRecord): WorkspaceReadFileMutationResult {
  return { disposition, operation: structuredClone(operation) };
}
function conflict(): never { throw new RunStoreError("workspace_read_file_conflict"); }
