import { lockPostgresCompositionSnapshot } from "./plugin-composition-snapshot-lock.ts";
import { PostgresPluginCompositionStore } from "./postgres-plugin-composition-store.ts";
import type { Client as PgClient, Pool, PoolClient } from "pg";
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
  migratePostgresPluginInstallation,
  pluginInstallationSchemaName,
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
import { rollbackPostgres } from "./postgres-store-support.ts";
import {
  lockPluginInstallationProfile,
  type PluginInstallationProfileBinding,
} from "./postgres-plugin-installation-profile-support.ts";
import {
  acquirePostgresPluginInstallationProfileOwner,
  type PostgresPluginInstallationProfileOwner,
  type PostgresPluginInstallationProfileOwnerInput,
} from "./postgres-plugin-installation-profile-owner.ts";

type Input<M extends keyof PluginInstallationStore> = Parameters<
  NonNullable<PluginInstallationStore[M]>
>[0];
type Client = Pool | PoolClient | PgClient;
type TransactionClient = PoolClient | PgClient;
const scopeFilter = "tenant_id=$1 AND space_id=$2 AND profile_id=$3";

/** Host-owned pool/schema/lifetime. Persisted selection is intent, never proof of active code. */
export class PostgresPluginInstallationStore
  implements PluginInstallationStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #assertOpen: () => void;
  readonly #binding: PluginInstallationProfileBinding | undefined;
  readonly #registerOwner:
    | ((owner: PostgresPluginInstallationProfileOwner) => () => void)
    | undefined;
  constructor(input: {
    pool: Pool;
    schema: string;
    assertOpen(): void;
    /** Host close registry; a dedicated owner connection is not a pool checkout. */
    registerOwner?(owner: PostgresPluginInstallationProfileOwner): () => void;
    /** Internal construction by the actual acquired profile owner only. */
    binding?: PluginInstallationProfileBinding;
  }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    this.#prefix = `${pluginInstallationSchemaName(input.schema)}.`;
    this.#binding = input.binding;
    this.#assertOpen = () => {
      input.assertOpen();
      input.binding?.assertOpen();
    };
    this.#registerOwner = input.registerOwner;
  }
  acquireProfileOwner(input: PostgresPluginInstallationProfileOwnerInput) {
    this.#assertOpen();
    if (this.#binding)
      installationFailure("plugin_profile_owner_operation_invalid");
    return acquirePostgresPluginInstallationProfileOwner({
      ...input,
      pool: this.#pool,
      schema: this.#schema,
      assertHostOpen: this.#assertOpen,
      registerOwner: this.#registerOwner,
    });
  }
  compositionStore() {
    this.#assertOpen();
    return new PostgresPluginCompositionStore({
      pool: this.#pool,
      schema: this.#schema,
      assertOpen: this.#assertOpen,
      binding: this.#binding,
    });
  }
  async migrate(): Promise<void> {
    if (this.#binding)
      installationFailure("plugin_profile_owner_operation_invalid");
    await this.#transaction(async (client) => {
      await this.#lock(client, ["plugin-installation-migration", this.#schema]);
      await migratePostgresPluginInstallation(
        client as PoolClient,
        this.#schema,
      );
      this.#assertOpen();
    }, false);
  }
  async loadPackage(input: Input<"loadPackage">) {
    return this.#run(async () => {
      const { scope, value } = installationReadInput(input, ["packageDigest"]);
      this.#scope(scope);
      await this.#versionSupported(this.#reader());
      return this.#package(
        this.#reader(),
        scope,
        pluginInstallationDigest(value.packageDigest),
      );
    });
  }
  async loadSelection(input: Input<"loadSelection">) {
    return this.#run(async () => {
      const { scope, value } = installationReadInput(input, ["pluginId"]);
      this.#scope(scope);
      await this.#versionSupported(this.#reader());
      const selection = await this.#selection(
        this.#reader(),
        scope,
        pluginInstallationNamespaceId(value.pluginId),
      );
      await this.#selectionPackage(this.#reader(), selection);
      return selection;
    });
  }
  async listPackages(input: Input<"listPackages">) {
    return this.#run(async () => {
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
      await this.#versionSupported(this.#reader());
      const rows = await this.#query(
        this.#reader(),
        `SELECT * FROM ${this.#prefix}installed_plugin_packages WHERE ${scopeFilter}
      AND ($4::text IS NULL OR plugin_id=$4) AND ($5::text IS NULL OR package_digest COLLATE "C">$5 COLLATE "C")
      ORDER BY package_digest COLLATE "C" LIMIT $6`,
        [...installationScopeValues(scope), pluginId, after, limit + 1],
      );
      const all = rows.rows.map((row) =>
        required(decodeInstallationPackage(row, scope)),
      );
      const packages = Object.freeze(all.slice(0, limit));
      return Object.freeze({
        packages,
        next: all.length > limit ? packages.at(-1)!.packageDigest : null,
      });
    });
  }
  async listSelections(input: Input<"listSelections">) {
    return this.#run(async () => {
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
      await this.#versionSupported(this.#reader());
      const rows = await this.#query(
        this.#reader(),
        `SELECT * FROM ${this.#prefix}plugin_profile_selections WHERE ${scopeFilter}
      AND ($4::text IS NULL OR plugin_id COLLATE "C">$4 COLLATE "C") ORDER BY plugin_id COLLATE "C" LIMIT $5`,
        [...installationScopeValues(scope), after, limit + 1],
      );
      const all = rows.rows.map((row) =>
        required(decodeInstallationSelection(row, scope)),
      );
      for (const selection of all)
        await this.#selectionPackage(this.#reader(), selection);
      const selections = Object.freeze(all.slice(0, limit));
      return Object.freeze({
        selections,
        next: all.length > limit ? selections.at(-1)!.pluginId : null,
      });
    });
  }
  async loadReceipt(input: Input<"loadReceipt">) {
    return this.#run(async () => {
      const id = installationReceiptIdentity(input);
      this.#scope(id.scope);
      await this.#versionSupported(this.#reader());
      return this.#receipt(this.#reader(), id);
    });
  }
  async recordInstalledPackage(input: Input<"recordInstalledPackage">) {
    return this.#run(async () => {
      const result = await this.#commit(prepareInstallation(input));
      if (result.kind !== "install")
        installationFailure("plugin_installation_record_invalid");
      return result;
    }, true);
  }
  async commitSelection(input: Input<"commitSelection">) {
    return this.#run(async () => {
      const result = await this.#commit(prepareSelection(input));
      if (result.kind !== "select")
        installationFailure("plugin_installation_record_invalid");
      return result;
    }, true);
  }
  async #commit(
    prepared: PreparedInstallation,
  ): Promise<PluginInstallationMutationResult> {
    this.#scope(prepared.scope);
    let publish = () => {};
    return this.#transaction(
      async (client) => {
        await lockPluginInstallationProfile(
          client,
          this.#schema,
          prepared.scope,
        );
        await lockPostgresCompositionSnapshot({
          client,
          schema: this.#schema,
          scope: prepared.scope,
          mode: "write",
        });
        this.#assertOpen();
        const project = async (result: PluginInstallationMutationResult) => {
          if (this.#binding) {
            const actual = await this.#selection(
              client,
              prepared.scope,
              result.selection.pluginId,
            );
            publish = this.#binding.prepareProjection(
              actual,
              await this.#selectionPackage(client, actual),
            );
          }
          return result;
        };
        await this.#lock(client, [
          "plugin-installation-receipt",
          this.#schema,
          ...installationScopeValues(prepared.scope),
          prepared.actor.principalId,
          prepared.actor.actorId,
          prepared.kind,
          prepared.receipt.idempotencyKey,
        ]);
        const replay = await this.#receipt(client, prepared);
        if (replay !== null) {
          verifyInstallationReplay(prepared, replay);
          return project(replay);
        }
        const pluginId =
          prepared.kind === "install"
            ? prepared.package.pluginId
            : prepared.selection.pluginId;
        await this.#lock(client, [
          "plugin-installation-namespace",
          this.#schema,
          ...installationScopeValues(prepared.scope),
          pluginId,
        ]);
        const requestedDigest =
          prepared.kind === "install"
            ? prepared.package.packageDigest
            : prepared.selection.selectedPackageDigest;
        if (prepared.kind === "install")
          await this.#lock(client, [
            "plugin-installation-digest",
            this.#schema,
            ...installationScopeValues(prepared.scope),
            requestedDigest,
          ]);
        const selection = await this.#selection(
          client,
          prepared.scope,
          pluginId,
        );
        const digestPackage =
          requestedDigest === null
            ? null
            : await this.#package(client, prepared.scope, requestedDigest);
        const versionPackage =
          prepared.kind === "install"
            ? await this.#version(
                client,
                prepared.scope,
                pluginId,
                prepared.package.version,
              )
            : null;
        const result = verifyInstallationMutation(prepared, {
          selection,
          digestPackage,
          versionPackage,
          selectedPackage: await this.#selectionPackage(client, selection),
        });
        assertSelectionCommitGuard(prepared);
        if (
          result.kind === "install" &&
          versionPackage === null &&
          digestPackage === null
        )
          await this.#insertPackage(client, result.package);
        if (
          selection === null ||
          installationJson(selection) !== installationJson(result.selection)
        )
          await this.#writeSelection(
            client,
            result.selection,
            selection?.revision ?? null,
          );
        await this.#query(
          client,
          `INSERT INTO ${this.#prefix}plugin_installation_receipts
        (tenant_id,space_id,profile_id,principal_id,actor_id,kind,idempotency_key,request_digest,plugin_id,result_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            ...installationScopeValues(prepared.scope),
            prepared.actor.principalId,
            prepared.actor.actorId,
            prepared.kind,
            prepared.receipt.idempotencyKey,
            prepared.receipt.requestDigest,
            result.selection.pluginId,
            installationJson(result),
          ],
        );
        return project(result);
      },
      true,
      () => publish(),
    );
  }
  async #package(client: Client, scope: PluginProfileScope, digest: string) {
    const rows = await this.#query(
      client,
      `SELECT * FROM ${this.#prefix}installed_plugin_packages WHERE ${scopeFilter} AND package_digest=$4`,
      [...installationScopeValues(scope), digest],
    );
    return decodeInstallationPackage(rows.rows[0], scope);
  }
  async #version(
    client: Client,
    scope: PluginProfileScope,
    pluginId: string,
    version: string,
  ) {
    const rows = await this.#query(
      client,
      `SELECT * FROM ${this.#prefix}installed_plugin_packages WHERE ${scopeFilter} AND plugin_id=$4 AND version=$5`,
      [...installationScopeValues(scope), pluginId, version],
    );
    return decodeInstallationPackage(rows.rows[0], scope);
  }
  async #selection(
    client: Client,
    scope: PluginProfileScope,
    pluginId: string,
  ) {
    const rows = await this.#query(
      client,
      `SELECT * FROM ${this.#prefix}plugin_profile_selections WHERE ${scopeFilter} AND plugin_id=$4`,
      [...installationScopeValues(scope), pluginId],
    );
    return decodeInstallationSelection(rows.rows[0], scope);
  }
  async #selectionPackage(client: Client, selection: PluginSelection | null) {
    if (selection === null) return null;
    const scope = {
      tenantId: selection.tenantId,
      spaceId: selection.spaceId,
      profileId: selection.profileId,
    };
    const pkg =
      selection.selectedPackageDigest === null
        ? null
        : await this.#package(client, scope, selection.selectedPackageDigest);
    assertPluginSelectionPackage({ selection, package: pkg });
    return pkg;
  }
  async #receipt(client: Client, id: InstallationIdentity) {
    const rows = await this.#query(
      client,
      `SELECT * FROM ${this.#prefix}plugin_installation_receipts WHERE ${scopeFilter}
      AND principal_id=$4 AND actor_id=$5 AND kind=$6 AND idempotency_key=$7`,
      [
        ...installationScopeValues(id.scope),
        id.actor.principalId,
        id.actor.actorId,
        id.kind,
        id.receipt.idempotencyKey,
      ],
    );
    const result = decodeInstallationReceipt(rows.rows[0], id);
    if (result === null) return null;
    await this.#selectionPackage(client, result.selection);
    if (result.kind === "install") {
      const saved = required(
        await this.#package(client, id.scope, result.package.packageDigest),
      );
      assertInstalledPluginPackageIdentity(saved, result.package);
      if (installationJson(saved) !== installationJson(result.package))
        installationFailure("plugin_installation_record_invalid");
    }
    return result;
  }
  async #insertPackage(client: TransactionClient, pkg: InstalledPluginPackage) {
    await this.#query(
      client,
      `INSERT INTO ${this.#prefix}installed_plugin_packages (tenant_id,space_id,profile_id,plugin_id,version,publisher_id,package_digest,record_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        pkg.tenantId,
        pkg.spaceId,
        pkg.profileId,
        pkg.pluginId,
        pkg.version,
        pkg.publisherId,
        pkg.packageDigest,
        installationJson(pkg),
      ],
    );
  }
  async #writeSelection(
    client: TransactionClient,
    selection: PluginSelection,
    expected: number | null,
  ) {
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
      await this.#query(
        client,
        `INSERT INTO ${this.#prefix}plugin_profile_selections (tenant_id,space_id,profile_id,plugin_id,publisher_id,revision,state,selected_package_digest,record_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        values,
      );
    } else {
      const changed = await this.#query(
        client,
        `UPDATE ${this.#prefix}plugin_profile_selections SET revision=$6,state=$7,selected_package_digest=$8,record_json=$9
        WHERE ${scopeFilter} AND plugin_id=$4 AND publisher_id=$5 AND revision=$10`,
        [...values, expected],
      );
      if (changed.rowCount !== 1)
        installationFailure("plugin_installation_revision_conflict");
    }
  }
  async #versionSupported(client: Client) {
    const version = await this.#query(
      client,
      `SELECT id,version FROM ${this.#prefix}plugin_installation_schema_version LIMIT 2`,
    );
    try {
      assertPluginInstallationSchemaVersion(
        version.rows as { id: unknown; version: unknown }[],
      );
    } catch (error) {
      this.#binding?.invalidate(error);
      throw error;
    }
  }
  async #lock(client: TransactionClient, key: readonly unknown[]) {
    await this.#query(
      client,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify(key)],
    );
  }
  async #query(client: Client, sql: string, values: unknown[] = []) {
    this.#assertOpen();
    const result = await client.query<Record<string, unknown>>(sql, values);
    this.#assertOpen();
    return result;
  }
  async #transaction<T>(
    body: (client: TransactionClient) => Promise<T>,
    checkVersion = true,
    afterCommit: () => void = () => {},
  ): Promise<T> {
    this.#assertOpen();
    const borrowed = this.#binding ? null : await this.#pool.connect();
    const client = this.#binding?.client ?? borrowed!;
    try {
      await this.#query(client, "BEGIN");
      if (checkVersion) await this.#versionSupported(client);
      const result = await body(client);
      // Confirmed COMMIT remains successful when the host closes while awaiting its response.
      this.#assertOpen();
      await client.query("COMMIT");
      afterCommit();
      return result;
    } catch (error) {
      await rollbackPostgres(client as PoolClient);
      throw error;
    } finally {
      borrowed?.release();
    }
  }
  #reader(): Client {
    return this.#binding?.client ?? this.#pool;
  }
  #scope(scope: PluginProfileScope): void {
    if (this.#binding) assertPluginProfileScope(this.#binding.scope, scope);
  }
  #run<T>(operation: () => Promise<T>, mutation = false): Promise<T> {
    return this.#binding
      ? mutation
        ? this.#binding.runMutation(operation)
        : this.#binding.run(operation)
      : operation();
  }
}

function required<T>(value: T | null): T {
  if (value === null) installationFailure("plugin_installation_record_invalid");
  return value;
}
