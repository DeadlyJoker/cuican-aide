import type { DatabaseSync } from "node:sqlite";
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
import {
  sqliteInstallationDatabaseKey,
  SqlitePluginInstallationProfileLock,
} from "./sqlite-plugin-installation-profile-lock.ts";
import { SqlitePluginInstallationStore } from "./sqlite-plugin-installation-store.ts";

export const SQLITE_PLUGIN_PROFILE_OWNER_LIMITS = Object.freeze({
  ownersPerDatabase: 32,
  selectionsPerProfile: 256,
  pendingOperations: 32,
});
export type SqlitePluginInstallationProfileOwnerInput = Readonly<{
  scope: PluginProfileScope;
  /** Synchronous withdrawal only; ownership is not an application permission or Run fence. */
  onOwnershipLost(error: unknown): void;
}>;
export type SqlitePluginInstallationProfileBinding = Readonly<{
  scope: PluginProfileScope;
  assertOpen(): void;
  invalidate(error: unknown): void;
  runMutation<T>(operation: () => T): Promise<T>;
  prepareProjection(
    selection: PluginSelection | null,
    pkg: InstalledPluginPackage | null,
  ): () => void;
}>;
type Dependencies = SqlitePluginInstallationProfileOwnerInput &
  Readonly<{
    database: DatabaseSync;
    assertHostOpen(): void;
    registerOwner?(owner: SqlitePluginInstallationProfileOwner): () => void;
  }>;
type Projection = Readonly<{
  selection: PluginSelection;
  package: InstalledPluginPackage | null;
}>;
const owners = new Map<string, Set<SqlitePluginInstallationProfileOwner>>();
const bindings = new WeakSet<object>();

/** Internal bindings are issued only by a concrete owner holding the actual SQLite sidecar session. */
export function assertSqlitePluginInstallationProfileBinding(
  binding: SqlitePluginInstallationProfileBinding,
): void {
  if (!bindings.has(binding))
    throw new Error("plugin_profile_owner_binding_invalid");
}

export class SqlitePluginInstallationProfileOwner {
  readonly scope: PluginProfileScope;
  readonly store: PluginInstallationStore;
  readonly #dependencies: Dependencies;
  readonly #registry: Set<SqlitePluginInstallationProfileOwner>;
  readonly #key: string;
  readonly #lock: SqlitePluginInstallationProfileLock;
  readonly #projections = new Map<string, Projection>();
  #unregister: () => void = () => {};
  #state: "held" | "closed" = "held";
  #initialized = false;
  #failure: unknown = null;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #mutation: symbol | null = null;
  #closing: Promise<void> | null = null;

  private constructor(
    dependencies: Dependencies,
    key: string,
    lock: SqlitePluginInstallationProfileLock,
  ) {
    this.scope = parsePluginProfileScope(dependencies.scope);
    this.#dependencies = dependencies;
    this.#key = key;
    this.#lock = lock;
    this.#registry = owners.get(key) ?? new Set();
    if (
      this.#registry.size >=
      SQLITE_PLUGIN_PROFILE_OWNER_LIMITS.ownersPerDatabase
    )
      throw new Error("plugin_profile_owner_capacity_exhausted");
    owners.set(key, this.#registry);
    const binding: SqlitePluginInstallationProfileBinding = Object.freeze({
      scope: this.scope,
      assertOpen: () => this.#assertOpen(),
      invalidate: (error) => this.#lose(error),
      runMutation: <T>(operation: () => T) => this.#run(operation),
      prepareProjection: (selection, pkg) =>
        this.#prepareProjection(selection, pkg),
    });
    bindings.add(binding);
    const bound = new SqlitePluginInstallationStore({
      database: dependencies.database,
      assertOpen: dependencies.assertHostOpen,
      binding,
    });
    this.store = Object.freeze({
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
      this.#registry.delete(this);
      if (this.#registry.size === 0) owners.delete(key);
      throw error;
    }
  }

  static async acquire(
    dependencies: Dependencies,
  ): Promise<SqlitePluginInstallationProfileOwner> {
    dependencies.assertHostOpen();
    if (typeof dependencies.onOwnershipLost !== "function")
      throw new Error("plugin_profile_owner_policy_missing");
    const scope = parsePluginProfileScope(dependencies.scope);
    const key = sqliteInstallationDatabaseKey(dependencies.database);
    if (key === null) throw new Error("plugin_profile_owner_requires_file");
    if (
      (owners.get(key)?.size ?? 0) >=
      SQLITE_PLUGIN_PROFILE_OWNER_LIMITS.ownersPerDatabase
    )
      throw new Error("plugin_profile_owner_capacity_exhausted");
    const lock = SqlitePluginInstallationProfileLock.acquire(
      dependencies.database,
      scope,
    )!;
    let owner: SqlitePluginInstallationProfileOwner | undefined;
    try {
      owner = new SqlitePluginInstallationProfileOwner(dependencies, key, lock);
      await owner.#begin();
      return owner;
    } catch (error) {
      if (owner) await owner.close();
      else lock.close();
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
  /** The actual held claim can be checked inside its owned transaction without exposing a projection. */
  assertOwnership(): void {
    this.#assertOpen();
    if (!this.#initialized) throw new Error("plugin_profile_owner_not_ready");
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

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = Promise.resolve().then(async () => {
      await this.#tail;
      this.#lock.close();
      this.#registry.delete(this);
      if (this.#registry.size === 0) owners.delete(this.#key);
      this.#unregister();
    });
    this.#lose(new Error("plugin_profile_owner_closed"));
    return this.#closing;
  }

  async #begin(): Promise<void> {
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
      this.#lock.assertHeld();
    } catch (error) {
      this.#lose(error);
    }
    if (this.#state !== "held")
      throw new Error("plugin_profile_owner_unavailable", {
        cause: this.#failure,
      });
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
        SQLITE_PLUGIN_PROFILE_OWNER_LIMITS.selectionsPerProfile
    )
      throw new Error("plugin_profile_owner_selection_limit");
    const entry = Object.freeze({ selection, package: pkg });
    return () => {
      if (this.#state === "held")
        this.#projections.set(selection.pluginId, entry);
    };
  }
  #run<T>(operation: () => T): Promise<T> {
    this.#assertOpen();
    if (this.#pending >= SQLITE_PLUGIN_PROFILE_OWNER_LIMITS.pendingOperations)
      return Promise.reject(
        new Error("plugin_profile_owner_operation_capacity_exhausted"),
      );
    this.#pending++;
    const token = Symbol();
    const result = this.#tail.then(() => {
      this.#assertOpen();
      this.#mutation = token;
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
    try {
      this.#dependencies.onOwnershipLost(error);
    } catch {
      /* Withdrawal cannot restore ownership. */
    }
    void this.close().catch(() => {});
  }
}
