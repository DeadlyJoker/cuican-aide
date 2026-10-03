import { join } from "node:path";
import { ApplicationError } from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionManifest,
  type InstalledPluginPackage,
  type PluginSelection,
} from "@crewon/domain";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  readInstalledPluginBusinessManifest,
  verifyLocalPluginPackage,
  assertUiOnlyServiceDeclarations,
  assertPluginUiHostServiceAvailability,
  type PluginNodeHost,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import type { ProductionPluginSourceRegistry } from "./production-plugin-source-registry.ts";

export function installationSame(a: unknown, b: unknown): boolean {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}

/** Compatibility reads the actual package and business protocol; it never declares execution ready. */
export async function verifyProductionInstalledPackage(
  input: Readonly<{
    installRoot: string;
    package: InstalledPluginPackage;
    registry: ProductionPluginSourceRegistry;
    signal: AbortSignal;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
): Promise<PluginPackageDescriptor> {
  const pkg = input.package;
  const actual = await verifyLocalPluginPackage({
    directory: join(input.installRoot, "packages", pkg.packageDigest.slice(7)),
    signal: input.signal,
  });
  input.signal.throwIfAborted();
  const descriptor = actual.descriptor;
  if (
    actual.packageDigest !== pkg.packageDigest ||
    descriptor.pluginId !== pkg.pluginId ||
    descriptor.publisherId !== pkg.publisherId ||
    descriptor.version !== pkg.version ||
    input.registry.authorizeCandidate(actual) !== "allow"
  )
    throw new ApplicationError(
      "authorization",
      "plugin_installation_package_unapproved",
    );
  assertUiOnlyServiceDeclarations(descriptor, input.hostUiServices);
  if (descriptor.businessManifestPath !== null) {
    const snapshot = await readInstalledPluginBusinessManifest({
      installRoot: input.installRoot,
      expectedPluginId: pkg.pluginId,
      expectedPublisherId: pkg.publisherId,
      expectedVersion: pkg.version,
      expectedPackageDigest: pkg.packageDigest,
      signal: input.signal,
      authorizeRead: async (candidate) =>
        input.registry.authorizeCandidate(candidate),
    });
    const manifest = parseExtensionManifest(snapshot.manifest);
    if (
      manifest.pluginId !== pkg.pluginId ||
      manifest.version !== pkg.version ||
      descriptor.entrypoints.node === null
    )
      throw new ApplicationError(
        "conflict",
        "plugin_installation_business_incompatible",
      );
  }
  return descriptor;
}

export type InstallationRecoveryRecord = Readonly<{
  selection: PluginSelection;
  package: InstalledPluginPackage | null;
  descriptor: PluginPackageDescriptor | null;
  epoch: string;
}>;

/** Full preflight before setup; required providers precede consumers, never latest-package fallback. */
export function orderInstallationRecoveries(
  records: readonly InstallationRecoveryRecord[],
  node: PluginNodeHost,
  hostUiServices?: PluginUiHostServiceAvailabilityPort,
): readonly InstallationRecoveryRecord[] {
  const replacing = new Set(records.map((record) => record.selection.pluginId));
  const available = new Map<
    string,
    Readonly<{ apiVersion: string; record: InstallationRecoveryRecord | null }>
  >();
  for (const value of node.serviceIdentities())
    if (value.provider === null || !replacing.has(value.provider.pluginId))
      available.set(value.service, {
        apiVersion: value.apiVersion,
        record: null,
      });
  for (const record of records) {
    if (record.selection.state !== "enabled") continue;
    for (const service of record.descriptor!.provides) {
      if (available.has(service.service))
        throw new ApplicationError("conflict", "plugin_service_conflict");
      available.set(service.service, {
        apiVersion: service.apiVersion,
        record,
      });
    }
  }
  const pending = new Map<
    InstallationRecoveryRecord,
    Set<InstallationRecoveryRecord>
  >();
  for (const record of records) {
    const dependencies = new Set<InstallationRecoveryRecord>();
    if (record.selection.state === "enabled") {
      if (record.descriptor!.entrypoints.node === null) {
        assertPluginUiHostServiceAvailability({
          scope: {
            tenantId: record.selection.tenantId,
            spaceId: record.selection.spaceId,
            profileId: record.selection.profileId,
          },
          candidate: {
            descriptor: record.descriptor!,
            packageDigest: record.package!.packageDigest,
          },
          hostUiServices,
        });
        pending.set(record, dependencies);
        continue;
      }
      for (const requirement of record.descriptor!.requires) {
        if (requirement.optional) continue;
        const provider = available.get(requirement.service);
        if (provider?.apiVersion !== requirement.apiVersion)
          throw new ApplicationError(
            "conflict",
            "plugin_dependency_unavailable",
          );
        if (provider.record !== null) dependencies.add(provider.record);
      }
    }
    pending.set(record, dependencies);
  }
  const result: InstallationRecoveryRecord[] = [];
  while (pending.size) {
    const ready = [...pending].find(
      ([, dependencies]) => dependencies.size === 0,
    );
    if (!ready)
      throw new ApplicationError("conflict", "plugin_dependency_cycle");
    const record = ready[0];
    pending.delete(record);
    result.push(record);
    for (const dependencies of pending.values()) dependencies.delete(record);
  }
  return Object.freeze(result);
}
