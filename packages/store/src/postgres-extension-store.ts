import type { Pool, PoolClient } from "pg";
import { commitPostgresExtensionTurn } from "./postgres-extension-turn-commit.ts";
import {
  migratePostgresProjectGenerations,
  assertPostgresProjectGenerationSchema,
} from "./project-generation-schema.ts";
import {
  decodeProjectGeneration,
  projectGenerationReadSql,
  projectGenerationLocator,
  type ProjectGenerationCommitOptions,
} from "./project-generation-store-support.ts";
import {
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
  parseExtensionTurnReceipt,
} from "./extension-store-records.ts";
import {
  assertExtensionCreditAdmissionLink,
  assertExtensionCreditSchemaVersion,
  decodeExtensionCreditAdmission,
  extensionCreditAdmissionSchemaSql,
} from "./extension-credit-admission-records.ts";
import { migratePostgresPluginCredits } from "./plugin-credit-schema.ts";
import { migratePostgresPluginTaskAdmissionsWithPool } from "./plugin-task-admission-schema.ts";
import { migratePostgresPluginQueryTasks } from "./plugin-query-task-schema.ts";
import { loadPostgresPluginQuery } from "./plugin-query-task-store-support.ts";
import { loadPostgresPluginTask } from "./plugin-task-admission-store-support.ts";
import {
  assertCreditReservationReplay,
  creditScopeValues,
  decodeCreditReservation,
} from "./plugin-credit-support.ts";

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
  readonly pluginAdmissionVersion = "crewon.plugin-task-admission.v1" as const;
  readonly pluginQueryAdmissionVersion =
    "crewon.plugin-query-task-admission.v1" as const;
  readonly creditAdmissionVersion =
    "crewon.extension-credit-admission.v0" as const;
  #projectGenerationsEnabled = false;
  get projectGenerationVersion() {
    return this.#projectGenerationsEnabled
      ? ("crewon.project-generation-link.v0" as const)
      : undefined;
  }
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #schemaName: string;
  readonly #host: PostgresExtensionStoreHost;
  constructor(pool: Pool, schema: string, host: PostgresExtensionStoreHost) {
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
      throw new Error("extension_schema_invalid");
    this.#pool = pool;
    this.#schema = `"${schema}"`;
    this.#schemaName = schema;
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

  /** Explicit installed-package provenance opt-in; v0 migration and historical bindings stay unchanged. */
  async migratePluginAdmissions(): Promise<void> {
    await migratePostgresPluginTaskAdmissionsWithPool({
      pool: this.#pool,
      schema: this.#schemaName,
      assertOpen: () => this.#host.assertOpen(),
    });
    await migratePostgresPluginQueryTasks({
      pool: this.#pool,
      schema: this.#schemaName,
      assertOpen: () => this.#host.assertOpen(),
    });
  }

  /** Explicit opt-in; ordinary extension migration does not inspect project metadata. */
  async migrateProjectGenerations(): Promise<void> {
    this.#host.assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify(["project-generation-migration", this.#schemaName])],
      );
      await migratePostgresProjectGenerations(client, this.#schemaName);
      this.#host.assertOpen();
      await client.query("COMMIT");
      this.#projectGenerationsEnabled = true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async loadProjectGenerationLink(input: ExtensionRunLocator) {
    if (!this.#projectGenerationsEnabled)
      throw new Error("project_generation_unavailable");
    this.#host.assertOpen();
    const locator = projectGenerationLocator(input);
    const client = await this.#pool.connect();
    try {
      await assertPostgresProjectGenerationSchema(client, this.#schemaName);
      const rows = await client.query(
        projectGenerationReadSql(`${this.#schema}.`, true),
        locator,
      );
      this.#host.assertOpen();
      return decodeProjectGeneration(rows.rows[0], {
        tenantId: locator[0],
        spaceId: locator[1],
        runId: locator[2],
      });
    } finally {
      client.release();
    }
  }

  async loadPluginQueryTaskAdmission(input: ExtensionRunLocator) {
    this.#host.assertOpen();
    const value = await loadPostgresPluginQuery(
      this.#pool,
      this.#schemaName,
      input,
    );
    this.#host.assertOpen();
    return value;
  }

  async loadPluginTaskAdmission(input: ExtensionRunLocator) {
    this.#host.assertOpen();
    const admission = await loadPostgresPluginTask(
      this.#pool,
      this.#schemaName,
      input,
    );
    this.#host.assertOpen();
    return admission;
  }

  /** Opt-in ledger and immutable Run/quote linkage; no accounts or funds are created. */
  async migrateCredits(): Promise<void> {
    this.#host.assertOpen();
    const client = await this.#pool.connect();
    try {
      this.#host.assertOpen();
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify(["plugin-credit-migration", this.#schemaName])],
      );
      await migratePostgresPluginCredits(client, this.#schemaName);
      await client.query(
        extensionCreditAdmissionSchemaSql({
          dialect: "postgres",
          schema: this.#schemaName,
        }),
      );
      const version = await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${this.#schema}.extension_credit_schema_version LIMIT 2`,
      );
      assertExtensionCreditSchemaVersion(version.rows);
      await client.query(
        `SELECT tenant_id,space_id,run_id,principal_id,pool_id,reservation_id,admission_json FROM ${this.#schema}.extension_credit_admissions LIMIT 0`,
      );
      this.#host.assertOpen();
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
    if (value === null) return null;
    const result = parseExtensionTaskReceipt(value, input, input.receipt);
    await this.#assertCreditLink(this.#pool, result.creditAdmission);
    return result;
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
      if (replay !== null) {
        const result = parseExtensionTaskReceipt(
          replay,
          binding,
          input.receipt,
        );
        await this.#assertCreditLink(client, result.creditAdmission);
        return result;
      }
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
    if (value === null) return null;
    const result = parseExtensionTurnReceipt(value, input, input.receipt);
    await this.#assertCreditLink(this.#pool, result.creditAdmission);
    return result;
  }

  async loadExtensionCreditAdmission(input: ExtensionRunLocator) {
    this.#host.assertOpen();
    const admission = await this.#creditAdmission(this.#pool, input);
    if (admission !== null) await this.#assertCreditLink(this.#pool, admission);
    return admission;
  }

  async commitExtensionTurn(
    input: CommitExtensionTurnInput,
    options?: ProjectGenerationCommitOptions,
  ) {
    return commitPostgresExtensionTurn(
      {
        schema: this.#schemaName,
        projectGenerationsEnabled: this.#projectGenerationsEnabled,
        assertOpen: () => this.#host.assertOpen(),
        transaction: (scope, body, options) =>
          this.#transaction(scope, body, options),
        receipt: (client, scope, kind, receipt) =>
          this.#receipt(client, scope, kind, receipt),
        saveReceipt: (client, scope, kind, receipt, result) =>
          this.#saveReceipt(client, scope, kind, receipt, result),
        assertCreditLink: (client, admission) =>
          this.#assertCreditLink(client, admission),
        admit: (client, binding, revision) =>
          this.#admit(client, binding, revision),
        commitTurn: (client, turn) =>
          this.#host.commitTurnWithinTransaction(client, turn),
      },
      input,
      options,
    );
  }

  async #creditAdmission(
    client: Pool | PoolClient,
    input: ExtensionRunLocator,
  ) {
    extensionOpaqueId(input.tenantId);
    extensionOpaqueId(input.spaceId);
    extensionOpaqueId(input.runId);
    this.#host.assertOpen();
    const result = await client.query(
      `SELECT tenant_id,space_id,run_id,principal_id,pool_id,reservation_id,admission_json FROM ${this.#schema}.extension_credit_admissions WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3`,
      [input.tenantId, input.spaceId, input.runId],
    );
    this.#host.assertOpen();
    return decodeExtensionCreditAdmission(result.rows[0]);
  }

  async #assertCreditLink(
    client: Pool | PoolClient,
    admission: ExtensionCreditAdmission | undefined,
  ) {
    if (admission === undefined) return;
    assertExtensionCreditAdmissionLink({
      admission,
      linked: await this.#creditAdmission(client, admission),
    });
    this.#host.assertOpen();
    const rows = await client.query(
      `SELECT reservation_id,idempotency_key,record_json FROM ${this.#schema}.plugin_credit_reservations WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 AND reservation_id=$4`,
      [
        ...creditScopeValues(admission.reservation.scope),
        admission.reservation.reservationId,
      ],
    );
    this.#host.assertOpen();
    const reservation = decodeCreditReservation(
      rows.rows[0] as Parameters<typeof decodeCreditReservation>[0],
      admission.reservation.scope,
    );
    if (reservation === null)
      throw new Error("extension_credit_admission_link_mismatch");
    assertCreditReservationReplay(reservation, admission.reservation);
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
    options: { beforeCommit?(): void } = {},
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
      options.beforeCommit?.();
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
