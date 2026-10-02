import type { DatabaseSync } from "node:sqlite";
import {
  CreditLedgerError,
  extensionOpaqueId,
  extensionRevision,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionRunBinding,
  type ExtensionScope,
  type ExtensionExecutionTarget,
  type ExtensionRunBinding,
  type ExtensionCreditAdmission,
} from "@crewon/domain";
import type {
  CommitExtensionRunInput,
  CommitExtensionRunResult,
  CommitExtensionTurnInput,
  CommitTurnStartInput,
  CommitTurnStartResult,
  CommitRunInput,
  CommitRunResult,
  ExtensionMutationReceipt,
  ExtensionRunLocator,
  ExtensionStore,
  SaveExtensionActivationInput,
  SaveExtensionConfigurationInput,
} from "@crewon/application";
import {
  assertExtensionAdmission,
  assertExtensionConfigurationReference,
  assertExtensionDeployment,
  assertExtensionQuerySource,
  assertExtensionReplay,
  extensionScopeValues,
  extensionStoreDigester,
  extensionTaskCommit,
  parseExtensionTaskReceipt,
  parseExtensionConfigurationReceipt,
  parseExtensionActivationReceipt,
  validateActivationSave,
  validateConfigurationSave,
  validateExtensionReceipt,
  validateExtensionRunCommit,
  validateExtensionTurnCommit,
  extensionTurnCommit,
  extensionTurnResult,
  parseExtensionTurnReceipt,
} from "./extension-store-records.ts";
import { migrateSqliteExternalOperations } from "./sqlite-external-operation-store.ts";
import { migrateSqlitePluginCredits } from "./plugin-credit-schema.ts";
import { migrateSqlitePluginTaskAdmissions } from "./plugin-task-admission-schema.ts";
import { migrateSqlitePluginQueryTasks } from "./plugin-query-task-schema.ts";
import {
  checkedPluginQueryTurn,
  admitSqlitePluginQuery,
  loadSqlitePluginQuery,
  saveSqlitePluginQuery,
  assertPluginQueryReplay,
} from "./plugin-query-task-store-support.ts";
import {
  admitSqlitePluginTask,
  assertPluginTaskAdmissionReplay,
  capturePluginTaskTurnInput,
  checkedPluginTaskAdmission,
  loadSqlitePluginTask,
  saveSqlitePluginTask,
} from "./plugin-task-admission-store-support.ts";
import { reserveSqlitePluginCreditsWithinTransaction } from "./sqlite-plugin-credit-reservation.ts";
import {
  checkedExtensionCreditAdmission,
  assertExtensionCreditReplayPrincipal,
  decodeExtensionCreditAdmission,
  assertExtensionCreditAdmissionLink,
  extensionCreditAdmissionSchemaSql,
  assertExtensionCreditSchemaVersion,
} from "./extension-credit-admission-records.ts";
import {
  assertCreditReservationReplay,
  creditScopeValues,
  decodeCreditReservation,
} from "./plugin-credit-support.ts";

type SqliteExtensionStoreHost = Readonly<{
  assertOpen(): void;
  commitRunWithinTransaction(input: CommitRunInput): CommitRunResult;
  commitTurnWithinTransaction(
    input: CommitTurnStartInput,
  ): CommitTurnStartResult;
}>;

export class SqliteExtensionStore implements ExtensionStore {
  readonly pluginAdmissionVersion = "crewon.plugin-task-admission.v1" as const;
  readonly pluginQueryAdmissionVersion =
    "crewon.plugin-query-task-admission.v1" as const;
  readonly creditAdmissionVersion =
    "crewon.extension-credit-admission.v0" as const;
  readonly #db: DatabaseSync;
  readonly #host: SqliteExtensionStoreHost;
  constructor(database: DatabaseSync, host: SqliteExtensionStoreHost) {
    this.#db = database;
    this.#host = host;
  }

  async migrate() {
    this.#transaction(() => {
      this.#db
        .exec(`CREATE TABLE IF NOT EXISTS extension_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL) STRICT;
      INSERT INTO extension_schema_version VALUES (1, 1) ON CONFLICT (id) DO NOTHING;`);
      const version = this.#db
        .prepare("SELECT version FROM extension_schema_version WHERE id = 1")
        .get() as { version: number };
      if (version.version !== 1)
        throw new Error("extension_schema_version_unsupported");
      this.#db.exec(`
      CREATE TABLE IF NOT EXISTS extension_configurations (
        tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0), configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
        PRIMARY KEY (tenant_id, space_id, plugin_id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS extension_activations (
        tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0), configuration_revision INTEGER NOT NULL, activation_json TEXT NOT NULL CHECK (json_valid(activation_json)),
        PRIMARY KEY (tenant_id, space_id, plugin_id),
        FOREIGN KEY (tenant_id, space_id, plugin_id, configuration_revision) REFERENCES extension_configurations (tenant_id, space_id, plugin_id, revision) ON DELETE RESTRICT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS extension_run_bindings (
        tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, plugin_id TEXT NOT NULL, run_id TEXT NOT NULL,
        configuration_revision INTEGER NOT NULL, binding_json TEXT NOT NULL CHECK (json_valid(binding_json)), PRIMARY KEY (tenant_id, run_id),
        FOREIGN KEY (tenant_id, run_id) REFERENCES run_snapshots (tenant_id, run_id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, space_id, plugin_id, configuration_revision) REFERENCES extension_configurations (tenant_id, space_id, plugin_id, revision) ON DELETE RESTRICT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS extension_mutation_receipts (
        tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('configuration', 'activation', 'task')),
        actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        PRIMARY KEY (tenant_id, space_id, plugin_id, kind, actor_id, idempotency_key)
      ) STRICT;
    `);
      migrateSqliteExternalOperations(this.#db);
    });
  }

  /** Explicit installed-package provenance opt-in; v0 migration and historical bindings stay unchanged. */
  async migratePluginAdmissions(): Promise<void> {
    this.#transaction(() => {
      migrateSqlitePluginTaskAdmissions(this.#db);
      migrateSqlitePluginQueryTasks(this.#db);
    });
  }

  async loadPluginQueryTaskAdmission(input: ExtensionRunLocator) {
    this.#host.assertOpen();
    return loadSqlitePluginQuery(this.#db, input);
  }

  async loadPluginTaskAdmission(input: ExtensionRunLocator) {
    this.#host.assertOpen();
    return loadSqlitePluginTask(this.#db, input);
  }

  /** Explicit billing opt-in. Ordinary plugin migration never creates or reads credit tables. */
  async migrateCredits(): Promise<void> {
    this.#transaction(() => {
      migrateSqlitePluginCredits(this.#db);
      this.#db.exec(extensionCreditAdmissionSchemaSql({ dialect: "sqlite" }));
      assertExtensionCreditSchemaVersion(
        this.#db
          .prepare(
            "SELECT id,version FROM extension_credit_schema_version LIMIT 2",
          )
          .all() as { id: unknown; version: unknown }[],
      );
      this.#db
        .prepare(
          "SELECT tenant_id,space_id,run_id,principal_id,pool_id,reservation_id,admission_json FROM extension_credit_admissions LIMIT 0",
        )
        .all();
    });
  }

  async loadExtensionCreditAdmission(
    input: ExtensionRunLocator,
  ): Promise<ExtensionCreditAdmission | null> {
    this.#host.assertOpen();
    const admission = this.#creditAdmission(input);
    if (admission !== null) this.#verifyCreditAdmission(admission);
    return admission;
  }

  async saveExtensionConfiguration(input: SaveExtensionConfigurationInput) {
    const configuration = validateConfigurationSave(input);
    return this.#transaction(() => {
      const replay = this.#receipt(
        configuration,
        "configuration",
        input.receipt,
      );
      if (replay !== null) {
        const old = parseExtensionConfiguration(replay, extensionStoreDigester);
        assertExtensionReplay(old, configuration);
        return { disposition: "replayed" as const, configuration: old };
      }
      const latest = this.#latest(configuration);
      if ((latest?.revision ?? 0) !== input.expectedRevision)
        throw new Error("extension_configuration_revision_conflict");
      this.#db
        .prepare(`INSERT INTO extension_configurations VALUES (?, ?, ?, ?, ?)`)
        .run(
          ...extensionScopeValues(configuration),
          configuration.revision,
          JSON.stringify(configuration),
        );
      this.#saveReceipt(
        configuration,
        "configuration",
        input.receipt,
        configuration,
      );
      return { disposition: "created" as const, configuration };
    });
  }

  async loadExtensionConfiguration(
    input: ExtensionScope & { revision: number },
  ) {
    this.#host.assertOpen();
    extensionRevision(input.revision);
    return this.#configuration(input, input.revision);
  }
  async loadLatestExtensionConfiguration(input: ExtensionScope) {
    this.#host.assertOpen();
    return this.#latest(input);
  }
  async loadExtensionConfigurationReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ) {
    this.#host.assertOpen();
    const value = this.#receipt(input, "configuration", input.receipt);
    return value === null
      ? null
      : parseExtensionConfigurationReceipt(value, input, input.receipt);
  }
  async loadExtensionActivationReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ) {
    this.#host.assertOpen();
    const value = this.#receipt(input, "activation", input.receipt);
    return value === null
      ? null
      : parseExtensionActivationReceipt(value, input, input.receipt);
  }
  async loadExtensionActivation(input: ExtensionScope) {
    this.#host.assertOpen();
    return this.#activation(input);
  }

  async saveExtensionActivation(input: SaveExtensionActivationInput) {
    const activation = validateActivationSave(input);
    return this.#transaction(() => {
      const replay = this.#receipt(activation, "activation", input.receipt);
      if (replay !== null) {
        const old = parseExtensionActivation(replay);
        assertExtensionReplay(old, activation);
        return { disposition: "replayed" as const, activation: old };
      }
      if (
        (this.#activation(activation)?.revision ?? 0) !== input.expectedRevision
      )
        throw new Error("extension_activation_revision_conflict");
      assertExtensionConfigurationReference(
        this.#configuration(activation, activation.configurationRevision),
        activation,
      );
      if (activation.state === "enabled")
        this.#assertDeployment(activation.tenantId, activation.target!);
      this.#db
        .prepare(
          `INSERT INTO extension_activations VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, space_id, plugin_id) DO UPDATE SET revision = excluded.revision, configuration_revision = excluded.configuration_revision, activation_json = excluded.activation_json`,
        )
        .run(
          ...extensionScopeValues(activation),
          activation.revision,
          activation.configurationRevision,
          JSON.stringify(activation),
        );
      this.#saveReceipt(activation, "activation", input.receipt, activation);
      return { disposition: "updated" as const, activation };
    });
  }

  async loadExtensionRunBinding(input: ExtensionRunLocator) {
    this.#host.assertOpen();
    return this.#binding(input);
  }
  async loadExtensionRunReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ) {
    this.#host.assertOpen();
    const value = this.#receipt(input, "task", input.receipt);
    return value === null
      ? null
      : this.#verifyCreditReceipt(
          parseExtensionTaskReceipt(value, input, input.receipt),
        );
  }

  async commitExtensionRun(input: CommitExtensionRunInput) {
    const binding = validateExtensionRunCommit(input);
    return this.#transaction(() => {
      const replay = this.#receipt(binding, "task", input.receipt);
      if (replay !== null)
        return this.#verifyCreditReceipt(
          parseExtensionTaskReceipt(replay, binding, input.receipt),
        );
      this.#admit(binding, input.expectedActivationRevision);
      const run = this.#host.commitRunWithinTransaction(
        extensionTaskCommit(input),
      );
      if (run.disposition !== "committed" || run.state.runId !== binding.runId)
        throw new Error("extension_unbound_run_receipt");
      this.#db
        .prepare(`INSERT INTO extension_run_bindings VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          ...extensionScopeValues(binding),
          binding.runId,
          binding.configurationRevision,
          JSON.stringify(binding),
        );
      const result = { run, binding };
      this.#saveReceipt(binding, "task", input.receipt, result);
      return result;
    });
  }

  async loadExtensionTurnReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ) {
    this.#host.assertOpen();
    const value = this.#receipt(input, "task", input.receipt);
    return value === null
      ? null
      : this.#verifyCreditReceipt(
          parseExtensionTurnReceipt(value, input, input.receipt),
        );
  }

  async commitExtensionTurn(input: CommitExtensionTurnInput) {
    const pluginQuery = checkedPluginQueryTurn(input);
    if (pluginQuery !== undefined)
      input = structuredClone({ ...input, pluginQueryAdmission: pluginQuery });
    const pluginAdmission = checkedPluginTaskAdmission(input);
    if (pluginAdmission !== undefined)
      input = capturePluginTaskTurnInput(input, pluginAdmission);
    const binding = validateExtensionTurnCommit(input);
    const creditAdmission = checkedExtensionCreditAdmission({
      admission: input.creditAdmission,
      binding,
      receipt: input.receipt,
    });
    return this.#transaction(() => {
      const replay = this.#receipt(binding, "task", input.receipt);
      if (replay !== null) {
        const saved = this.#verifyCreditReceipt(
          parseExtensionTurnReceipt(replay, binding, input.receipt),
        );
        assertExtensionCreditReplayPrincipal({
          saved: saved.creditAdmission,
          requested: creditAdmission,
        });
        if (pluginAdmission !== undefined)
          assertPluginTaskAdmissionReplay({
            requested: pluginAdmission,
            saved: loadSqlitePluginTask(this.#db, saved.binding),
            binding: saved.binding,
            receipt: input.receipt,
            creditAdmission: saved.creditAdmission,
          });
        if (pluginQuery !== undefined)
          assertPluginQueryReplay(
            pluginQuery,
            loadSqlitePluginQuery(this.#db, saved.binding),
            saved.binding,
            input.receipt,
          );
        return saved;
      }
      if (pluginAdmission !== undefined)
        admitSqlitePluginTask(this.#db, pluginAdmission);
      if (pluginQuery !== undefined)
        admitSqlitePluginQuery(this.#db, pluginQuery, binding);
      this.#admit(binding, input.expectedActivationRevision);
      if (creditAdmission !== undefined) {
        try {
          const reserved = reserveSqlitePluginCreditsWithinTransaction(
            this.#db,
            creditAdmission.reservation,
          );
          if (reserved.disposition !== "created")
            throw new Error("extension_credit_orphaned_reservation");
        } catch (error) {
          if (
            error instanceof CreditLedgerError &&
            [
              "plugin_credit_idempotency_conflict",
              "plugin_credit_reservation_id_conflict",
            ].includes(error.code)
          )
            throw new Error("extension_credit_orphaned_reservation", {
              cause: error,
            });
          throw error;
        }
      }
      const turn = this.#host.commitTurnWithinTransaction(
        extensionTurnCommit(input),
      );
      if (
        turn.disposition !== "committed" ||
        turn.runState.runId !== binding.runId
      )
        throw new Error("extension_unbound_turn_receipt");
      this.#db
        .prepare(`INSERT INTO extension_run_bindings VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          ...extensionScopeValues(binding),
          binding.runId,
          binding.configurationRevision,
          JSON.stringify(binding),
        );
      if (creditAdmission !== undefined)
        this.#saveCreditAdmission(creditAdmission);
      if (pluginAdmission !== undefined)
        saveSqlitePluginTask(this.#db, pluginAdmission);
      if (pluginQuery !== undefined)
        saveSqlitePluginQuery(this.#db, pluginQuery);
      const result = extensionTurnResult(turn, binding, creditAdmission);
      this.#saveReceipt(binding, "task", input.receipt, result);
      return result;
    });
  }

  #creditAdmission(
    input: ExtensionRunLocator,
  ): ExtensionCreditAdmission | null {
    extensionOpaqueId(input.tenantId);
    extensionOpaqueId(input.spaceId);
    extensionOpaqueId(input.runId);
    const row = this.#db
      .prepare(
        "SELECT tenant_id,space_id,run_id,principal_id,pool_id,reservation_id,admission_json FROM extension_credit_admissions WHERE tenant_id=? AND space_id=? AND run_id=?",
      )
      .get(input.tenantId, input.spaceId, input.runId);
    return decodeExtensionCreditAdmission(
      row as Parameters<typeof decodeExtensionCreditAdmission>[0],
    );
  }

  #saveCreditAdmission(admission: ExtensionCreditAdmission): void {
    this.#db
      .prepare("INSERT INTO extension_credit_admissions VALUES(?,?,?,?,?,?,?)")
      .run(
        admission.tenantId,
        admission.spaceId,
        admission.runId,
        admission.reservation.scope.principalId,
        admission.reservation.scope.poolId,
        admission.reservation.reservationId,
        JSON.stringify(admission),
      );
  }

  #verifyCreditReceipt<T extends CommitExtensionRunResult>(result: T): T {
    if (result.creditAdmission !== undefined)
      this.#verifyCreditAdmission(result.creditAdmission);
    return result;
  }

  #verifyCreditAdmission(admission: ExtensionCreditAdmission): void {
    assertExtensionCreditAdmissionLink({
      admission,
      linked: this.#creditAdmission(admission),
    });
    const row = this.#db
      .prepare(
        "SELECT reservation_id,idempotency_key,record_json FROM plugin_credit_reservations WHERE tenant_id=? AND principal_id=? AND pool_id=? AND reservation_id=?",
      )
      .get(
        ...creditScopeValues(admission.reservation.scope),
        admission.reservation.reservationId,
      );
    const reservation = decodeCreditReservation(
      row as Parameters<typeof decodeCreditReservation>[0],
      admission.reservation.scope,
    );
    if (reservation === null)
      throw new Error("extension_credit_admission_link_mismatch");
    assertCreditReservationReplay(reservation, admission.reservation);
  }

  #admit(binding: ExtensionRunBinding, expectedActivationRevision: number) {
    assertExtensionAdmission(
      binding,
      this.#activation(binding),
      expectedActivationRevision,
      this.#configuration(binding, binding.configurationRevision),
    );
    this.#assertDeployment(binding.tenantId, binding.target);
    if (binding.source !== null) {
      const source = this.#binding({
        tenantId: binding.tenantId,
        spaceId: binding.spaceId,
        runId: binding.source.runId,
      });
      const operation = this.#db
        .prepare(
          `SELECT 1 FROM extension_external_operations WHERE tenant_id = ? AND run_id = ? AND binding_digest = ? AND operation_id = ?`,
        )
        .get(
          binding.tenantId,
          binding.source.runId,
          binding.source.bindingDigest,
          binding.source.operationId,
        );
      assertExtensionQuerySource(binding, source, operation !== undefined);
    }
  }

  #configuration(scope: ExtensionScope, revision: number) {
    const row = this.#db
      .prepare(
        `SELECT configuration_json FROM extension_configurations WHERE tenant_id = ? AND space_id = ? AND plugin_id = ? AND revision = ?`,
      )
      .get(...extensionScopeValues(scope), revision) as
      | { configuration_json: string }
      | undefined;
    return row === undefined
      ? null
      : parseExtensionConfiguration(
          JSON.parse(row.configuration_json),
          extensionStoreDigester,
        );
  }
  #latest(scope: ExtensionScope) {
    const row = this.#db
      .prepare(
        `SELECT configuration_json FROM extension_configurations WHERE tenant_id = ? AND space_id = ? AND plugin_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(...extensionScopeValues(scope)) as
      | { configuration_json: string }
      | undefined;
    return row === undefined
      ? null
      : parseExtensionConfiguration(
          JSON.parse(row.configuration_json),
          extensionStoreDigester,
        );
  }
  #activation(scope: ExtensionScope) {
    const row = this.#db
      .prepare(
        `SELECT activation_json FROM extension_activations WHERE tenant_id = ? AND space_id = ? AND plugin_id = ?`,
      )
      .get(...extensionScopeValues(scope)) as
      | { activation_json: string }
      | undefined;
    return row === undefined
      ? null
      : parseExtensionActivation(JSON.parse(row.activation_json));
  }
  #binding(input: ExtensionRunLocator) {
    extensionOpaqueId(input.tenantId);
    extensionOpaqueId(input.spaceId);
    extensionOpaqueId(input.runId);
    const row = this.#db
      .prepare(
        `SELECT binding_json FROM extension_run_bindings WHERE tenant_id = ? AND space_id = ? AND run_id = ?`,
      )
      .get(input.tenantId, input.spaceId, input.runId) as
      | { binding_json: string }
      | undefined;
    return row === undefined
      ? null
      : parseExtensionRunBinding(
          JSON.parse(row.binding_json),
          extensionStoreDigester,
        );
  }
  #assertDeployment(tenantId: string, target: ExtensionExecutionTarget) {
    const asset = this.#db
      .prepare(
        `SELECT content_digest, asset_json FROM agent_versions WHERE tenant_id = ? AND agent_version_id = ?`,
      )
      .get(tenantId, target.agentVersionId) as
      | { content_digest: string; asset_json: string }
      | undefined;
    const deployment = this.#db
      .prepare(
        `SELECT deployment_json FROM agent_version_deployments WHERE tenant_id = ? AND agent_version_id = ?`,
      )
      .get(tenantId, target.agentVersionId) as
      | { deployment_json: string }
      | undefined;
    assertExtensionDeployment(
      target,
      asset === undefined
        ? undefined
        : {
            content_digest: asset.content_digest,
            definition_json: JSON.parse(asset.asset_json).definitionJson,
          },
      deployment === undefined ? null : JSON.parse(deployment.deployment_json),
    );
  }
  #receipt(
    scope: ExtensionScope,
    kind: string,
    receipt: ExtensionMutationReceipt,
  ): unknown | null {
    validateExtensionReceipt(receipt);
    const row = this.#db
      .prepare(
        `SELECT request_digest, result_json FROM extension_mutation_receipts WHERE tenant_id = ? AND space_id = ? AND plugin_id = ? AND kind = ? AND actor_id = ? AND idempotency_key = ?`,
      )
      .get(
        ...extensionScopeValues(scope),
        kind,
        receipt.actorId,
        receipt.idempotencyKey,
      ) as { request_digest: string; result_json: string } | undefined;
    if (row === undefined) return null;
    if (row.request_digest !== receipt.requestDigest)
      throw new Error("extension_idempotency_conflict");
    return JSON.parse(row.result_json);
  }
  #saveReceipt(
    scope: ExtensionScope,
    kind: string,
    receipt: ExtensionMutationReceipt,
    result: unknown,
  ) {
    this.#db
      .prepare(
        `INSERT INTO extension_mutation_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...extensionScopeValues(scope),
        kind,
        receipt.actorId,
        receipt.idempotencyKey,
        receipt.requestDigest,
        JSON.stringify(result),
      );
  }
  #transaction<T>(body: () => T): T {
    this.#host.assertOpen();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}
