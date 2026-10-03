import { lstat, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import {
  parsePluginSourceListResponse,
  parsePluginSourceView,
  MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
  type PluginSourceView,
} from "@crewon/contracts";
import {
  parsePluginPackageDescriptor,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import { pluginInstallationDigest } from "@crewon/domain";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import {
  parseProductionPluginInstallationConfiguration,
  type ProductionPluginInstallationConfiguration,
  type ProductionPluginInstallationSource,
} from "./production-plugin-installation-environment.ts";

const registries = new WeakMap<
  object,
  ProductionPluginInstallationConfiguration
>();
const construction = Symbol("verified-production-plugin-source-registry");
type Entry = Readonly<{
  source: ProductionPluginInstallationSource;
  directory: string | null;
  view: PluginSourceView | null;
}>;

/** Approved private source identities. Actor permission is decided separately for every operation. */
export class ProductionPluginSourceRegistry {
  readonly #entries: readonly Entry[];
  readonly #installRoot: string;
  readonly #views = new Map<string, PluginSourceView>();
  readonly #directories = new Map<string, string>();
  #activeReads = 0;
  private constructor(
    entries: readonly Entry[],
    configuration: ProductionPluginInstallationConfiguration,
    installRoot: string,
    token: symbol,
  ) {
    if (token !== construction)
      throw new Error("production_plugin_source_registry_required");
    this.#entries = entries;
    this.#installRoot = installRoot;
    for (const entry of entries) {
      if (entry.view !== null)
        this.#views.set(entry.source.sourceId, entry.view);
      if (entry.directory !== null)
        this.#directories.set(entry.source.sourceId, entry.directory);
    }
    registries.set(this, configuration);
    Object.freeze(this);
  }
  static async create(
    configuration: ProductionPluginInstallationConfiguration,
  ): Promise<ProductionPluginSourceRegistry> {
    const parsed =
      parseProductionPluginInstallationConfiguration(configuration);
    const installRoot = await privateDirectory(parsed.installRoot);
    const entries: Entry[] = [];
    const directories = new Set<string>();
    for (const source of parsed.sources) {
      // Approval is the immutable configured identity. Availability belongs to the source bytes.
      if (
        contains(parsed.installRoot, source.directory) ||
        contains(source.directory, parsed.installRoot) ||
        contains(installRoot, source.directory) ||
        contains(source.directory, installRoot)
      )
        throw new Error("production_plugin_source_directory_conflict");
      let directory: string | null = null;
      try {
        directory = await privateDirectory(source.directory);
      } catch {
        // An absent or unsafe delivery directory cannot revoke an independently installed copy.
      }
      if (directory !== null) {
        if (
          contains(installRoot, directory) ||
          contains(directory, installRoot) ||
          directories.has(directory)
        )
          throw new Error("production_plugin_source_directory_conflict");
        directories.add(directory);
      }
      let view: PluginSourceView | null = null;
      if (directory !== null) {
        try {
          const snapshot = await verifyLocalPluginPackage({ directory });
          assertIdentity(source, snapshot);
          view = sourceView(source, snapshot.descriptor);
        } catch {
          // No invented metadata or installable listing for missing, corrupt or mismatched bytes.
        }
      }
      entries.push(Object.freeze({ source, directory, view }));
    }
    entries.sort((a, b) =>
      a.source.sourceId < b.source.sourceId
        ? -1
        : a.source.sourceId > b.source.sourceId
          ? 1
          : 0,
    );
    assertCatalog(
      entries.flatMap((entry) => (entry.view === null ? [] : [entry.view])),
    );
    return new ProductionPluginSourceRegistry(
      Object.freeze(entries),
      parsed,
      installRoot,
      construction,
    );
  }
  list(): readonly PluginSourceView[] {
    return Object.freeze(
      this.#entries.flatMap(({ source }) => {
        const view = this.#views.get(source.sourceId);
        return view === undefined ? [] : [view];
      }),
    );
  }
  async resolveSource(sourceId: string): Promise<string> {
    const entry = this.#entries.find(
      (item) => item.source.sourceId === sourceId,
    );
    if (!entry) throw new Error("production_plugin_source_not_found");
    if (this.#activeReads >= 4)
      throw new Error("production_plugin_source_capacity_exceeded");
    this.#activeReads++;
    try {
      const directory = await privateDirectory(entry.source.directory);
      if (
        this.#directories.has(sourceId) &&
        directory !== this.#directories.get(sourceId)
      )
        throw new Error("production_plugin_source_identity_mismatch");
      if (
        contains(this.#installRoot, directory) ||
        contains(directory, this.#installRoot) ||
        [...this.#directories].some(
          ([id, original]) => id !== sourceId && original === directory,
        )
      )
        throw new Error("production_plugin_source_directory_conflict");
      const snapshot = await verifyLocalPluginPackage({ directory });
      assertIdentity(entry.source, snapshot);
      const view = sourceView(entry.source, snapshot.descriptor);
      const prospective = new Map(this.#views).set(sourceId, view);
      assertCatalog(
        this.#entries.flatMap(({ source }) => {
          const item = prospective.get(source.sourceId);
          return item === undefined ? [] : [item];
        }),
      );
      this.#directories.set(sourceId, directory);
      this.#views.set(sourceId, view);
      return directory;
    } catch (error) {
      this.#views.delete(sourceId);
      throw error;
    } finally {
      this.#activeReads--;
    }
  }
  authorizeCandidate(
    input: Readonly<{
      descriptor: PluginPackageDescriptor;
      packageDigest: string;
    }>,
  ): "allow" | "deny" {
    const descriptor = parsePluginPackageDescriptor(input.descriptor);
    const digest = pluginInstallationDigest(input.packageDigest);
    return this.#entries.some(
      ({ source }) =>
        source.pluginId === descriptor.pluginId &&
        source.publisherId === descriptor.publisherId &&
        source.version === descriptor.version &&
        source.packageDigest === digest,
    )
      ? "allow"
      : "deny";
  }
}
export async function createProductionPluginSourceRegistry(
  configuration: ProductionPluginInstallationConfiguration,
): Promise<ProductionPluginSourceRegistry> {
  return ProductionPluginSourceRegistry.create(configuration);
}
export function assertProductionPluginSourceRegistry(
  input: unknown,
  configuration?: ProductionPluginInstallationConfiguration,
): asserts input is ProductionPluginSourceRegistry {
  if (input === null || typeof input !== "object" || !registries.has(input))
    throw new Error("production_plugin_source_registry_required");
  if (configuration !== undefined) {
    const expected =
      parseProductionPluginInstallationConfiguration(configuration);
    const original = registries.get(input)!;
    if (
      expected.installRoot !== original.installRoot ||
      JSON.stringify(expected.sources) !== JSON.stringify(original.sources)
    )
      throw new Error(
        "production_plugin_source_registry_configuration_mismatch",
      );
  }
}
function sourceView(
  source: ProductionPluginInstallationSource,
  descriptor: PluginPackageDescriptor,
): PluginSourceView {
  return parsePluginSourceView({
    sourceId: source.sourceId,
    pluginId: descriptor.pluginId,
    publisherId: descriptor.publisherId,
    version: descriptor.version,
    packageDigest: source.packageDigest,
    title: descriptor.title,
    description: descriptor.description,
  });
}
function assertCatalog(views: readonly PluginSourceView[]): void {
  // Any legal page fits the wire budget, including its largest possible cursor.
  parsePluginSourceListResponse(
    { sources: views, next: views.at(-1)?.sourceId ?? null },
    { afterSourceId: null, limit: Math.max(1, views.length) },
  );
  const longestCursor = views.reduce<string | null>(
    (longest, view) =>
      longest === null ||
      Buffer.byteLength(JSON.stringify(view.sourceId)) >
        Buffer.byteLength(JSON.stringify(longest))
        ? view.sourceId
        : longest,
    null,
  );
  if (
    Buffer.byteLength(JSON.stringify({ sources: views, next: longestCursor })) >
    MAX_PLUGIN_CONTROL_RESPONSE_BYTES
  )
    throw new Error("production_plugin_source_catalog_budget_exceeded");
}
function assertIdentity(
  source: ProductionPluginInstallationSource,
  candidate: Readonly<{
    descriptor: PluginPackageDescriptor;
    packageDigest: string;
  }>,
): void {
  if (
    candidate.descriptor.pluginId !== source.pluginId ||
    candidate.descriptor.publisherId !== source.publisherId ||
    candidate.descriptor.version !== source.version ||
    candidate.packageDigest !== source.packageDigest
  )
    throw new Error("production_plugin_source_identity_mismatch");
}
async function privateDirectory(path: string): Promise<string> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    typeof process.getuid !== "function" ||
    before.uid !== BigInt(process.getuid()) ||
    (before.mode & 0o077n) !== 0n
  )
    throw new Error("production_plugin_source_private_directory_required");
  const canonical = await realpath(path);
  const after = await lstat(canonical, { bigint: true });
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.uid !== after.uid
  )
    throw new Error("production_plugin_source_directory_changed");
  return canonical;
}
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!path.startsWith("../") && path !== ".." && !isAbsolute(path))
  );
}
