import { join } from "node:path";
import {
  ApplicationError,
  type PluginUiPackageContext,
  type PluginUiPackagePort,
} from "@crewon/application";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  parsePluginUiLease,
  type PluginPackageDescriptor,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import {
  assertDirectoryPins,
  hostPath,
  pinDirectory,
  readPackageFile,
  type DirectoryPin,
} from "./local-plugin-package-files.ts";
import {
  verifyLocalPluginPackage,
  sha256,
} from "./local-plugin-package-verifier.ts";
import {
  uiPackageAssetPath,
  uiPackageContext,
  uiPackageDescriptor,
  uiPackageFailure,
  uiPackageMime,
  uiPackagePublicAssets,
  uiPackageRecord,
} from "./plugin-ui-package-reader-support.ts";

export type LocalPluginUiPackageReaderDependencies = Readonly<{
  profile: PluginProfileScope;
  installRoot: string;
  /** Required publisher/publication authority; no inventory item is implicitly browser-public. */
  authorizePublication(
    input: PluginUiPackageContext &
      Readonly<{ descriptor: PluginPackageDescriptor }>,
  ): Promise<readonly string[]>;
}>;
type Verified = Readonly<{
  directory: string;
  descriptor: PluginPackageDescriptor;
  pins: readonly DirectoryPin[];
}>;
const MAXIMUM_ASSET_BYTES = 32 * 1024 * 1024;

/** Private byte adapter. It neither executes UI code nor grants mount, action or current-epoch authority. */
export class LocalPluginUiPackageReader implements PluginUiPackagePort {
  readonly #profile: PluginProfileScope;
  readonly #installRoot: string;
  readonly #authorizePublication: LocalPluginUiPackageReaderDependencies["authorizePublication"];

  constructor(input: LocalPluginUiPackageReaderDependencies) {
    this.#profile = parsePluginProfileScope(input.profile);
    this.#installRoot = hostPath(input.installRoot);
    if (typeof input.authorizePublication !== "function")
      uiPackageFailure("internal", "plugin_ui_publication_policy_missing");
    this.#authorizePublication = input.authorizePublication;
  }

  async verify(input: PluginUiPackageContext) {
    const context = uiPackageContext(
      uiPackageRecord(input, ["actor", "scope", "selection", "package"]),
      this.#profile,
    );
    const before = await this.#verified(context);
    const publicAssets = await this.#publication(context, before.descriptor);
    await this.#verified(context);
    await assertDirectoryPins(before.pins, false);
    return Object.freeze({ descriptor: before.descriptor, publicAssets });
  }

  async readAsset(
    input: PluginUiPackageContext &
      Readonly<{ lease: PluginUiLease; path: string }>,
  ) {
    const value = uiPackageRecord(input, [
      "actor",
      "scope",
      "selection",
      "package",
      "lease",
      "path",
    ]);
    const context = uiPackageContext(value, this.#profile);
    const lease = parsePluginUiLease(value.lease);
    const path = uiPackageAssetPath(value.path);
    if (!lease.publicAssets.includes(path))
      uiPackageFailure("authorization", "plugin_ui_asset_not_public");
    this.#lease(context, lease);
    const before = await this.#verified(context);
    this.#leaseDescriptor(lease, before.descriptor);
    const approved = await this.#publication(context, before.descriptor);
    this.#samePublication(lease.publicAssets, approved);
    const afterPolicy = await this.#verified(context);
    await assertDirectoryPins(before.pins, false);
    const declared = afterPolicy.descriptor.files.find(
      (file) => file.path === path,
    );
    if (!declared)
      uiPackageFailure("authorization", "plugin_ui_asset_not_public");
    const packagePin = await pinDirectory(afterPolicy.directory);
    const parents = [packagePin];
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directory = join(afterPolicy.directory, ...parts.slice(0, index));
      const pin = await pinDirectory(directory);
      if (pin.path !== directory)
        uiPackageFailure("internal", "plugin_ui_installed_path_invalid");
      parents.push(pin);
    }
    const bytes = await readPackageFile({
      path: join(afterPolicy.directory, path),
      maximumBytes: MAXIMUM_ASSET_BYTES,
      expectedBytes: declared.byteLength,
      parents,
    });
    if (sha256(bytes) !== declared.sha256)
      uiPackageFailure("internal", "plugin_ui_asset_digest_mismatch");
    const afterRead = await this.#verified(context);
    const currentPublication = await this.#publication(
      context,
      afterRead.descriptor,
    );
    this.#samePublication(lease.publicAssets, currentPublication);
    await this.#verified(context);
    await assertDirectoryPins(before.pins, false);
    await assertDirectoryPins(parents);
    return Object.freeze({
      bytes: Uint8Array.from(bytes),
      contentType: uiPackageMime(path),
    });
  }

  async #verified(context: PluginUiPackageContext): Promise<Verified> {
    const root = await pinDirectory(this.#installRoot);
    if (
      (typeof process.getuid === "function" &&
        root.stats.uid !== BigInt(process.getuid())) ||
      (root.stats.mode & 0o022n) !== 0n
    )
      uiPackageFailure("internal", "plugin_ui_install_root_invalid");
    const packagesPath = join(root.path, "packages");
    const packages = await pinDirectory(packagesPath);
    if (packages.path !== packagesPath)
      uiPackageFailure("internal", "plugin_ui_installed_path_invalid");
    const directory = join(
      packagesPath,
      context.package.packageDigest.slice(7),
    );
    const verified = await verifyLocalPluginPackage({ directory });
    if (
      verified.directory !== directory ||
      verified.packageDigest !== context.package.packageDigest
    )
      uiPackageFailure("internal", "plugin_ui_installed_bytes_mismatch");
    uiPackageDescriptor(context, verified.descriptor);
    await assertDirectoryPins([root, packages], false);
    return Object.freeze({
      directory,
      descriptor: verified.descriptor,
      pins: Object.freeze([root, packages]),
    });
  }

  async #publication(
    context: PluginUiPackageContext,
    descriptor: PluginPackageDescriptor,
  ) {
    let raw;
    try {
      raw = await this.#authorizePublication(
        Object.freeze({ ...context, descriptor }),
      );
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      uiPackageFailure("internal", "plugin_ui_publication_unavailable", error);
    }
    return uiPackagePublicAssets(raw, descriptor);
  }

  #lease(context: PluginUiPackageContext, lease: PluginUiLease): void {
    if (
      lease.packageDigest !== context.package.packageDigest ||
      lease.selectionRevision !== context.selection.revision
    )
      uiPackageFailure("conflict", "plugin_ui_asset_lease_mismatch");
    uiPackageDescriptor(context, lease.descriptor);
    const contribution = lease.descriptor.contributions.find(
      (item) => item.id === lease.contributionId,
    );
    if (contribution?.kind !== "module" || contribution.slot !== "main.content")
      uiPackageFailure("conflict", "plugin_ui_contribution_unsupported");
  }
  #leaseDescriptor(
    lease: PluginUiLease,
    descriptor: PluginPackageDescriptor,
  ): void {
    if (JSON.stringify(lease.descriptor) !== JSON.stringify(descriptor))
      uiPackageFailure("conflict", "plugin_ui_asset_lease_mismatch");
  }
  #samePublication(
    expected: readonly string[],
    actual: readonly string[],
  ): void {
    if (JSON.stringify([...expected].sort()) !== JSON.stringify(actual))
      uiPackageFailure("conflict", "plugin_ui_publication_changed");
  }
}
