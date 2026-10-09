import type { DatabaseSync } from "node:sqlite";
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
  admitSqliteProjectToolInstallationPin,
  assertSqlitePluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import { withSqlitePluginInstallationWriter } from "./sqlite-plugin-installation-profile-lock.ts";
import {
  assertSqlitePluginInstallationProfileBinding,
  type SqlitePluginInstallationProfileBinding,
} from "./sqlite-plugin-installation-profile-owner.ts";

const where = "tenant_id=? AND space_id=? AND profile_id=?";
type Row = Record<string, unknown>;
/** Shares the installation owner's connection, writer reservation and host lifetime. */
export class SqlitePluginCompositionStore implements PluginCompositionStore {
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  readonly #binding: SqlitePluginInstallationProfileBinding | undefined;
  constructor(input: {
    database: DatabaseSync;
    assertOpen(): void;
    binding?: SqlitePluginInstallationProfileBinding;
  }) {
    if (input.binding)
      assertSqlitePluginInstallationProfileBinding(input.binding);
    this.#db = input.database;
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
    this.#transaction(
      () => {
        assertSqlitePluginInstallationPinSchema(this.#db);
        this.#db.exec(pluginCompositionSchemaSql({ dialect: "sqlite" }));
        this.#version();
      },
      { checkVersion: false },
    );
  }
  async loadCurrent(
    input: Parameters<PluginCompositionStore["loadCurrent"]>[0],
  ) {
    this.#readable();
    const { scope } = compositionRead(input, { kind: "current" });
    this.#scope(scope);
    const head = this.#head(scope);
    if (!head) return null;
    const row = this.#row(scope, String(head.lock_digest));
    if (!row) compositionStoreFail("plugin_composition_record_invalid");
    const lock = decodeCompositionRow(row, scope);
    if (String(head.revision) !== String(lock.revision))
      compositionStoreFail("plugin_composition_record_invalid");
    return lock;
  }
  async loadLock(input: Parameters<PluginCompositionStore["loadLock"]>[0]) {
    this.#readable();
    const { scope, lockDigest } = compositionRead(input, { kind: "digest" });
    this.#scope(scope);
    const row = this.#row(scope, lockDigest!);
    return row ? decodeCompositionRow(row, scope) : null;
  }
  async commit(
    input: CommitPluginCompositionInput,
  ): Promise<PluginCompositionCommitResult> {
    this.#open();
    const captured = compositionCommit(input);
    this.#scope(captured.scope);
    const operation = () => this.#transaction(() => this.#commit(captured));
    return this.#binding
      ? this.#binding.runMutation(operation)
      : Promise.resolve(
          withSqlitePluginInstallationWriter(
            this.#db,
            compositionProfile(captured.scope),
            operation,
          ),
        );
  }
  #commit(input: CommitPluginCompositionInput): PluginCompositionCommitResult {
    const { scope, lock, expectedRevision, actor } = input;
    const existing = this.#row(scope, lock.lockDigest);
    if (existing)
      return Object.freeze({
        disposition: "replayed",
        lock: decodeCompositionRow(existing, scope),
      });
    const head = this.#head(scope);
    if ((head ? Number(head.revision) : null) !== expectedRevision)
      compositionStoreFail("plugin_composition_revision_conflict");
    assertSqlitePluginInstallationPinSchema(this.#db);
    const selected = this.#db
      .prepare(
        `SELECT count(*) AS count FROM plugin_profile_selections WHERE ${where} AND state='enabled'`,
      )
      .get(...compositionScopeValues(scope))!;
    if (Number(selected.count) !== lock.nodes.length)
      compositionStoreFail("plugin_composition_selection_conflict");
    for (const node of lock.nodes)
      admitSqliteProjectToolInstallationPin(this.#db, { ...scope, ...node });
    this.#db
      .prepare(
        "INSERT INTO plugin_composition_locks(tenant_id,space_id,profile_id,authority_epoch,revision,lock_digest,actor_id,principal_id,lock_json) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ...compositionScopeValues(scope),
        scope.authorityEpoch,
        lock.revision,
        lock.lockDigest,
        actor.actorId,
        actor.principalId,
        JSON.stringify(lock),
      );
    if (head) {
      const result = this.#db
        .prepare(
          `UPDATE plugin_composition_heads SET revision=?,lock_digest=? WHERE ${where} AND revision=?`,
        )
        .run(
          lock.revision,
          lock.lockDigest,
          ...compositionScopeValues(scope),
          expectedRevision!,
        );
      if (result.changes !== 1)
        compositionStoreFail("plugin_composition_revision_conflict");
    } else
      this.#db
        .prepare(
          "INSERT INTO plugin_composition_heads(tenant_id,space_id,profile_id,revision,lock_digest) VALUES(?,?,?,?,?)",
        )
        .run(...compositionScopeValues(scope), lock.revision, lock.lockDigest);
    return Object.freeze({ disposition: "committed", lock });
  }
  #head(scope: PluginProfileScope): Row | undefined {
    return this.#db
      .prepare(
        `SELECT revision,lock_digest FROM plugin_composition_heads WHERE ${where}`,
      )
      .get(...compositionScopeValues(scope));
  }
  #row(scope: PluginProfileScope, digest: string): Row | undefined {
    return this.#db
      .prepare(
        `SELECT * FROM plugin_composition_locks WHERE ${where} AND lock_digest=?`,
      )
      .get(...compositionScopeValues(scope), digest);
  }
  #scope(scope: PluginProfileScope): void {
    if (this.#binding)
      assertPluginProfileScope(this.#binding.scope, compositionProfile(scope));
  }
  #version(): void {
    assertCompositionVersion(
      this.#db
        .prepare(
          "SELECT id,version FROM plugin_composition_schema_version LIMIT 2",
        )
        .all(),
    );
  }
  #readable(): void {
    this.#open();
    this.#version();
  }
  #transaction<T>(
    body: () => T,
    options: { checkVersion: boolean } = { checkVersion: true },
  ): T {
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (options.checkVersion) this.#version();
      const result = body();
      this.#open();
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
