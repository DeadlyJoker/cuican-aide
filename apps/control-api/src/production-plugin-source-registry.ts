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
  view: PluginSourceView;
}>;

/** Approved private source identities. Actor permission is decided separately for every operation. */
export class ProductionPluginSourceRegistry {
  readonly #entries: readonly Entry[];
  #activeReads = 0;
  private constructor(
    entries: readonly Entry[],
    configuration: ProductionPluginInstallationConfiguration,
    token: symbol,
  ) {
    if (token !== construction)
      throw new Error("production_plugin_source_registry_required");
    this.#entries = entries;
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
      const directory = await privateDirectory(source.directory);
      if (
        contains(installRoot, directory) ||
        contains(directory, installRoot) ||
        directories.has(directory)
      )
        throw new Error("production_plugin_source_directory_conflict");
      directories.add(directory);
      const snapshot = await verifyLocalPluginPackage({ directory });
      assertIdentity(source, snapshot);
      const view = parsePluginSourceView({
        sourceId: source.sourceId,
        pluginId: snapshot.descriptor.pluginId,
        publisherId: snapshot.descriptor.publisherId,
        version: snapshot.descriptor.version,
        packageDigest: snapshot.packageDigest,
        title: snapshot.descriptor.title,
        description: snapshot.descriptor.description,
      });
      entries.push(
        Object.freeze({
          source: Object.freeze({ ...source, directory }),
          view,
        }),
      );
    }
    entries.sort((a, b) =>
      a.view.sourceId < b.view.sourceId
        ? -1
        : a.view.sourceId > b.view.sourceId
          ? 1
          : 0,
    );
    // Any legal page fits the wire budget, including its largest possible cursor.
    parsePluginSourceListResponse(
      {
        sources: entries.map((entry) => entry.view),
        next: entries.at(-1)?.view.sourceId ?? null,
      },
      { afterSourceId: null, limit: Math.max(1, entries.length) },
    );
    const longestCursor = entries.reduce<string | null>(
      (longest, entry) =>
        longest === null ||
        Buffer.byteLength(JSON.stringify(entry.view.sourceId)) >
          Buffer.byteLength(JSON.stringify(longest))
          ? entry.view.sourceId
          : longest,
      null,
    );
    if (
      Buffer.byteLength(
        JSON.stringify({
          sources: entries.map((entry) => entry.view),
          next: longestCursor,
        }),
      ) > MAX_PLUGIN_CONTROL_RESPONSE_BYTES
    )
      throw new Error("production_plugin_source_catalog_budget_exceeded");
    return new ProductionPluginSourceRegistry(
      Object.freeze(entries),
      parsed,
      construction,
    );
  }
  list(): readonly PluginSourceView[] {
    return Object.freeze(this.#entries.map((entry) => entry.view));
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
      if (directory !== entry.source.directory)
        throw new Error("production_plugin_source_identity_mismatch");
      const snapshot = await verifyLocalPluginPackage({ directory });
      assertIdentity(entry.source, snapshot);
      return directory;
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
