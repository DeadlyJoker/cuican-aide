import type { Pool } from "pg";
import type { PluginInstallationStore } from "@crewon/application";
import {
  assertPluginProfileScope,
  assertPluginSelectionPackage,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  pluginInstallationNamespaceId,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import { PostgresPluginInstallationStore } from "./postgres-plugin-installation-store.ts";
import { postgresQueryClient } from "./postgres-query-client.ts";
import { pluginInstallationProfileLockKey } from "./postgres-plugin-installation-profile-support.ts";

export const POSTGRES_PLUGIN_PROFILE_OWNER_LIMITS = Object.freeze({
  ownersPerPool: 32,
  selectionsPerProfile: 256,
  pendingOperations: 32,
  queryTimeoutMs: 30_000,
  connectTimeoutMs: 5_000,
});

export type PostgresPluginInstallationProfileOwnerInput = Readonly<{
  scope: PluginProfileScope;
  /** Synchronous host withdrawal callback. It is not a permission grant or distributed Run fence. */
  onOwnershipLost(error: unknown): void;
}>;

type Dependencies = PostgresPluginInstallationProfileOwnerInput &
  Readonly<{
    pool: Pool;
    schema: string;
    assertHostOpen(): void;
    registerOwner?(owner: PostgresPluginInstallationProfileOwner): () => void;
  }>;
type Projection = Readonly<{
  selection: PluginSelection;
  package: InstalledPluginPackage | null;
}>;
const owners = new WeakMap<Pool, Set<PostgresPluginInstallationProfileOwner>>();

/**
 * An actual dedicated PostgreSQL session holds the same lock as every current Store writer.
 * This is a known-session/confirmed-COMMIT projection, not proof of current permission or a
 * distributed execution lease. Unobserved transport loss still requires the Run's DB fence.
 * Legacy writers or privileged SQL bypassing this protocol are outside its guarantee.
 */
export class PostgresPluginInstallationProfileOwner {
  readonly scope: PluginProfileScope;
  readonly store: PluginInstallationStore;
  readonly #dependencies: Dependencies;
  readonly #client: InstanceType<ReturnType<typeof postgresQueryClient>>;
  readonly #projections = new Map<string, Projection>();
  readonly #registry: Set<PostgresPluginInstallationProfileOwner>;
  #unregister: () => void = () => {};
  #state: "acquiring" | "held" | "closed" = "acquiring";
  #initialized = false;
  #heldOnce = false;
  #failure: unknown = null;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #closing: Promise<void> | null = null;
  #mutation: symbol | null = null;

  private constructor(dependencies: Dependencies) {
    this.scope = parsePluginProfileScope(dependencies.scope);
    if (typeof dependencies.onOwnershipLost !== "function")
      throw new Error("plugin_profile_owner_policy_missing");
    dependencies.assertHostOpen();
    this.#dependencies = dependencies;
    this.#registry = owners.get(dependencies.pool) ?? new Set();
    if (
      this.#registry.size >= POSTGRES_PLUGIN_PROFILE_OWNER_LIMITS.ownersPerPool
    )
      throw new Error("plugin_profile_owner_capacity_exhausted");
    owners.set(dependencies.pool, this.#registry);
    const DedicatedClient = postgresQueryClient({
      queryTimeoutMs: POSTGRES_PLUGIN_PROFILE_OWNER_LIMITS.queryTimeoutMs,
      maximumClientQueries:
        POSTGRES_PLUGIN_PROFILE_OWNER_LIMITS.pendingOperations,
      onFailure: (code) => this.#lose(new Error(code)),
    });
    // Pool.options is the public, typed pg connection configuration. Passing it directly
    // preserves pg's non-enumerable password configuration; nothing is inspected or logged.
    this.#client = new DedicatedClient(dependencies.pool.options);
    this.#client.on("end", () =>
      this.#lose(new Error("plugin_profile_owner_connection_ended")),
    );
    const bound = new PostgresPluginInstallationStore({
      pool: dependencies.pool,
      schema: dependencies.schema,
      assertOpen: dependencies.assertHostOpen,
      binding: {
        client: this.#client,
        scope: this.scope,
        assertOpen: () => this.#assertOpen(),
        invalidate: (error) => this.#lose(error),
        run: (operation) => this.#run(operation),
        runMutation: (operation) => this.#run(operation, true),
        prepareProjection: (selection, pkg) =>
          this.#prepareProjection(selection, pkg),
      },
    });
    this.store = Object.freeze({
      compositionStore: bound.compositionStore.bind(bound),
      loadPackage: bound.loadPackage.bind(bound),
      loadSelection: bound.loadSelection.bind(bound),
      listPackages: bound.listPackages.bind(bound),
      listSelections: bound.listSelections.bind(bound),
      loadReceipt: bound.loadReceipt.bind(bound),
      recordInstalledPackage: bound.recordInstalledPackage.bind(bound),
      commitSelection: bound.commitSelection.bind(bound),
    });
    this.#registry.add(this);
    try {
      this.#unregister = dependencies.registerOwner?.(this) ?? (() => {});
    } catch (error) {
      void this.close().catch(() => {});
      throw error;
    }
  }

  static async acquire(
    dependencies: Dependencies,
  ): Promise<PostgresPluginInstallationProfileOwner> {
    const owner = new PostgresPluginInstallationProfileOwner(dependencies);
    try {
      await owner.#begin();
      return owner;
    } catch (error) {
      await owner.close();
      throw error;
    }
  }

  currentSelection(
    input: Readonly<{ scope: PluginProfileScope; pluginId: string }>,
  ): PluginSelection | null {
    this.#assertProjection(input.scope);
    return (
      this.#projections.get(pluginInstallationNamespaceId(input.pluginId))
        ?.selection ?? null
    );
  }

  currentSelectedPackage(
    input: Readonly<{ scope: PluginProfileScope; pluginId: string }>,
  ): InstalledPluginPackage | null {
    this.#assertProjection(input.scope);
    return (
      this.#projections.get(pluginInstallationNamespaceId(input.pluginId))
        ?.package ?? null
    );
  }

  snapshot(): Readonly<{
    scope: PluginProfileScope;
    selections: readonly PluginSelection[];
    selectedPackages: readonly InstalledPluginPackage[];
  }> {
    this.#assertProjection(this.scope);
    const ordered = [...this.#projections.values()].sort((a, b) =>
      a.selection.pluginId < b.selection.pluginId
        ? -1
        : a.selection.pluginId > b.selection.pluginId
          ? 1
          : 0,
    );
    return Object.freeze({
      scope: this.scope,
      selections: Object.freeze(ordered.map((entry) => entry.selection)),
      selectedPackages: Object.freeze(
        ordered.flatMap((entry) => (entry.package ? [entry.package] : [])),
      ),
    });
  }

  /** Withdrawal is synchronous; physical connection shutdown is awaited by the host close registry. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = Promise.resolve()
      .then(() => this.#client.end())
      .finally(() => {
        this.#registry.delete(this);
        this.#unregister();
      });
    this.#lose(new Error("plugin_profile_owner_closed"));
    return this.#closing;
  }

  async #begin(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#client.connect(),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("plugin_profile_owner_connect_timeout");
            this.#lose(error);
            reject(error);
          }, POSTGRES_PLUGIN_PROFILE_OWNER_LIMITS.connectTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.#dependencies.assertHostOpen();
    if (this.#isClosed()) throw this.#unavailable();
    const acquired = await this.#client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
      [pluginInstallationProfileLockKey(this.#dependencies.schema, this.scope)],
    );
    if (acquired.rows[0]?.acquired !== true)
      throw new Error("plugin_profile_owner_busy");
    if (this.#isClosed()) throw this.#unavailable();
    this.#heldOnce = true;
    this.#state = "held";
    this.#assertOpen();
    let afterPluginId: string | null = null;
    do {
      const page = await this.store.listSelections({
        scope: this.scope,
        afterPluginId,
        limit: 50,
      });
      for (const selection of page.selections) {
        const pkg =
          selection.selectedPackageDigest === null
            ? null
            : await this.store.loadPackage({
                scope: this.scope,
                packageDigest: selection.selectedPackageDigest,
              });
        this.#prepareProjection(selection, pkg)();
      }
      afterPluginId = page.next;
    } while (afterPluginId !== null);
    this.#assertOpen();
    this.#initialized = true;
  }

  #assertOpen(): void {
    try {
      this.#dependencies.assertHostOpen();
      if (this.#dependencies.pool.ending || this.#dependencies.pool.ended)
        throw new Error("plugin_profile_owner_host_closed");
    } catch (error) {
      this.#lose(error);
    }
    if (this.#state !== "held") throw this.#unavailable();
  }

  #assertProjection(scope: PluginProfileScope): void {
    this.#assertOpen();
    if (!this.#initialized) throw new Error("plugin_profile_owner_not_ready");
    if (this.#mutation !== null)
      throw new Error("plugin_profile_owner_projection_busy");
    assertPluginProfileScope(this.scope, parsePluginProfileScope(scope));
  }

  #prepareProjection(
    selectionInput: PluginSelection | null,
    packageInput: InstalledPluginPackage | null,
  ): () => void {
    this.#assertOpen();
    if (selectionInput === null)
      throw new Error("plugin_installation_record_invalid");
    const selection = parsePluginSelection(selectionInput);
    const pkg =
      packageInput === null ? null : parseInstalledPluginPackage(packageInput);
    assertPluginProfileScope(this.scope, selection);
    assertPluginSelectionPackage({ selection, package: pkg });
    if (
      !this.#projections.has(selection.pluginId) &&
      this.#projections.size >=
        POSTGRES_PLUGIN_PROFILE_OWNER_LIMITS.selectionsPerProfile
    )
      throw new Error("plugin_profile_owner_selection_limit");
    const entry = Object.freeze({ selection, package: pkg });
    return () => {
      // A confirmed COMMIT still returns its durable receipt if close/loss won the response race.
      // It cannot republish a projection on an invalid owner; the host must return projection pending.
      if (this.#state === "held")
        this.#projections.set(selection.pluginId, entry);
    };
  }

  #run<T>(operation: () => Promise<T>, mutation = false): Promise<T> {
    this.#assertOpen();
    if (this.#pending >= POSTGRES_PLUGIN_PROFILE_OWNER_LIMITS.pendingOperations)
      return Promise.reject(
        new Error("plugin_profile_owner_operation_capacity_exhausted"),
      );
    this.#pending++;
    const token = Symbol();
    const result = this.#tail.then(() => {
      this.#assertOpen();
      if (mutation) this.#mutation = token;
      return operation();
    });
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result.finally(() => {
      this.#pending--;
      if (this.#mutation === token) this.#mutation = null;
    });
  }

  #lose(error: unknown): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#failure = error;
    if (this.#heldOnce) {
      try {
        this.#dependencies.onOwnershipLost(error);
      } catch {
        // Diagnostics/withdrawal observers cannot restore ownership or interrupt physical cleanup.
      }
    }
    // An idle transport failure must also release this dedicated lifetime/capacity.
    void this.close().catch(() => {});
  }

  #unavailable(): Error {
    return new Error("plugin_profile_owner_unavailable", {
      cause: this.#failure,
    });
  }
  #isClosed(): boolean {
    return this.#state === "closed";
  }
}

export const acquirePostgresPluginInstallationProfileOwner = (
  dependencies: Dependencies,
) => PostgresPluginInstallationProfileOwner.acquire(dependencies);
