import type { Pool, PoolClient } from "pg";
import {
  extensionOpaqueId,
  extensionRevision,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionRunBinding,
  type ExtensionScope,
  type ExtensionExecutionTarget,
  type ExtensionRunBinding,
} from "@crewon/domain";
import type {
  CommitExtensionRunInput,
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

type PostgresExtensionStoreHost = Readonly<{
  assertOpen(): void;
  commitRunWithinTransaction(
    client: PoolClient,
    input: CommitRunInput,
  ): Promise<CommitRunResult>;
  commitTurnWithinTransaction(
    client: PoolClient,
    input: CommitTurnStartInput,
  ): Promise<CommitTurnStartResult>;
}>;

export class PostgresExtensionStore implements ExtensionStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #host: PostgresExtensionStoreHost;
  constructor(pool: Pool, schema: string, host: PostgresExtensionStoreHost) {
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
      throw new Error("extension_schema_invalid");
    this.#pool = pool;
    this.#schema = `"${schema}"`;
    this.#host = host;
  }

  async migrate() {
    this.#host.assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `extension-schema:${this.#schema}`,
      ]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.#schema}.extension_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
        INSERT INTO ${this.#schema}.extension_schema_version VALUES (1, 1) ON CONFLICT (id) DO NOTHING;
      `);
      const version = await client.query<{ version: number }>(
        `SELECT version FROM ${this.#schema}.extension_schema_version WHERE id = 1`,
      );
      if (version.rows[0]?.version !== 1)
        throw new Error("extension_schema_version_unsupported");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.#schema}.extension_configurations (
          tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0), configuration_json JSONB NOT NULL,
          PRIMARY KEY (tenant_id, space_id, plugin_id, revision)
        );
        CREATE TABLE IF NOT EXISTS ${this.#schema}.extension_activations (
          tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0), configuration_revision INTEGER NOT NULL, activation_json JSONB NOT NULL,
          PRIMARY KEY (tenant_id, space_id, plugin_id),
          FOREIGN KEY (tenant_id, space_id, plugin_id, configuration_revision) REFERENCES ${this.#schema}.extension_configurations (tenant_id, space_id, plugin_id, revision) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS ${this.#schema}.extension_run_bindings (
          tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, plugin_id TEXT NOT NULL, run_id TEXT NOT NULL,
          configuration_revision INTEGER NOT NULL, binding_json JSONB NOT NULL, PRIMARY KEY (tenant_id, run_id),
          FOREIGN KEY (tenant_id, run_id) REFERENCES ${this.#schema}.run_snapshots (tenant_id, run_id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, space_id, plugin_id, configuration_revision) REFERENCES ${this.#schema}.extension_configurations (tenant_id, space_id, plugin_id, revision) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS ${this.#schema}.extension_mutation_receipts (
          tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('configuration', 'activation', 'task')),
          actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, result_json JSONB NOT NULL,
          PRIMARY KEY (tenant_id, space_id, plugin_id, kind, actor_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS ${this.#schema}.extension_external_operations (
          tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, binding_digest TEXT NOT NULL,
          operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0), record_json JSONB NOT NULL,
          PRIMARY KEY (tenant_id, run_id, binding_digest, operation_id),
          UNIQUE (tenant_id, run_id, binding_digest, idempotency_key)
        );
      `);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async saveExtensionConfiguration(input: SaveExtensionConfigurationInput) {
    const configuration = validateConfigurationSave(input);
    return this.#transaction(configuration, async (client) => {
      const replay = await this.#receipt(
        client,
        configuration,
        "configuration",
        input.receipt,
      );
      if (replay !== null) {
        const old = parseExtensionConfiguration(replay, extensionStoreDigester);
        assertExtensionReplay(old, configuration);
        return { disposition: "replayed" as const, configuration: old };
      }
      const latest = await this.#latest(client, configuration);
      if ((latest?.revision ?? 0) !== input.expectedRevision)
        throw new Error("extension_configuration_revision_conflict");
      await client.query(
        `INSERT INTO ${this.#schema}.extension_configurations VALUES ($1, $2, $3, $4, $5)`,
        [
          ...extensionScopeValues(configuration),
          configuration.revision,
          configuration,
        ],
      );
      await this.#saveReceipt(
        client,
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
    return this.#configuration(this.#pool, input, input.revision);
  }
  async loadLatestExtensionConfiguration(input: ExtensionScope) {
    this.#host.assertOpen();
    return this.#latest(this.#pool, input);
  }
  async loadExtensionConfigurationReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ) {
    this.#host.assertOpen();
    const value = await this.#receipt(
      this.#pool,
      input,
      "configuration",
      input.receipt,
    );
    return value === null
      ? null
      : parseExtensionConfigurationReceipt(value, input, input.receipt);
  }
  async loadExtensionActivationReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ) {
    this.#host.assertOpen();
    const value = await this.#receipt(
      this.#pool,
      input,
      "activation",
      input.receipt,
    );
    return value === null
      ? null
      : parseExtensionActivationReceipt(value, input, input.receipt);
  }
  async loadExtensionActivation(input: ExtensionScope) {
    this.#host.assertOpen();
    return this.#activation(this.#pool, input);
  }

  async saveExtensionActivation(input: SaveExtensionActivationInput) {
    const activation = validateActivationSave(input);
    return this.#transaction(activation, async (client) => {
      const replay = await this.#receipt(
        client,
        activation,
        "activation",
        input.receipt,
      );
      if (replay !== null) {
        const old = parseExtensionActivation(replay);
        assertExtensionReplay(old, activation);
        return { disposition: "replayed" as const, activation: old };
      }
      if (
        ((await this.#activation(client, activation))?.revision ?? 0) !==
        input.expectedRevision
      )
        throw new Error("extension_activation_revision_conflict");
      assertExtensionConfigurationReference(
        await this.#configuration(
          client,
          activation,
          activation.configurationRevision,
        ),
        activation,
      );
      if (activation.state === "enabled")
        await this.#assertDeployment(
          client,
          activation.tenantId,
          activation.target!,
        );
      await client.query(
        `INSERT INTO ${this.#schema}.extension_activations VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tenant_id, space_id, plugin_id) DO UPDATE SET revision = excluded.revision, configuration_revision = excluded.configuration_revision, activation_json = excluded.activation_json`,
        [
          ...extensionScopeValues(activation),
          activation.revision,
          activation.configurationRevision,
          activation,
        ],
      );
      await this.#saveReceipt(
        client,
        activation,
        "activation",
        input.receipt,
        activation,
      );
      return { disposition: "updated" as const, activation };
    });
  }

  async loadExtensionRunBinding(input: ExtensionRunLocator) {
    this.#host.assertOpen();
    return this.#binding(this.#pool, input);
  }
  async loadExtensionRunReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ) {
    this.#host.assertOpen();
    const value = await this.#receipt(this.#pool, input, "task", input.receipt);
    return value === null
      ? null
      : parseExtensionTaskReceipt(value, input, input.receipt);
  }

  async commitExtensionRun(input: CommitExtensionRunInput) {
    const binding = validateExtensionRunCommit(input);
    return this.#transaction(binding, async (client) => {
      const replay = await this.#receipt(
        client,
        binding,
        "task",
        input.receipt,
      );
      if (replay !== null)
        return parseExtensionTaskReceipt(replay, binding, input.receipt);
      await this.#admit(client, binding, input.expectedActivationRevision);
      const run = await this.#host.commitRunWithinTransaction(
        client,
        extensionTaskCommit(input),
      );
      if (run.disposition !== "committed" || run.state.runId !== binding.runId)
        throw new Error("extension_unbound_run_receipt");
      await client.query(
        `INSERT INTO ${this.#schema}.extension_run_bindings VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          ...extensionScopeValues(binding),
          binding.runId,
          binding.configurationRevision,
          binding,
        ],
      );
      const result = { run, binding };
      await this.#saveReceipt(client, binding, "task", input.receipt, result);
      return result;
    });
  }

  async loadExtensionTurnReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ) {
    this.#host.assertOpen();
    const value = await this.#receipt(this.#pool, input, "task", input.receipt);
    return value === null
      ? null
      : parseExtensionTurnReceipt(value, input, input.receipt);
  }

  async commitExtensionTurn(input: CommitExtensionTurnInput) {
    // Retain one snapshot while the PostgreSQL transaction awaits independent Store operations.
    const frozenInput = structuredClone(input);
    const binding = validateExtensionTurnCommit(frozenInput);
    return this.#transaction(binding, async (client) => {
      const replay = await this.#receipt(
        client,
        binding,
        "task",
        frozenInput.receipt,
      );
      if (replay !== null)
        return parseExtensionTurnReceipt(replay, binding, frozenInput.receipt);
      await this.#admit(
        client,
        binding,
        frozenInput.expectedActivationRevision,
      );
      const turn = await this.#host.commitTurnWithinTransaction(
        client,
        extensionTurnCommit(frozenInput),
      );
      if (
        turn.disposition !== "committed" ||
        turn.runState.runId !== binding.runId
      )
        throw new Error("extension_unbound_turn_receipt");
      await client.query(
        `INSERT INTO ${this.#schema}.extension_run_bindings VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          ...extensionScopeValues(binding),
          binding.runId,
          binding.configurationRevision,
          binding,
        ],
      );
      const result = extensionTurnResult(turn, binding);
      await this.#saveReceipt(
        client,
        binding,
        "task",
        frozenInput.receipt,
        result,
      );
      return result;
    });
  }

  async #admit(
    client: PoolClient,
    binding: ExtensionRunBinding,
    expectedActivationRevision: number,
  ) {
    assertExtensionAdmission(
      binding,
      await this.#activation(client, binding),
      expectedActivationRevision,
      await this.#configuration(client, binding, binding.configurationRevision),
    );
    await this.#assertDeployment(client, binding.tenantId, binding.target);
    if (binding.source !== null) {
      const source = await this.#binding(client, {
        tenantId: binding.tenantId,
        spaceId: binding.spaceId,
        runId: binding.source.runId,
      });
      const operation = await client.query(
        `SELECT 1 FROM ${this.#schema}.extension_external_operations WHERE tenant_id = $1 AND run_id = $2 AND binding_digest = $3 AND operation_id = $4`,
        [
          binding.tenantId,
          binding.source.runId,
          binding.source.bindingDigest,
          binding.source.operationId,
        ],
      );
      assertExtensionQuerySource(binding, source, operation.rows.length > 0);
    }
  }

  async #configuration(
    client: Pool | PoolClient,
    scope: ExtensionScope,
    revision: number,
  ) {
    const result = await client.query<{ configuration_json: unknown }>(
      `SELECT configuration_json FROM ${this.#schema}.extension_configurations WHERE tenant_id = $1 AND space_id = $2 AND plugin_id = $3 AND revision = $4`,
      [...extensionScopeValues(scope), revision],
    );
    return result.rows[0] === undefined
      ? null
      : parseExtensionConfiguration(
          result.rows[0].configuration_json,
          extensionStoreDigester,
        );
  }
  async #latest(client: Pool | PoolClient, scope: ExtensionScope) {
    const result = await client.query<{ configuration_json: unknown }>(
      `SELECT configuration_json FROM ${this.#schema}.extension_configurations WHERE tenant_id = $1 AND space_id = $2 AND plugin_id = $3 ORDER BY revision DESC LIMIT 1`,
      extensionScopeValues(scope),
    );
    return result.rows[0] === undefined
      ? null
      : parseExtensionConfiguration(
          result.rows[0].configuration_json,
          extensionStoreDigester,
        );
  }
  async #activation(client: Pool | PoolClient, scope: ExtensionScope) {
    const result = await client.query<{ activation_json: unknown }>(
      `SELECT activation_json FROM ${this.#schema}.extension_activations WHERE tenant_id = $1 AND space_id = $2 AND plugin_id = $3`,
      extensionScopeValues(scope),
    );
    return result.rows[0] === undefined
      ? null
      : parseExtensionActivation(result.rows[0].activation_json);
  }
  async #binding(client: Pool | PoolClient, input: ExtensionRunLocator) {
    extensionOpaqueId(input.tenantId);
    extensionOpaqueId(input.spaceId);
    extensionOpaqueId(input.runId);
    const result = await client.query<{ binding_json: unknown }>(
      `SELECT binding_json FROM ${this.#schema}.extension_run_bindings WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
      [input.tenantId, input.spaceId, input.runId],
    );
    return result.rows[0] === undefined
      ? null
      : parseExtensionRunBinding(
          result.rows[0].binding_json,
          extensionStoreDigester,
        );
  }
  async #assertDeployment(
    client: PoolClient,
    tenantId: string,
    target: ExtensionExecutionTarget,
  ) {
    const asset = await client.query<{
      content_digest: string;
      asset_json: { definitionJson: string };
    }>(
      `SELECT content_digest, asset_json FROM ${this.#schema}.agent_versions WHERE tenant_id = $1 AND agent_version_id = $2`,
      [tenantId, target.agentVersionId],
    );
    const deployment = await client.query<{ deployment_json: unknown }>(
      `SELECT deployment_json FROM ${this.#schema}.agent_version_deployments WHERE tenant_id = $1 AND agent_version_id = $2`,
      [tenantId, target.agentVersionId],
    );
    assertExtensionDeployment(
      target,
      asset.rows[0] === undefined
        ? undefined
        : {
            content_digest: asset.rows[0].content_digest,
            definition_json: asset.rows[0].asset_json.definitionJson,
          },
      deployment.rows[0]?.deployment_json ?? null,
    );
  }
  async #receipt(
    client: Pool | PoolClient,
    scope: ExtensionScope,
    kind: string,
    receipt: ExtensionMutationReceipt,
  ): Promise<unknown | null> {
    validateExtensionReceipt(receipt);
    const result = await client.query<{
      request_digest: string;
      result_json: unknown;
    }>(
      `SELECT request_digest, result_json FROM ${this.#schema}.extension_mutation_receipts WHERE tenant_id = $1 AND space_id = $2 AND plugin_id = $3 AND kind = $4 AND actor_id = $5 AND idempotency_key = $6`,
      [
        ...extensionScopeValues(scope),
        kind,
        receipt.actorId,
        receipt.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.request_digest !== receipt.requestDigest)
      throw new Error("extension_idempotency_conflict");
    return row.result_json;
  }
  async #saveReceipt(
    client: PoolClient,
    scope: ExtensionScope,
    kind: string,
    receipt: ExtensionMutationReceipt,
    result: unknown,
  ) {
    await client.query(
      `INSERT INTO ${this.#schema}.extension_mutation_receipts VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ...extensionScopeValues(scope),
        kind,
        receipt.actorId,
        receipt.idempotencyKey,
        receipt.requestDigest,
        JSON.stringify(result),
      ],
    );
  }
  async #transaction<T>(
    scope: ExtensionScope,
    body: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    this.#host.assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        JSON.stringify([
          "extension",
          this.#schema,
          ...extensionScopeValues(scope),
        ]),
      ]);
      const result = await body(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
