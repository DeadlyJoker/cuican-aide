import { DatabaseSync } from "node:sqlite";

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
  requireWorkspaceReadFileLocator,
  validateFrozenWorkspaceReadFileDispatch,
  validateWorkspaceReadFileIdempotency,
  validateWorkspaceReadFileLocator,
  validateWorkspaceReadFileRecord,
  withResolution,
} from "./workspace-read-file-store-support.ts";

type OperationRow = { record_json: string };
type ReceiptRow = { request_fingerprint: string; execution_id: string };

export class SqliteWorkspaceReadFileStore implements WorkspaceReadFileStore {
  readonly #database: DatabaseSync;
  readonly #owned: boolean;
  #closed = false;

  constructor(database: DatabaseSync, owned = false) {
    this.#database = database;
    this.#owned = owned;
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_read_file_operations (
        tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, execution_id TEXT NOT NULL,
        record_json TEXT NOT NULL, PRIMARY KEY (tenant_id, space_id, execution_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workspace_read_file_receipts (
        tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, phase TEXT NOT NULL,
        idempotency_scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL, execution_id TEXT NOT NULL,
        PRIMARY KEY (tenant_id, space_id, phase, idempotency_scope, idempotency_key),
        FOREIGN KEY (tenant_id, space_id, execution_id) REFERENCES workspace_read_file_operations
          (tenant_id, space_id, execution_id) ON DELETE RESTRICT
      ) STRICT;
    `);
  }

  static open(path: string) {
    if (typeof path !== "string" || path.length < 1 || path.includes("\0"))
      throw new RunStoreError("workspace_read_file_sqlite_path_invalid");
    return new SqliteWorkspaceReadFileStore(new DatabaseSync(path), true);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#owned) this.#database.close();
  }

  async loadWorkspaceReadFileReceipt(query: WorkspaceReadFileReceiptQuery) {
    this.#assertOpen();
    validateWorkspaceReadFileIdempotency(query.idempotency);
    const row = this.#receipt(
      query.tenantId,
      query.spaceId,
      query.phase,
      query.idempotency,
    );
    if (row === null) return null;
    fingerprint(row, query.idempotency);
    return result(
      "replayed",
      this.#required(query.tenantId, query.spaceId, row.execution_id),
    );
  }

  async prepareWorkspaceReadFile(input: PrepareWorkspaceReadFileInput) {
    validateWorkspaceReadFileIdempotency(input.idempotency);
    return this.#transaction(() => {
      const locator = validateWorkspaceReadFileLocator(locatorOf(input));
      const receipt = this.#receipt(
        locator.tenantId,
        locator.spaceId,
        "execute",
        input.idempotency,
      );
      if (receipt !== null) {
        fingerprint(receipt, input.idempotency);
        const operation = this.#required(
          locator.tenantId,
          locator.spaceId,
          receipt.execution_id,
        );
        requireWorkspaceReadFileLocator(operation, locator);
        return result("replayed", operation);
      }
      const frozen = validateFrozenWorkspaceReadFileDispatch(input.frozen);
      const existing = this.#load(
        locator.tenantId,
        locator.spaceId,
        locator.executionId,
      );
      if (existing !== null) {
        requireWorkspaceReadFileLocator(existing, locator);
        if (JSON.stringify(existing.frozen) !== JSON.stringify(frozen))
          conflict();
        this.#insertReceipt(locator, "execute", input.idempotency);
        return result("replayed", existing);
      }
      const operation = validateWorkspaceReadFileRecord({
        schemaVersion: "crewon.workspace-read-file-operation.v0",
        ...locator,
        revision: 1,
        status: "prepared",
        frozen,
        resolution: null,
      });
      this.#database
        .prepare(
          `INSERT INTO workspace_read_file_operations
        (tenant_id, space_id, execution_id, record_json) VALUES (?, ?, ?, ?)`,
        )
        .run(
          locator.tenantId,
          locator.spaceId,
          locator.executionId,
          JSON.stringify(operation),
        );
      this.#insertReceipt(locator, "execute", input.idempotency);
      return result("committed", operation);
    });
  }

  async prepareWorkspaceReadFileAction(
    input: PrepareWorkspaceReadFileActionInput,
  ) {
    validateWorkspaceReadFileIdempotency(input.idempotency);
    return this.#transaction(() => {
      const locator = validateWorkspaceReadFileLocator(locatorOf(input));
      const operation = this.#required(
        locator.tenantId,
        locator.spaceId,
        locator.executionId,
      );
      requireWorkspaceReadFileLocator(operation, locator);
      const receipt = this.#receipt(
        locator.tenantId,
        locator.spaceId,
        input.phase,
        input.idempotency,
      );
      if (receipt !== null) {
        fingerprint(receipt, input.idempotency);
        const receiptOperation = this.#required(
          locator.tenantId,
          locator.spaceId,
          receipt.execution_id,
        );
        requireWorkspaceReadFileLocator(receiptOperation, locator);
        return result("replayed", receiptOperation);
      }
      this.#insertReceipt(locator, input.phase, input.idempotency);
      return result("committed", operation);
    });
  }

  async markWorkspaceReadFilePossiblySent(
    input: WorkspaceReadFileLocator & { expectedRevision: number },
  ) {
    return this.#transaction(() => {
      const current = this.#expected(input);
      if (current.resolution !== null || current.status === "possiblySent")
        return current;
      const next = validateWorkspaceReadFileRecord({
        ...current,
        revision: current.revision + 1,
        status: "possiblySent",
      });
      this.#update(input, current.revision, next);
      return next;
    });
  }

  async abandonWorkspaceReadFileSend(
    input: WorkspaceReadFileLocator & { expectedRevision: number },
  ) {
    return this.#transaction(() => {
      const current = this.#expected(input);
      if (current.status !== "possiblySent" || current.resolution !== null)
        conflict();
      const next = validateWorkspaceReadFileRecord({
        ...current,
        revision: current.revision + 1,
        status: "prepared",
      });
      this.#update(input, current.revision, next);
      return next;
    });
  }

  async commitWorkspaceReadFileResolution(
    input: Parameters<
      WorkspaceReadFileStore["commitWorkspaceReadFileResolution"]
    >[0],
  ) {
    validateWorkspaceReadFileIdempotency(input.idempotency);
    return this.#transaction(() => {
      const current = this.#required(
        input.tenantId,
        input.spaceId,
        input.executionId,
      );
      requireWorkspaceReadFileLocator(current, input);
      const receipt = this.#receipt(
        input.tenantId,
        input.spaceId,
        input.phase,
        input.idempotency,
      );
      if (receipt !== null) {
        fingerprint(receipt, input.idempotency);
        if (receipt.execution_id !== input.executionId) conflict();
        requireWorkspaceReadFileLocator(
          this.#required(input.tenantId, input.spaceId, receipt.execution_id),
          input,
        );
      }
      if (current.resolution !== null) {
        if (receipt === null) conflict();
        const parsed = exactResolution(current, input.phase, input.resolution);
        if (JSON.stringify(parsed) !== JSON.stringify(current.resolution))
          conflict();
        return result("replayed", current);
      }
      if (current.revision !== input.expectedRevision) conflict();
      if (input.phase === "execute" && current.status !== "possiblySent")
        conflict();
      const next = withResolution(
        current,
        exactResolution(current, input.phase, input.resolution),
      );
      this.#update(input, current.revision, next);
      if (receipt === null)
        this.#insertReceipt(input, input.phase, input.idempotency);
      return result("committed", next);
    });
  }

  #load(tenantId: string, spaceId: string, executionId: string) {
    const row = this.#database
      .prepare(
        `SELECT record_json FROM workspace_read_file_operations
      WHERE tenant_id = ? AND space_id = ? AND execution_id = ?`,
      )
      .get(tenantId, spaceId, executionId) as OperationRow | undefined;
    return row === undefined
      ? null
      : validateWorkspaceReadFileRecord(JSON.parse(row.record_json));
  }
  #required(tenantId: string, spaceId: string, executionId: string) {
    const value = this.#load(tenantId, spaceId, executionId);
    if (value === null)
      throw new RunStoreError("workspace_read_file_not_found");
    return value;
  }
  #expected(input: WorkspaceReadFileLocator & { expectedRevision: number }) {
    const current = this.#required(
      input.tenantId,
      input.spaceId,
      input.executionId,
    );
    requireWorkspaceReadFileLocator(current, input);
    if (current.revision !== input.expectedRevision) conflict();
    return current;
  }
  #receipt(
    tenantId: string,
    spaceId: string,
    phase: string,
    value: IdempotencyDescriptor,
  ) {
    return (
      (this.#database
        .prepare(
          `SELECT request_fingerprint, execution_id FROM workspace_read_file_receipts
      WHERE tenant_id = ? AND space_id = ? AND phase = ? AND idempotency_scope = ? AND idempotency_key = ?`,
        )
        .get(tenantId, spaceId, phase, value.scope, value.key) as
        | ReceiptRow
        | undefined) ?? null
    );
  }
  #insertReceipt(
    locator: WorkspaceReadFileLocator,
    phase: string,
    value: IdempotencyDescriptor,
  ) {
    this.#database
      .prepare(
        `INSERT INTO workspace_read_file_receipts
      (tenant_id, space_id, phase, idempotency_scope, idempotency_key, request_fingerprint, execution_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        locator.tenantId,
        locator.spaceId,
        phase,
        value.scope,
        value.key,
        value.requestFingerprint,
        locator.executionId,
      );
  }
  #update(
    locator: WorkspaceReadFileLocator,
    revision: number,
    next: WorkspaceReadFileRecord,
  ) {
    const changed = this.#database
      .prepare(
        `UPDATE workspace_read_file_operations SET record_json = ?
      WHERE tenant_id = ? AND space_id = ? AND execution_id = ? AND json_extract(record_json, '$.revision') = ?`,
      )
      .run(
        JSON.stringify(next),
        locator.tenantId,
        locator.spaceId,
        locator.executionId,
        revision,
      ).changes;
    if (changed !== 1) conflict();
  }
  #transaction<T>(call: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = call();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen() {
    if (this.#closed)
      throw new RunStoreError("workspace_read_file_store_closed");
  }
}

function locatorOf(value: WorkspaceReadFileLocator): WorkspaceReadFileLocator {
  return {
    tenantId: value.tenantId,
    spaceId: value.spaceId,
    runId: value.runId,
    stepId: value.stepId,
    attemptId: value.attemptId,
    executionId: value.executionId,
  };
}
function fingerprint(row: ReceiptRow, value: IdempotencyDescriptor) {
  if (row.request_fingerprint !== value.requestFingerprint) conflict();
}
function result(
  disposition: "committed" | "replayed",
  operation: WorkspaceReadFileRecord,
): WorkspaceReadFileMutationResult {
  return { disposition, operation: structuredClone(operation) };
}
function conflict(): never {
  throw new RunStoreError("workspace_read_file_conflict");
}
