import type { Client, Pool, PoolClient } from "pg";
import type {
  PluginCompositionStore,
  CommitPluginCompositionInput,
  PluginCompositionCommitResult,
} from "@crewon/application";
import {
  assertPluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import { pluginCompositionSchemaSql } from "./plugin-composition-schema.ts";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import {
  compositionProfile,
  assertCompositionVersion,
  compositionCommit,
  compositionRead,
  compositionScopeValues,
  compositionStoreFail,
  decodeCompositionRow,
} from "./plugin-composition-store-records.ts";
import {
  admitPostgresProjectToolInstallationPin,
  assertPostgresPluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import {
  lockPluginInstallationProfile,
  type PluginInstallationProfileBinding,
} from "./postgres-plugin-installation-profile-support.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
type Reader = Pool | PoolClient | Client;
const where = "tenant_id=$1 AND space_id=$2 AND profile_id=$3";
/** Uses the installation owner's pool, profile writer lock and dedicated owner queue. */
export class PostgresPluginCompositionStore implements PluginCompositionStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #open: () => void;
  readonly #binding: PluginInstallationProfileBinding | undefined;
  constructor(input: {
    pool: Pool;
    schema: string;
    assertOpen(): void;
    binding?: PluginInstallationProfileBinding;
  }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    this.#prefix = `${pluginInstallationSchemaName(input.schema)}.`;
    this.#binding = input.binding;
    this.#open = () => {
      input.assertOpen();
      input.binding?.assertOpen();
    };
  }
  async migrate(): Promise<void> {
    this.#open();
    if (this.#binding)
      compositionStoreFail("plugin_profile_owner_operation_invalid");
    await this.#transaction(
      async (client) => {
        await assertPostgresPluginInstallationPinSchema(
          client as PoolClient,
          this.#schema,
        );
        await this.#query(
          client,
          pluginCompositionSchemaSql({
            dialect: "postgres",
            schema: this.#schema,
          }),
        );
        await this.#version(client);
      },
      { checkVersion: false },
    );
  }
  async loadCurrent(
    input: Parameters<PluginCompositionStore["loadCurrent"]>[0],
  ) {
    this.#open();
    const { scope } = compositionRead(input, { kind: "current" });
    this.#scope(scope);
    return this.#read(async (client) => {
      // One statement gives a consistent head/body snapshot under READ COMMITTED.
      const result = await this.#query(
        client,
        `SELECT l.* FROM ${this.#prefix}plugin_composition_heads h JOIN ${this.#prefix}plugin_composition_locks l USING(tenant_id,space_id,profile_id,revision,lock_digest) WHERE h.tenant_id=$1 AND h.space_id=$2 AND h.profile_id=$3`,
        compositionScopeValues(scope),
      );
      return result.rows[0]
        ? decodeCompositionRow(result.rows[0], scope)
        : null;
    });
  }
  async loadLock(input: Parameters<PluginCompositionStore["loadLock"]>[0]) {
    this.#open();
    const { scope, lockDigest } = compositionRead(input, { kind: "digest" });
    this.#scope(scope);
    return this.#read(async (client) => {
      const row = await this.#row(client, scope, lockDigest!);
      return row ? decodeCompositionRow(row, scope) : null;
    });
  }
  async commit(
    input: CommitPluginCompositionInput,
  ): Promise<PluginCompositionCommitResult> {
    this.#open();
    const captured = compositionCommit(input);
    this.#scope(captured.scope);
    const operation = () =>
      this.#transaction(async (client) => {
        const { scope, lock, expectedRevision, actor } = captured;
        await lockPluginInstallationProfile(client, this.#schema, scope);
        const existing = await this.#row(client, scope, lock.lockDigest);
        if (existing)
          return Object.freeze({
            disposition: "replayed" as const,
            lock: decodeCompositionRow(existing, scope),
          });
        const heads = await this.#query(
          client,
          `SELECT revision FROM ${this.#prefix}plugin_composition_heads WHERE ${where} FOR UPDATE`,
          compositionScopeValues(scope),
        );
        if (
          (heads.rows[0] ? Number(heads.rows[0].revision) : null) !==
          expectedRevision
        )
          compositionStoreFail("plugin_composition_revision_conflict");
        await assertPostgresPluginInstallationPinSchema(
          client as PoolClient,
          this.#schema,
        );
        const selections = await this.#query(
          client,
          `SELECT count(*) AS count FROM ${this.#prefix}plugin_profile_selections WHERE ${where} AND state='enabled'`,
          compositionScopeValues(scope),
        );
        if (Number(selections.rows[0]?.count) !== lock.nodes.length)
          compositionStoreFail("plugin_composition_selection_conflict");
        for (const node of lock.nodes)
          await admitPostgresProjectToolInstallationPin(
            client as PoolClient,
            this.#schema,
            { ...scope, ...node },
          );
        await this.#query(
          client,
          `INSERT INTO ${this.#prefix}plugin_composition_locks(tenant_id,space_id,profile_id,authority_epoch,revision,lock_digest,actor_id,principal_id,lock_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            ...compositionScopeValues(scope),
            scope.authorityEpoch,
            lock.revision,
            lock.lockDigest,
            actor.actorId,
            actor.principalId,
            JSON.stringify(lock),
          ],
        );
        if (heads.rows[0]) {
          const result = await this.#query(
            client,
            `UPDATE ${this.#prefix}plugin_composition_heads SET revision=$4,lock_digest=$5 WHERE ${where} AND revision=$6`,
            [
              ...compositionScopeValues(scope),
              lock.revision,
              lock.lockDigest,
              expectedRevision,
            ],
          );
          if (result.rowCount !== 1)
            compositionStoreFail("plugin_composition_revision_conflict");
        } else
          await this.#query(
            client,
            `INSERT INTO ${this.#prefix}plugin_composition_heads(tenant_id,space_id,profile_id,revision,lock_digest) VALUES($1,$2,$3,$4,$5)`,
            [...compositionScopeValues(scope), lock.revision, lock.lockDigest],
          );
        return Object.freeze({ disposition: "committed" as const, lock });
      });
    return this.#binding ? this.#binding.runMutation(operation) : operation();
  }
  #scope(scope: PluginProfileScope) {
    if (this.#binding)
      assertPluginProfileScope(this.#binding.scope, compositionProfile(scope));
  }
  async #row(client: Reader, scope: PluginProfileScope, digest: string) {
    return (
      await this.#query(
        client,
        `SELECT * FROM ${this.#prefix}plugin_composition_locks WHERE ${where} AND lock_digest=$4`,
        [...compositionScopeValues(scope), digest],
      )
    ).rows[0];
  }
  async #query(client: Reader, sql: string, values: unknown[] = []) {
    this.#open();
    const result = await client.query<Record<string, unknown>>(sql, values);
    this.#open();
    return result;
  }
  async #version(client: Reader) {
    assertCompositionVersion(
      (
        await this.#query(
          client,
          `SELECT id,version FROM ${this.#prefix}plugin_composition_schema_version LIMIT 2`,
        )
      ).rows,
    );
  }
  #read<T>(body: (client: Reader) => Promise<T>): Promise<T> {
    const operation = async () => {
      const client = this.#binding?.client ?? this.#pool;
      await this.#version(client);
      return body(client);
    };
    return this.#binding ? this.#binding.run(operation) : operation();
  }
  async #transaction<T>(
    body: (client: PoolClient | Client) => Promise<T>,
    options: { checkVersion: boolean } = { checkVersion: true },
  ): Promise<T> {
    this.#open();
    const borrowed = this.#binding ? null : await this.#pool.connect();
    const client = this.#binding?.client ?? borrowed!;
    try {
      await this.#query(client, "BEGIN");
      if (options.checkVersion) await this.#version(client);
      const result = await body(client);
      this.#open();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client as PoolClient);
      throw error;
    } finally {
      borrowed?.release();
    }
  }
}
