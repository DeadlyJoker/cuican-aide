import type { DatabaseSync } from "node:sqlite";
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

/** Additive schema, explicitly migrated by the owning host before accepting plugin work. */
export function migrateSqliteExternalOperations(database: DatabaseSync) {
  database.exec(`CREATE TABLE IF NOT EXISTS extension_external_operations (
    tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, binding_digest TEXT NOT NULL,
    operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0), record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, run_id, binding_digest, operation_id),
    UNIQUE (tenant_id, run_id, binding_digest, idempotency_key)
  ) STRICT;`);
}

export class SqliteExternalOperationStore implements ExternalOperationStore {
  readonly #database: DatabaseSync;
  readonly #host: Readonly<{ assertOpen(): void }> | undefined;
  constructor(database: DatabaseSync, host?: Readonly<{ assertOpen(): void }>) {
    this.#database = database;
    this.#host = host;
  }

  async migrate(): Promise<void> {
    this.#host?.assertOpen();
    migrateSqliteExternalOperations(this.#database);
  }

  async reserveExternalOperation(input: ReserveExternalOperation) {
    this.#host?.assertOpen();
    const operation = initialExternalOperation(input);
    return this.#transaction(() => {
      const inserted = this.#database
        .prepare(
          `INSERT INTO extension_external_operations
        (tenant_id, run_id, binding_digest, operation_id, idempotency_key, revision, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, run_id, binding_digest, idempotency_key) DO NOTHING`,
        )
        .run(
          operation.tenantId,
          operation.runId,
          operation.bindingDigest,
          operation.operationId,
          operation.idempotencyKey,
          operation.revision,
          JSON.stringify(operation),
        );
      if (inserted.changes === 1)
        return { disposition: "created" as const, operation };
      const row = this.#database
        .prepare(
          `SELECT record_json FROM extension_external_operations
        WHERE tenant_id = ? AND run_id = ? AND binding_digest = ? AND idempotency_key = ?`,
        )
        .get(
          input.tenantId,
          input.runId,
          input.bindingDigest,
          input.idempotencyKey,
        ) as { record_json: string };
      const existing = parseExternalOperation(JSON.parse(row.record_json));
      assertExternalOperationReplay(existing, operation);
      return { disposition: "existing" as const, operation: existing };
    });
  }

  async loadExternalOperation(input: ExternalOperationLocator) {
    this.#host?.assertOpen();
    validateExternalOperationLocator(input);
    return this.#load(input);
  }

  async advanceExternalOperation(input: AdvanceExternalOperation) {
    this.#host?.assertOpen();
    validateExternalOperationAdvance(input);
    return this.#transaction(() => {
      const current = this.#load(input);
      if (current === null) throw new Error("external_operation_not_found");
      if (current.revision !== input.expectedRevision)
        return { disposition: "conflict" as const, operation: current };
      const operation = nextExternalOperation(current, input);
      this.#database
        .prepare(
          `UPDATE extension_external_operations SET revision = ?, record_json = ?
        WHERE tenant_id = ? AND run_id = ? AND binding_digest = ? AND operation_id = ?`,
        )
        .run(
          operation.revision,
          JSON.stringify(operation),
          input.tenantId,
          input.runId,
          input.bindingDigest,
          input.operationId,
        );
      return { disposition: "updated" as const, operation };
    });
  }

  #load(input: ExternalOperationLocator): ExternalOperation | null {
    const row = this.#database
      .prepare(
        `SELECT record_json FROM extension_external_operations
      WHERE tenant_id = ? AND run_id = ? AND binding_digest = ? AND operation_id = ?`,
      )
      .get(
        input.tenantId,
        input.runId,
        input.bindingDigest,
        input.operationId,
      ) as { record_json: string } | undefined;
    return row === undefined
      ? null
      : parseExternalOperation(JSON.parse(row.record_json));
  }

  #transaction<T>(body: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}
