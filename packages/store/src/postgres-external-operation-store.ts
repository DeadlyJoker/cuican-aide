import type { Pool } from "pg";
import type {
  AdvanceExternalOperation,
  ExternalOperation,
  ExternalOperationLocator,
  ExternalOperationStore,
  ReserveExternalOperation,
} from "@crewon/application";
import {
  assertExternalOperationReplay,
  initialExternalOperation,
  nextExternalOperation,
  parseExternalOperation,
  validateExternalOperationAdvance,
  validateExternalOperationLocator,
} from "./external-operation-record.ts";

export class PostgresExternalOperationStore implements ExternalOperationStore {
  readonly #pool: Pool;
  readonly #table: string;
  constructor(pool: Pool, schema: string) {
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
      throw new Error("external_operation_schema_invalid");
    this.#pool = pool;
    this.#table = `"${schema}".extension_external_operations`;
  }

  async migrate() {
    await this.#pool.query(`CREATE TABLE IF NOT EXISTS ${this.#table} (
      tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, binding_digest TEXT NOT NULL,
      operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0), record_json JSONB NOT NULL,
      PRIMARY KEY (tenant_id, run_id, binding_digest, operation_id),
      UNIQUE (tenant_id, run_id, binding_digest, idempotency_key)
    );`);
  }

  async reserveExternalOperation(input: ReserveExternalOperation) {
    const operation = initialExternalOperation(input);
    const inserted = await this.#pool.query(
      `INSERT INTO ${this.#table}
      (tenant_id, run_id, binding_digest, operation_id, idempotency_key, revision, record_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, run_id, binding_digest, idempotency_key) DO NOTHING`,
      [
        operation.tenantId,
        operation.runId,
        operation.bindingDigest,
        operation.operationId,
        operation.idempotencyKey,
        operation.revision,
        operation,
      ],
    );
    if (inserted.rowCount === 1)
      return { disposition: "created" as const, operation };
    const result = await this.#pool.query<{ record_json: ExternalOperation }>(
      `SELECT record_json FROM ${this.#table} WHERE tenant_id = $1 AND run_id = $2
      AND binding_digest = $3 AND idempotency_key = $4`,
      [input.tenantId, input.runId, input.bindingDigest, input.idempotencyKey],
    );
    const record = result.rows[0]?.record_json;
    if (record === undefined)
      throw new Error("external_operation_receipt_missing");
    const existing = parseExternalOperation(record);
    assertExternalOperationReplay(existing, operation);
    return { disposition: "existing" as const, operation: existing };
  }

  async loadExternalOperation(input: ExternalOperationLocator) {
    validateExternalOperationLocator(input);
    const result = await this.#pool.query<{ record_json: ExternalOperation }>(
      `SELECT record_json FROM ${this.#table} WHERE tenant_id = $1 AND run_id = $2
      AND binding_digest = $3 AND operation_id = $4`,
      [input.tenantId, input.runId, input.bindingDigest, input.operationId],
    );
    return result.rows[0] === undefined
      ? null
      : parseExternalOperation(result.rows[0].record_json);
  }

  async advanceExternalOperation(input: AdvanceExternalOperation) {
    validateExternalOperationAdvance(input);
    const current = await this.loadExternalOperation(input);
    if (current === null) throw new Error("external_operation_not_found");
    if (current.revision !== input.expectedRevision)
      return { disposition: "conflict" as const, operation: current };
    const operation = nextExternalOperation(current, input);
    const result = await this.#pool.query(
      `UPDATE ${this.#table} SET revision = $1, record_json = $2
      WHERE tenant_id = $3 AND run_id = $4 AND binding_digest = $5
      AND operation_id = $6 AND revision = $7`,
      [
        operation.revision,
        operation,
        input.tenantId,
        input.runId,
        input.bindingDigest,
        input.operationId,
        input.expectedRevision,
      ],
    );
    if (result.rowCount === 1)
      return { disposition: "updated" as const, operation };
    const latest = await this.loadExternalOperation(input);
    if (latest === null) throw new Error("external_operation_receipt_missing");
    return { disposition: "conflict" as const, operation: latest };
  }
}
