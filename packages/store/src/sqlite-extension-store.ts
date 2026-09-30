import type { DatabaseSync } from "node:sqlite";
import {
  extensionOpaqueId,
  extensionRevision,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionRunBinding,
  type ExtensionScope,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import type {
  CommitExtensionRunInput,
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
} from "./extension-store-records.ts";
import { migrateSqliteExternalOperations } from "./sqlite-external-operation-store.ts";

type SqliteExtensionStoreHost = Readonly<{
  assertOpen(): void;
  commitRunWithinTransaction(input: CommitRunInput): CommitRunResult;
}>;

export class SqliteExtensionStore implements ExtensionStore {
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
      : parseExtensionTaskReceipt(value, input, input.receipt);
  }

  async commitExtensionRun(input: CommitExtensionRunInput) {
    const binding = validateExtensionRunCommit(input);
    return this.#transaction(() => {
      const replay = this.#receipt(binding, "task", input.receipt);
      if (replay !== null)
        return parseExtensionTaskReceipt(replay, binding, input.receipt);
      assertExtensionAdmission(
        binding,
        this.#activation(binding),
        input.expectedActivationRevision,
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
