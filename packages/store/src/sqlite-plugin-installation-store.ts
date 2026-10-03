import type { DatabaseSync } from "node:sqlite";
import type {
  PluginInstallationStore,
  PluginInstallationMutationResult,
} from "@crewon/application";
import {
  assertInstalledPluginPackageIdentity,
  assertPluginProfileScope,
  assertPluginSelectionPackage,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import {
  assertPluginInstallationSchemaVersion,
  migrateSqlitePluginInstallation,
} from "./plugin-installation-schema.ts";
import {
  decodeInstallationPackage,
  installationFailure,
  decodeInstallationReceipt,
  decodeInstallationSelection,
  installationJson,
  installationPageLimit,
  installationReadInput,
  installationReceiptIdentity,
  installationScopeValues,
  prepareInstallation,
  prepareSelection,
  assertSelectionCommitGuard,
  verifyInstallationMutation,
  verifyInstallationReplay,
  type InstallationIdentity,
  type PreparedInstallation,
} from "./plugin-installation-store-records.ts";
import {
  captureSqliteInstallationDatabase,
  withSqlitePluginInstallationWriter,
} from "./sqlite-plugin-installation-profile-lock.ts";
import {
  assertSqlitePluginInstallationProfileBinding,
  SqlitePluginInstallationProfileOwner,
  type SqlitePluginInstallationProfileBinding,
  type SqlitePluginInstallationProfileOwnerInput,
} from "./sqlite-plugin-installation-profile-owner.ts";

type Input<M extends keyof PluginInstallationStore> = Parameters<
  PluginInstallationStore[M]
>[0];
const scopeFilter = "tenant_id=? AND space_id=? AND profile_id=?";

/** Shares the host's connection and lifetime. Construction performs no migration or installation. */
export class SqlitePluginInstallationStore implements PluginInstallationStore {
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  readonly #binding: SqlitePluginInstallationProfileBinding | undefined;
  readonly #registerOwner:
    | ((owner: SqlitePluginInstallationProfileOwner) => () => void)
    | undefined;
  constructor(input: {
    database: DatabaseSync;
    assertOpen(): void;
    registerOwner?(owner: SqlitePluginInstallationProfileOwner): () => void;
    /** Internal, branded owner binding; a structural DTO is rejected. */
    binding?: SqlitePluginInstallationProfileBinding;
  }) {
    if (input.binding)
      assertSqlitePluginInstallationProfileBinding(input.binding);
    this.#database = input.database;
    captureSqliteInstallationDatabase(input.database);
    this.#binding = input.binding;
    this.#registerOwner = input.registerOwner;
    this.#assertOpen = () => {
      input.assertOpen();
      input.binding?.assertOpen();
    };
  }
  acquireProfileOwner(input: SqlitePluginInstallationProfileOwnerInput) {
    this.#assertOpen();
    if (this.#binding)
      installationFailure("plugin_profile_owner_operation_invalid");
    const { scope, value } = installationReadInput(input, ["onOwnershipLost"]);
    if (typeof value.onOwnershipLost !== "function")
      installationFailure("plugin_profile_owner_policy_missing");
    return SqlitePluginInstallationProfileOwner.acquire({
      scope,
      onOwnershipLost: value.onOwnershipLost as (error: unknown) => void,
      database: this.#database,
      assertHostOpen: this.#assertOpen,
      registerOwner: this.#registerOwner,
    });
  }
  async migrate(): Promise<void> {
    if (this.#binding)
      installationFailure("plugin_profile_owner_operation_invalid");
    this.#transaction(
      () => migrateSqlitePluginInstallation(this.#database),
      false,
    );
  }
  async loadPackage(input: Input<"loadPackage">) {
    return this.currentPackage(input);
  }
  /** Checked synchronous read on this exact connection, including inside its owned transaction. */
  currentPackage(input: Input<"loadPackage">) {
    this.#readable();
    const { scope, value } = installationReadInput(input, ["packageDigest"]);
    this.#scope(scope);
    return this.#package(scope, pluginInstallationDigest(value.packageDigest));
  }
  async loadSelection(input: Input<"loadSelection">) {
    return this.currentSelection(input);
  }
  /** Checked synchronous read on this exact connection, including selected-package integrity. */
  currentSelection(input: Input<"loadSelection">) {
    this.#readable();
    const { scope, value } = installationReadInput(input, ["pluginId"]);
    this.#scope(scope);
    const selection = this.#selection(
      scope,
      pluginInstallationNamespaceId(value.pluginId),
    );
    this.#selectionPackage(selection);
    return selection;
  }
  async listPackages(input: Input<"listPackages">) {
    this.#readable();
    const { scope, value } = installationReadInput(input, [
      "pluginId",
      "afterPackageDigest",
      "limit",
    ]);
    this.#scope(scope);
    const pluginId =
      value.pluginId === null
        ? null
        : pluginInstallationNamespaceId(value.pluginId);
    const after =
      value.afterPackageDigest === null
        ? null
        : pluginInstallationDigest(value.afterPackageDigest);
    const limit = installationPageLimit(value.limit);
    const rows = this.#database
      .prepare(
        `SELECT * FROM installed_plugin_packages WHERE ${scopeFilter}
      AND (? IS NULL OR plugin_id=?) AND (? IS NULL OR package_digest COLLATE BINARY > ? COLLATE BINARY)
      ORDER BY package_digest COLLATE BINARY LIMIT ?`,
      )
      .all(
        ...installationScopeValues(scope),
        pluginId,
        pluginId,
        after,
        after,
        limit + 1,
      );
    const all = rows.map((row) =>
      required(decodeInstallationPackage(row, scope)),
    );
    const packages = Object.freeze(all.slice(0, limit));
    return Object.freeze({
      packages,
      next: all.length > limit ? packages.at(-1)!.packageDigest : null,
    });
  }
  async listSelections(input: Input<"listSelections">) {
    this.#readable();
    const { scope, value } = installationReadInput(input, [
      "afterPluginId",
      "limit",
    ]);
    this.#scope(scope);
    const after =
      value.afterPluginId === null
        ? null
        : pluginInstallationNamespaceId(value.afterPluginId);
    const limit = installationPageLimit(value.limit);
    const rows = this.#database
      .prepare(
        `SELECT * FROM plugin_profile_selections WHERE ${scopeFilter}
      AND (? IS NULL OR plugin_id COLLATE BINARY > ? COLLATE BINARY) ORDER BY plugin_id COLLATE BINARY LIMIT ?`,
      )
      .all(...installationScopeValues(scope), after, after, limit + 1);
    const all = rows.map((row) =>
      required(decodeInstallationSelection(row, scope)),
    );
    for (const selection of all) this.#selectionPackage(selection);
    const selections = Object.freeze(all.slice(0, limit));
    return Object.freeze({
      selections,
      next: all.length > limit ? selections.at(-1)!.pluginId : null,
    });
  }
  async loadReceipt(input: Input<"loadReceipt">) {
    this.#readable();
    const identity = installationReceiptIdentity(input);
    this.#scope(identity.scope);
    return this.#receipt(identity);
  }
  async recordInstalledPackage(input: Input<"recordInstalledPackage">) {
    const result = await this.#commit(prepareInstallation(input));
    if (result.kind !== "install")
      installationFailure("plugin_installation_record_invalid");
    return result;
  }
  async commitSelection(input: Input<"commitSelection">) {
    const result = await this.#commit(prepareSelection(input));
    if (result.kind !== "select")
      installationFailure("plugin_installation_record_invalid");
    return result;
  }
  #commit(
    prepared: PreparedInstallation,
  ): Promise<PluginInstallationMutationResult> {
    this.#assertOpen();
    this.#scope(prepared.scope);
    const operation = () => this.#commitNow(prepared);
    return this.#binding
      ? this.#binding.runMutation(operation)
      : Promise.resolve(
          withSqlitePluginInstallationWriter(
            this.#database,
            prepared.scope,
            operation,
          ),
        );
  }
  #commitNow(prepared: PreparedInstallation): PluginInstallationMutationResult {
    let publish = () => {};
    const project = (result: PluginInstallationMutationResult) => {
      if (this.#binding) {
        const actual = this.#selection(
          prepared.scope,
          result.selection.pluginId,
        );
        publish = this.#binding.prepareProjection(
          actual,
          this.#selectionPackage(actual),
        );
      }
      return result;
    };
    const result = this.#transaction(() => {
      const replay = this.#receipt(prepared);
      if (replay !== null) {
        verifyInstallationReplay(prepared, replay);
        return project(replay);
      }
      const pluginId =
        prepared.kind === "install"
          ? prepared.package.pluginId
          : prepared.selection.pluginId;
      const selection = this.#selection(prepared.scope, pluginId);
      const requestedDigest =
        prepared.kind === "install"
          ? prepared.package.packageDigest
          : prepared.selection.selectedPackageDigest;
      const digestPackage =
        requestedDigest === null
          ? null
          : this.#package(prepared.scope, requestedDigest);
      const versionPackage =
        prepared.kind === "install"
          ? this.#version(prepared.scope, pluginId, prepared.package.version)
          : null;
      const result = verifyInstallationMutation(prepared, {
        selection,
        digestPackage,
        versionPackage,
        selectedPackage: this.#selectionPackage(selection),
      });
      assertSelectionCommitGuard(prepared);
      if (
        result.kind === "install" &&
        versionPackage === null &&
        digestPackage === null
      )
        this.#insertPackage(result.package);
      if (
        selection === null ||
        installationJson(selection) !== installationJson(result.selection)
      )
        this.#writeSelection(result.selection, selection?.revision ?? null);
      this.#database
        .prepare(
          `INSERT INTO plugin_installation_receipts
        (tenant_id,space_id,profile_id,principal_id,actor_id,kind,idempotency_key,request_digest,plugin_id,result_json) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ...installationScopeValues(prepared.scope),
          prepared.actor.principalId,
          prepared.actor.actorId,
          prepared.kind,
          prepared.receipt.idempotencyKey,
          prepared.receipt.requestDigest,
          result.selection.pluginId,
          installationJson(result),
        );
      return project(result);
    });
    publish();
    return result;
  }
  #scope(scope: PluginProfileScope): void {
    if (this.#binding) assertPluginProfileScope(this.#binding.scope, scope);
  }
  #package(scope: PluginProfileScope, digest: string) {
    return decodeInstallationPackage(
      this.#database
        .prepare(
          `SELECT * FROM installed_plugin_packages WHERE ${scopeFilter} AND package_digest=?`,
        )
        .get(...installationScopeValues(scope), digest),
      scope,
    );
  }
  #version(scope: PluginProfileScope, pluginId: string, version: string) {
    return decodeInstallationPackage(
      this.#database
        .prepare(
          `SELECT * FROM installed_plugin_packages WHERE ${scopeFilter} AND plugin_id=? AND version=?`,
        )
        .get(...installationScopeValues(scope), pluginId, version),
      scope,
    );
  }
  #selection(scope: PluginProfileScope, pluginId: string) {
    return decodeInstallationSelection(
      this.#database
        .prepare(
          `SELECT * FROM plugin_profile_selections WHERE ${scopeFilter} AND plugin_id=?`,
        )
        .get(...installationScopeValues(scope), pluginId),
      scope,
    );
  }
  #selectionPackage(selection: PluginSelection | null) {
    if (selection === null) return null;
    const scope = {
      tenantId: selection.tenantId,
      spaceId: selection.spaceId,
      profileId: selection.profileId,
    };
    const pkg =
      selection.selectedPackageDigest === null
        ? null
        : this.#package(scope, selection.selectedPackageDigest);
    assertPluginSelectionPackage({ selection, package: pkg });
    return pkg;
  }
  #receipt(id: InstallationIdentity) {
    const row = this.#database
      .prepare(
        `SELECT * FROM plugin_installation_receipts WHERE ${scopeFilter}
      AND principal_id=? AND actor_id=? AND kind=? AND idempotency_key=?`,
      )
      .get(
        ...installationScopeValues(id.scope),
        id.actor.principalId,
        id.actor.actorId,
        id.kind,
        id.receipt.idempotencyKey,
      );
    const result = decodeInstallationReceipt(row, id);
    if (result === null) return null;
    this.#selectionPackage(result.selection);
    if (result.kind === "install") {
      const saved = required(
        this.#package(id.scope, result.package.packageDigest),
      );
      assertInstalledPluginPackageIdentity(saved, result.package);
      if (installationJson(saved) !== installationJson(result.package))
        installationFailure("plugin_installation_record_invalid");
    }
    return result;
  }
  #insertPackage(pkg: InstalledPluginPackage) {
    this.#database
      .prepare(
        `INSERT INTO installed_plugin_packages (tenant_id,space_id,profile_id,plugin_id,version,publisher_id,package_digest,record_json)
      VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        pkg.tenantId,
        pkg.spaceId,
        pkg.profileId,
        pkg.pluginId,
        pkg.version,
        pkg.publisherId,
        pkg.packageDigest,
        installationJson(pkg),
      );
  }
  #writeSelection(selection: PluginSelection, expected: number | null) {
    const values = [
      selection.tenantId,
      selection.spaceId,
      selection.profileId,
      selection.pluginId,
      selection.publisherId,
      selection.revision,
      selection.state,
      selection.selectedPackageDigest,
      installationJson(selection),
    ];
    if (expected === null) {
      this.#database
        .prepare(
          `INSERT INTO plugin_profile_selections (tenant_id,space_id,profile_id,plugin_id,publisher_id,revision,state,selected_package_digest,record_json)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(...values);
    } else {
      const changed = this.#database
        .prepare(
          `UPDATE plugin_profile_selections SET revision=?,state=?,selected_package_digest=?,record_json=?
        WHERE ${scopeFilter} AND plugin_id=? AND publisher_id=? AND revision=?`,
        )
        .run(
          selection.revision,
          selection.state,
          selection.selectedPackageDigest,
          installationJson(selection),
          selection.tenantId,
          selection.spaceId,
          selection.profileId,
          selection.pluginId,
          selection.publisherId,
          expected,
        );
      if (changed.changes !== 1)
        installationFailure("plugin_installation_revision_conflict");
    }
  }
  #readable() {
    this.#assertOpen();
    this.#versionSupported();
  }
  #versionSupported() {
    try {
      assertPluginInstallationSchemaVersion(
        this.#database
          .prepare(
            "SELECT id,version FROM plugin_installation_schema_version LIMIT 2",
          )
          .all() as { id: unknown; version: unknown }[],
      );
    } catch (error) {
      this.#binding?.invalidate(error);
      throw error;
    }
  }
  #transaction<T>(body: () => T, checkVersion = true): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (checkVersion) this.#versionSupported();
      const result = body();
      this.#assertOpen();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* Preserve the original host/transaction error. */
      }
      throw error;
    }
  }
}

function required<T>(value: T | null): T {
  if (value === null) installationFailure("plugin_installation_record_invalid");
  return value;
}
