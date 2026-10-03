import { join } from "node:path";
import { ApplicationError } from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionManifest,
  type InstalledPluginPackage,
} from "@crewon/domain";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  readInstalledPluginBusinessManifest,
  verifyLocalPluginPackage,
  assertUiOnlyServiceDeclarations,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import type { DesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";

export function installationSame(a: unknown, b: unknown): boolean {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}

/** Compatibility reads the actual package and business protocol; it never declares execution ready. */
export async function verifyDesktopInstalledPackage(
  input: Readonly<{
    installRoot: string;
    package: InstalledPluginPackage;
    registry: DesktopPluginSourceRegistry;
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
