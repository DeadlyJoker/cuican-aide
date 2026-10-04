import { assertSqliteUnmeteredDispatch } from "./plugin-task-unmetered-operation-support.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  extensionCanonicalJson,
  parseExtensionRunBinding,
  type RunState,
} from "@crewon/domain";
import type {
  AdvanceExternalOperation,
  ExternalOperation,
  ExternalOperationLocator,
  ExternalOperationStore,
  ExternalOperationQuery,
  ExternalOperationQueryStore,
  ReserveExternalOperation,
} from "@crewon/application";
import {
  assertExternalOperationReplay,
  initialExternalOperation,
  nextExternalOperation,
  parseExternalOperation,
  parseExternalOperationQueryRecord,
  validateExternalOperationQuery,
  validateExternalOperationAdvance,
  validateExternalOperationLocator,
} from "./external-operation-record.ts";
import {
  assertExtensionCreditAdmissionLink,
  assertExtensionCreditSchemaVersion,
  decodeExtensionCreditAdmission,
} from "./extension-credit-admission-records.ts";
import {
  extensionStoreDigester,
  parseExtensionTurnReceipt,
} from "./extension-store-records.ts";
import {
  assertCreditReservationReplay,
  creditScopeValues,
  decodeCreditAccount,
  decodeCreditReservation,
} from "./plugin-credit-support.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";

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

export class SqliteExternalOperationStore
  implements ExternalOperationStore, ExternalOperationQueryStore
{
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
      // An original receipt is observation, not another permission to dispatch.
      const existing = this.#database
        .prepare(
          `SELECT record_json FROM extension_external_operations
        WHERE tenant_id = ? AND run_id = ? AND binding_digest = ? AND idempotency_key = ?`,
        )
        .get(
          operation.tenantId,
          operation.runId,
          operation.bindingDigest,
          operation.idempotencyKey,
        ) as { record_json: string } | undefined;
      if (existing !== undefined) {
        const saved = parseExternalOperation(JSON.parse(existing.record_json));
        assertExternalOperationReplay(saved, operation);
        return { disposition: "existing" as const, operation: saved };
      }
      this.#assertPaidDispatch(operation);
      assertSqliteUnmeteredDispatch(this.#database, operation);
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
      const saved = parseExternalOperation(JSON.parse(row.record_json));
      assertExternalOperationReplay(saved, operation);
      return { disposition: "existing" as const, operation: saved };
    });
  }

  async loadExternalOperation(input: ExternalOperationLocator) {
    this.#host?.assertOpen();
    validateExternalOperationLocator(input);
    return this.#load(input);
  }

  async listExternalOperations(input: ExternalOperationQuery) {
    this.#host?.assertOpen();
    const query = validateExternalOperationQuery(input);
    const rows = this.#database
      .prepare(
        `SELECT operation_id, record_json FROM extension_external_operations
      WHERE tenant_id = ? AND run_id = ? AND binding_digest = ?
      ORDER BY operation_id LIMIT ?`,
      )
      .all(
        query.tenantId,
        query.runId,
        query.bindingDigest,
        query.limit + 1,
      ) as { operation_id: string; record_json: string }[];
    const operations = rows.map((row) =>
      parseExternalOperationQueryRecord({
        record: JSON.parse(row.record_json),
        query,
        operationId: row.operation_id,
      }),
    );
    return Object.freeze({
      operations: Object.freeze(operations.slice(0, query.limit)),
      truncated: operations.length > query.limit,
    });
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

  /** The write lock covers actual billing/Run facts through the new dispatch receipt. */
  #assertPaidDispatch(operation: ExternalOperation): void {
    const schema = this.#database
      .prepare(
        `SELECT name,type,'main' AS source FROM main.sqlite_master
        WHERE name IN ('extension_credit_schema_version','extension_credit_admissions')
        UNION ALL SELECT name,type,'temp' AS source FROM temp.sqlite_master
        WHERE name IN ('extension_credit_schema_version','extension_credit_admissions') LIMIT 5`,
      )
      .all();
    try {
      // Absence of the billing schema cannot erase an original price-bearing receipt.
      // An operation-only store still reads only its table and schema catalog.
      if (schema.length === 0) {
        if (this.#hasPaidTaskReceipt(operation)) invalidPaidAdmission();
        return;
      }
      if (
        schema.length !== 2 ||
        schema.some((row) => row.type !== "table" || row.source !== "main") ||
        !schema.some((row) => row.name === "extension_credit_schema_version") ||
        !schema.some((row) => row.name === "extension_credit_admissions")
      )
        invalidPaidAdmission();
      assertExtensionCreditSchemaVersion(
        this.#database
          .prepare(
            "SELECT id,version FROM main.extension_credit_schema_version LIMIT 2",
          )
          .all() as { id: unknown; version: unknown }[],
      );
      // Detect the real paid Run independently of the caller's supplied digest.
      const admission = decodeExtensionCreditAdmission(
        this.#database
          .prepare(
            `SELECT tenant_id,space_id,run_id,principal_id,pool_id,reservation_id,admission_json
            FROM main.extension_credit_admissions WHERE tenant_id=? AND run_id=?`,
          )
          .get(operation.tenantId, operation.runId) as Parameters<
          typeof decodeExtensionCreditAdmission
        >[0],
      );
      if (admission === null) {
        // A durable priced receipt must not become free when its separate admission is lost.
        if (this.#hasPaidTaskReceipt(operation)) invalidPaidAdmission();
        return;
      }
      const bindingRow = this.#database
        .prepare(
          `SELECT tenant_id,space_id,plugin_id,run_id,configuration_revision,binding_json
          FROM main.extension_run_bindings WHERE tenant_id=? AND run_id=?`,
        )
        .get(operation.tenantId, operation.runId);
      if (
        bindingRow === undefined ||
        typeof bindingRow.binding_json !== "string"
      )
        invalidPaidAdmission();
      const binding = parseExtensionRunBinding(
        JSON.parse(bindingRow.binding_json),
        extensionStoreDigester,
      );
      if (
        binding.tenantId !== bindingRow.tenant_id ||
        binding.spaceId !== bindingRow.space_id ||
        binding.pluginId !== bindingRow.plugin_id ||
        binding.runId !== bindingRow.run_id ||
        binding.configurationRevision !== bindingRow.configuration_revision ||
        binding.tenantId !== operation.tenantId ||
        binding.runId !== operation.runId ||
        binding.bindingDigest !== operation.bindingDigest ||
        binding.bindingDigest !== admission.bindingDigest
      )
        invalidPaidAdmission();
      const receiptRow = this.#database
        .prepare(
          `SELECT request_digest,result_json FROM main.extension_mutation_receipts
          WHERE tenant_id=? AND space_id=? AND plugin_id=? AND kind='task'
          AND actor_id=? AND idempotency_key=?`,
        )
        .get(
          admission.tenantId,
          admission.spaceId,
          binding.pluginId,
          admission.actorId,
          admission.commandIdempotencyKey,
        );
      if (
        receiptRow === undefined ||
        receiptRow.request_digest !== admission.commandRequestDigest ||
        typeof receiptRow.result_json !== "string"
      )
        invalidPaidAdmission();
      const receipt = parseExtensionTurnReceipt(
        JSON.parse(receiptRow.result_json),
        binding,
        {
          actorId: admission.actorId,
          idempotencyKey: admission.commandIdempotencyKey,
          requestDigest: admission.commandRequestDigest,
        },
      );
      if (
        receipt.creditAdmission === undefined ||
        extensionCanonicalJson(receipt.binding) !==
          extensionCanonicalJson(binding)
      )
        invalidPaidAdmission();
      assertExtensionCreditAdmissionLink({
        admission,
        linked: receipt.creditAdmission,
      });
      const creditVersion = this.#database
        .prepare(
          "SELECT id,version FROM main.plugin_credit_schema_version LIMIT 2",
        )
        .all();
      if (
        creditVersion.length !== 1 ||
        creditVersion[0]?.id !== 1 ||
        creditVersion[0]?.version !== 1
      )
        invalidPaidAdmission();
      const hold = decodeCreditReservation(
        this.#database
          .prepare(
            `SELECT reservation_id,idempotency_key,record_json FROM main.plugin_credit_reservations
            WHERE tenant_id=? AND principal_id=? AND pool_id=? AND reservation_id=?`,
          )
          .get(
            ...creditScopeValues(admission.reservation.scope),
            admission.reservation.reservationId,
          ) as Parameters<typeof decodeCreditReservation>[0],
        admission.reservation.scope,
      );
      if (hold === null) invalidPaidAdmission();
      assertCreditReservationReplay(hold, admission.reservation);
      const account = decodeCreditAccount(
        this.#database
          .prepare(
            `SELECT revision,account_json FROM main.plugin_credit_accounts
            WHERE tenant_id=? AND principal_id=? AND pool_id=?`,
          )
          .get(...creditScopeValues(admission.reservation.scope)) as Parameters<
          typeof decodeCreditAccount
        >[0],
        admission.reservation.scope,
      );
      if (
        account === null ||
        (hold.state === "reserved" &&
          BigInt(account.reservedCredits) < BigInt(hold.quotedCredits))
      )
        invalidPaidAdmission();
      const runRow = this.#database
        .prepare(
          `SELECT r.tenant_id,r.space_id,r.run_id,r.revision,r.last_sequence,r.state_json,t.thread_id
          FROM main.run_snapshots r LEFT JOIN main.run_thread_bindings t
          ON t.tenant_id=r.tenant_id AND t.run_id=r.run_id
          WHERE r.tenant_id=? AND r.run_id=?`,
        )
        .get(operation.tenantId, operation.runId);
      if (runRow === undefined || typeof runRow.state_json !== "string")
        invalidPaidAdmission();
      const run = normalizeStoredRunState(
        JSON.parse(runRow.state_json) as RunState,
        "external_operation_credit_admission_invalid",
      );
      if (
        run.tenantId !== runRow.tenant_id ||
        run.spaceId !== runRow.space_id ||
        run.runId !== runRow.run_id ||
        run.revision !== runRow.revision ||
        run.lastSequence !== runRow.last_sequence ||
        run.threadId !== runRow.thread_id ||
        run.tenantId !== binding.tenantId ||
        run.spaceId !== binding.spaceId ||
        run.runId !== binding.runId ||
        run.threadId !== binding.threadId ||
        run.createdByActorId !== binding.actorId ||
        run.agentVersionId !== binding.target.agentVersionId ||
        run.authorityId !== binding.target.authorityId ||
        run.runtimeGeneration !== binding.target.runtimeGeneration ||
        run.policySnapshotId !== binding.target.policySnapshotId ||
        run.workspaceBindingId !== binding.target.workspaceBindingId ||
        !Number.isSafeInteger(run.revision) ||
        run.revision < 1 ||
        !Number.isSafeInteger(run.lastSequence) ||
        run.lastSequence < 1
      )
        invalidPaidAdmission();
      if (
        run.status !== "running" ||
        run.cancelRequested !== false ||
        run.terminalAt !== null ||
        hold.state !== "reserved"
      )
        throw new Error("external_operation_credit_dispatch_denied");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "external_operation_credit_dispatch_denied"
      )
        throw error;
      throw new Error("external_operation_credit_admission_invalid", {
        cause: error,
      });
    }
  }

  #hasPaidTaskReceipt(operation: ExternalOperation): boolean {
    const tables = this.#database
      .prepare(
        `SELECT type,'main' AS source FROM main.sqlite_master WHERE name='extension_mutation_receipts'
        UNION ALL SELECT type,'temp' AS source FROM temp.sqlite_master WHERE name='extension_mutation_receipts' LIMIT 3`,
      )
      .all();
    if (tables.length === 0) return false;
    if (
      tables.length !== 1 ||
      tables[0]?.type !== "table" ||
      tables[0]?.source !== "main"
    )
      invalidPaidAdmission();
    return (
      this.#database
        .prepare(
          `SELECT 1 AS present FROM main.extension_mutation_receipts
        WHERE tenant_id=? AND kind='task' AND json_type(result_json,'$.creditAdmission') IS NOT NULL AND (
          json_extract(result_json,'$.binding.runId')=? OR
          json_extract(result_json,'$.creditAdmission.runId')=? OR
          json_extract(result_json,'$.run.state.runId')=? OR
          json_extract(result_json,'$.turn.runState.runId')=?
        ) LIMIT 1`,
        )
        .get(
          operation.tenantId,
          operation.runId,
          operation.runId,
          operation.runId,
          operation.runId,
        ) !== undefined
    );
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

function invalidPaidAdmission(): never {
  throw new Error("external_operation_credit_admission_invalid");
}
