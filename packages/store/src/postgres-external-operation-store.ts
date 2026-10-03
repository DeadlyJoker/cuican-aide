import type { Pool, PoolClient } from "pg";
import {
  assertExtensionCreditAdmission,
  extensionCanonicalJson,
  parseExtensionRunBinding,
  type ExtensionCreditAdmission,
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
import { decodeExtensionCreditAdmission } from "./extension-credit-admission-records.ts";
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
import { lockPostgresPluginCreditAccount } from "./postgres-plugin-credit-reservation.ts";
import {
  decodePostgresRunState,
  type PostgresRunRow,
} from "./postgres-run-codec.ts";

export class PostgresExternalOperationStore
  implements ExternalOperationStore, ExternalOperationQueryStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #table: string;
  readonly #host: Readonly<{ assertOpen(): void }> | undefined;
  constructor(
    pool: Pool,
    schema: string,
    host?: Readonly<{ assertOpen(): void }>,
  ) {
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
      throw new Error("external_operation_schema_invalid");
    this.#pool = pool;
    this.#schema = schema;
    this.#prefix = `"${schema}".`;
    this.#table = `${this.#prefix}extension_external_operations`;
    this.#host = host;
  }

  async migrate() {
    this.#host?.assertOpen();
    await this.#pool.query(`CREATE TABLE IF NOT EXISTS ${this.#table} (
      tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, binding_digest TEXT NOT NULL,
      operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0), record_json JSONB NOT NULL,
      PRIMARY KEY (tenant_id, run_id, binding_digest, operation_id),
      UNIQUE (tenant_id, run_id, binding_digest, idempotency_key)
    );`);
  }

  async reserveExternalOperation(input: ReserveExternalOperation) {
    this.#host?.assertOpen();
    const operation = initialExternalOperation(input);
    // A task admission can become visible while waiting for the original Run
    // commit. Restart once to take its personal-account lock before the Run lock.
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await this.#pool.connect();
      try {
        await this.#query(client, "BEGIN");
        const existing = await this.#receipt(client, operation);
        if (existing !== null) {
          await client.query("COMMIT");
          return { disposition: "existing" as const, operation: existing };
        }
        const admission = await this.#creditAdmission(client, operation);
        // Match paid task creation: personal pool first, original Run second.
        if (admission !== null)
          await lockPostgresPluginCreditAccount({
            client,
            schema: this.#schema,
            scope: admission.reservation.scope,
            assertOpen: () => this.#host?.assertOpen(),
          });
        // Exactly the existing PostgresRunStore/terminal-commit lock key.
        await this.#query(
          client,
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`run:${operation.tenantId}:${operation.runId}`],
        );
        const raced = await this.#receipt(client, operation);
        let result;
        if (raced !== null) {
          // Recovery after cancellation/settlement grants no new dispatch.
          result = { disposition: "existing" as const, operation: raced };
        } else {
          await this.#assertNewPaidOperation(client, operation, admission);
          result = await this.#insert(client, operation);
        }
        this.#host?.assertOpen();
        // A confirmed COMMIT remains success if the host closes afterward.
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (!(error instanceof PaidAdmissionAppeared)) throw error;
      } finally {
        client.release();
      }
    }
    throw new Error("external_operation_credit_admission_invalid");
  }

  async #insert(client: PoolClient, operation: ExternalOperation) {
    const inserted = await this.#query(
      client,
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
    const existing = await this.#receipt(client, operation);
    if (existing === null)
      throw new Error("external_operation_receipt_missing");
    return { disposition: "existing" as const, operation: existing };
  }

  async #receipt(client: PoolClient, operation: ExternalOperation) {
    const result = await this.#query<{ record_json: unknown }>(
      client,
      `SELECT record_json FROM ${this.#table} WHERE tenant_id = $1 AND run_id = $2
      AND binding_digest = $3 AND idempotency_key = $4`,
      [
        operation.tenantId,
        operation.runId,
        operation.bindingDigest,
        operation.idempotencyKey,
      ],
    );
    const record = result.rows[0]?.record_json;
    if (record === undefined) return null;
    const existing = parseExternalOperation(record);
    assertExternalOperationReplay(existing, operation);
    return existing;
  }

  async #creditAdmission(
    client: PoolClient,
    operation: ExternalOperation,
  ): Promise<ExtensionCreditAdmission | null> {
    try {
      return await this.#readCreditAdmission(client, operation);
    } catch (cause) {
      throw new Error("external_operation_credit_admission_invalid", { cause });
    }
  }

  async #readCreditAdmission(
    client: PoolClient,
    operation: ExternalOperation,
  ): Promise<ExtensionCreditAdmission | null> {
    // The legacy non-paid store may contain only the operation table. Never
    // create or infer a credit schema/account to accept its original work.
    if (!(await this.#creditSchemaPresent(client))) return null;
    const admissions = await this.#query<
      NonNullable<Parameters<typeof decodeExtensionCreditAdmission>[0]>
    >(
      client,
      `SELECT tenant_id,space_id,run_id,principal_id,pool_id,reservation_id,admission_json
       FROM ${this.#prefix}extension_credit_admissions WHERE tenant_id=$1 AND run_id=$2`,
      [operation.tenantId, operation.runId],
    );
    let admission: ExtensionCreditAdmission | null;
    try {
      admission = decodeExtensionCreditAdmission(admissions.rows[0]);
    } catch (cause) {
      throw new Error("external_operation_credit_admission_invalid", { cause });
    }
    if (admissions.rows.length > 1)
      throw new Error("external_operation_credit_admission_invalid");
    return admission;
  }

  async #creditSchemaPresent(client: PoolClient): Promise<boolean> {
    const markers = await this.#query<{ name: string; kind: string }>(
      client,
      `SELECT classes.relname AS name,classes.relkind AS kind
       FROM pg_class AS classes
       JOIN pg_namespace AS namespaces ON namespaces.oid=classes.relnamespace
       WHERE namespaces.nspname=$1 AND classes.relname=ANY($2::text[])`,
      [
        this.#schema,
        ["extension_credit_schema_version", "extension_credit_admissions"],
      ],
    );
    if (markers.rows.length === 0) return false;
    if (
      markers.rows.length !== 2 ||
      markers.rows.some((marker) => marker.kind !== "r") ||
      !markers.rows.some(
        (marker) => marker.name === "extension_credit_schema_version",
      ) ||
      !markers.rows.some(
        (marker) => marker.name === "extension_credit_admissions",
      )
    )
      throw new Error("external_operation_credit_admission_invalid");
    const version = await this.#query<{ id: number; version: number }>(
      client,
      `SELECT id,version FROM ${this.#prefix}extension_credit_schema_version LIMIT 2`,
    );
    if (
      version.rows.length !== 1 ||
      version.rows[0]?.id !== 1 ||
      version.rows[0]?.version !== 1
    )
      throw new Error("external_operation_credit_admission_invalid");
    return true;
  }

  async #assertNewPaidOperation(
    client: PoolClient,
    operation: ExternalOperation,
    expectedAdmission: ExtensionCreditAdmission | null,
  ): Promise<void> {
    try {
      await this.#checkNewPaidOperation(client, operation, expectedAdmission);
    } catch (cause) {
      if (
        cause instanceof PaidAdmissionAppeared ||
        (cause instanceof Error &&
          cause.message === "external_operation_credit_dispatch_denied")
      )
        throw cause;
      throw new Error("external_operation_credit_admission_invalid", { cause });
    }
  }

  async #checkNewPaidOperation(
    client: PoolClient,
    operation: ExternalOperation,
    expectedAdmission: ExtensionCreditAdmission | null,
  ): Promise<void> {
    const admission = await this.#creditAdmission(client, operation);
    if (expectedAdmission === null && admission !== null)
      throw new PaidAdmissionAppeared();
    const paidReceipt = await this.#paidTaskReceipt(client, operation);
    if (admission === null && paidReceipt === null) return;
    if (
      admission === null ||
      expectedAdmission === null ||
      paidReceipt === null ||
      extensionCanonicalJson(admission) !==
        extensionCanonicalJson(expectedAdmission) ||
      extensionCanonicalJson(admission) !==
        extensionCanonicalJson(paidReceipt.creditAdmission) ||
      admission.bindingDigest !== operation.bindingDigest
    )
      throw new Error("external_operation_credit_admission_invalid");
    const version = await this.#query<{ id: number; version: number }>(
      client,
      `SELECT id,version FROM ${this.#prefix}plugin_credit_schema_version LIMIT 2`,
    );
    if (
      version.rows.length !== 1 ||
      version.rows[0]?.id !== 1 ||
      version.rows[0]?.version !== 1
    )
      throw new Error("external_operation_credit_admission_invalid");
    const bindings = await this.#query<{
      tenant_id: string;
      space_id: string;
      plugin_id: string;
      run_id: string;
      configuration_revision: number;
      binding_json: unknown;
    }>(
      client,
      `SELECT tenant_id,space_id,plugin_id,run_id,configuration_revision,binding_json
       FROM ${this.#prefix}extension_run_bindings WHERE tenant_id=$1 AND run_id=$2`,
      [operation.tenantId, operation.runId],
    );
    const row = bindings.rows[0];
    if (bindings.rows.length !== 1 || row === undefined)
      throw new Error("external_operation_credit_admission_invalid");
    const binding = parseExtensionRunBinding(
      row.binding_json,
      extensionStoreDigester,
    );
    if (
      row.tenant_id !== binding.tenantId ||
      row.space_id !== binding.spaceId ||
      row.plugin_id !== binding.pluginId ||
      row.run_id !== binding.runId ||
      row.configuration_revision !== binding.configurationRevision
    )
      throw new Error("external_operation_credit_admission_invalid");
    assertExtensionCreditAdmission(
      {
        admission,
        binding,
        receipt: {
          actorId: admission.actorId,
          idempotencyKey: admission.commandIdempotencyKey,
          requestDigest: admission.commandRequestDigest,
        },
      },
      extensionStoreDigester,
    );
    const runs = await this.#query<PostgresRunRow>(
      client,
      `SELECT snapshots.tenant_id,snapshots.space_id,snapshots.run_id,
              snapshots.revision,snapshots.last_sequence,snapshots.state_json,
              snapshots.updated_at,bindings.thread_id
       FROM ${this.#prefix}run_snapshots AS snapshots
       LEFT JOIN ${this.#prefix}run_thread_bindings AS bindings
         ON bindings.tenant_id=snapshots.tenant_id AND bindings.run_id=snapshots.run_id
       WHERE snapshots.tenant_id=$1 AND snapshots.run_id=$2 FOR UPDATE OF snapshots`,
      [operation.tenantId, operation.runId],
    );
    const runRow = runs.rows[0];
    if (runs.rows.length !== 1 || runRow === undefined)
      throw new Error("external_operation_credit_admission_invalid");
    const run = decodePostgresRunState(runRow, operation);
    if (
      run.spaceId !== binding.spaceId ||
      run.threadId !== binding.threadId ||
      run.createdByActorId !== binding.actorId ||
      run.agentVersionId !== binding.target.agentVersionId ||
      run.authorityId !== binding.target.authorityId ||
      run.runtimeGeneration !== binding.target.runtimeGeneration ||
      run.policySnapshotId !== binding.target.policySnapshotId ||
      run.workspaceBindingId !== binding.target.workspaceBindingId
    )
      throw new Error("external_operation_credit_admission_invalid");
    if (
      run.cancelRequested !== false ||
      run.status !== "running" ||
      run.terminalAt !== null
    )
      throw new Error("external_operation_credit_dispatch_denied");
    const values = [...creditScopeValues(admission.reservation.scope)];
    const accounts = await this.#query<
      NonNullable<Parameters<typeof decodeCreditAccount>[0]>
    >(
      client,
      `SELECT revision,account_json FROM ${this.#prefix}plugin_credit_accounts
       WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 FOR UPDATE`,
      values,
    );
    const account = decodeCreditAccount(
      accounts.rows[0],
      admission.reservation.scope,
    );
    const reservations = await this.#query<
      NonNullable<Parameters<typeof decodeCreditReservation>[0]>
    >(
      client,
      `SELECT reservation_id,idempotency_key,record_json FROM ${this.#prefix}plugin_credit_reservations
       WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 AND reservation_id=$4 FOR UPDATE`,
      [...values, admission.reservation.reservationId],
    );
    const reservation = decodeCreditReservation(
      reservations.rows[0],
      admission.reservation.scope,
    );
    if (account === null || reservation === null)
      throw new Error("external_operation_credit_admission_invalid");
    assertCreditReservationReplay(reservation, admission.reservation);
    if (reservation.state !== "reserved")
      throw new Error("external_operation_credit_dispatch_denied");
    if (BigInt(account.reservedCredits) < BigInt(reservation.quotedCredits))
      throw new Error("external_operation_credit_admission_invalid");
  }

  async #paidTaskReceipt(client: PoolClient, operation: ExternalOperation) {
    const migrated = await this.#query<{ migrated: boolean }>(
      client,
      "SELECT to_regclass($1) IS NOT NULL AS migrated",
      [`${this.#prefix}extension_mutation_receipts`],
    );
    if (migrated.rows[0]?.migrated === false) return null;
    if (migrated.rows[0]?.migrated !== true)
      throw new Error("external_operation_credit_admission_invalid");
    // The original accepted price-bearing receipt is evidence of a paid task.
    // Installed provenance alone also exists for historical unpriced tasks.
    const receipts = await this.#query<{
      tenant_id: string;
      space_id: string;
      plugin_id: string;
      actor_id: string;
      idempotency_key: string;
      request_digest: string;
      result_json: unknown;
    }>(
      client,
      `SELECT tenant_id,space_id,plugin_id,actor_id,idempotency_key,request_digest,result_json
       FROM ${this.#prefix}extension_mutation_receipts
       WHERE tenant_id=$1 AND kind='task' AND result_json ? 'creditAdmission' AND (
         result_json->'binding'->>'runId'=$2 OR
         result_json->'creditAdmission'->>'runId'=$2 OR
         result_json->'run'->'state'->>'runId'=$2 OR
         result_json->'turn'->'runState'->>'runId'=$2
       ) LIMIT 2`,
      [operation.tenantId, operation.runId],
    );
    const row = receipts.rows[0];
    if (row === undefined) return null;
    if (receipts.rows.length !== 1)
      throw new Error("external_operation_credit_admission_invalid");
    const parsed = parseExtensionTurnReceipt(
      row.result_json,
      {
        tenantId: row.tenant_id,
        spaceId: row.space_id,
        pluginId: row.plugin_id,
      },
      {
        actorId: row.actor_id,
        idempotencyKey: row.idempotency_key,
        requestDigest: row.request_digest,
      },
    );
    if (parsed.creditAdmission === undefined)
      throw new Error("external_operation_credit_admission_invalid");
    return parsed;
  }

  async #query<Row extends Record<string, unknown> = Record<string, unknown>>(
    client: PoolClient,
    sql: string,
    values?: unknown[],
  ) {
    this.#host?.assertOpen();
    const result = await client.query<Row>(sql, values);
    this.#host?.assertOpen();
    return result;
  }

  async loadExternalOperation(input: ExternalOperationLocator) {
    this.#host?.assertOpen();
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

  async listExternalOperations(input: ExternalOperationQuery) {
    this.#host?.assertOpen();
    const query = validateExternalOperationQuery(input);
    const result = await this.#pool.query<{
      operation_id: string;
      record_json: ExternalOperation;
    }>(
      `SELECT operation_id, record_json FROM ${this.#table}
      WHERE tenant_id = $1 AND run_id = $2 AND binding_digest = $3
      ORDER BY operation_id LIMIT $4`,
      [query.tenantId, query.runId, query.bindingDigest, query.limit + 1],
    );
    this.#host?.assertOpen();
    const operations = result.rows.map((row) =>
      parseExternalOperationQueryRecord({
        record: row.record_json,
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
    const current = await this.loadExternalOperation(input);
    if (current === null) throw new Error("external_operation_not_found");
    if (current.revision !== input.expectedRevision)
      return { disposition: "conflict" as const, operation: current };
    const operation = nextExternalOperation(current, input);
    this.#host?.assertOpen();
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

class PaidAdmissionAppeared extends Error {}
