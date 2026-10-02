import { join } from "node:path";
import { ApplicationError } from "@crewon/application";
import type { InstalledPluginPackage } from "@crewon/domain";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  assertDirectoryPins,
  pinDirectory,
} from "./local-plugin-package-files.ts";
import { verifyLocalPluginPackage } from "./local-plugin-package-verifier.ts";

/** Node service declarations cannot be satisfied by a browser-only entry. */
export function assertUiOnlyServiceDeclarations(
  descriptor: PluginPackageDescriptor,
): void {
  if (
    descriptor.entrypoints.node === null &&
    (descriptor.requires.length !== 0 || descriptor.provides.length !== 0)
  )
    throw new ApplicationError(
      "conflict",
      "plugin_ui_only_services_unsupported",
    );
}

/** Actual installed bytes and identity, with the same private-root boundary as Node activation. */
export async function verifyInstalledSelectionPackage(input: {
  installRoot: string;
  package: InstalledPluginPackage;
}): Promise<PluginPackageDescriptor> {
  const root = await pinDirectory(input.installRoot);
  if (
    (typeof process.getuid === "function" &&
      root.stats.uid !== BigInt(process.getuid())) ||
    (root.stats.mode & 0o022n) !== 0n
  )
    throw new ApplicationError(
      "internal",
      "plugin_package_install_root_invalid",
    );
  const packagesPath = join(root.path, "packages");
  const packages = await pinDirectory(packagesPath);
  const directory = join(packagesPath, input.package.packageDigest.slice(7));
  const verified = await verifyLocalPluginPackage({ directory });
  const descriptor = verified.descriptor;
  if (
    packages.path !== packagesPath ||
    verified.directory !== directory ||
    verified.packageDigest !== input.package.packageDigest ||
    descriptor.pluginId !== input.package.pluginId ||
    descriptor.version !== input.package.version ||
    descriptor.publisherId !== input.package.publisherId
  )
    throw new ApplicationError("internal", "plugin_installed_bytes_mismatch");
  await assertDirectoryPins([root, packages], false);
  assertUiOnlyServiceDeclarations(descriptor);
  return descriptor;
}
