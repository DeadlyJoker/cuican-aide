import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import {
  PLUGIN_PACKAGE_DESCRIPTOR_PATH,
  PLUGIN_PACKAGE_LIMITS,
  PluginPackageContractError,
  parsePluginPackageDescriptor,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import {
  assertDirectoryPins,
  pinDirectory,
  readPackageFile,
  type DirectoryPin,
} from "./local-plugin-package-files.ts";
import {
  LocalPluginPackageError,
  packageFailure,
  resolvePackageLimits,
  type VerifiedLocalPluginPackage,
  type VerifyLocalPluginPackageInput,
} from "./local-plugin-package-types.ts";

export type PackageSnapshot = Readonly<{
  verification: VerifiedLocalPluginPackage;
  descriptorBytes: Buffer;
  files: ReadonlyMap<string, Buffer>;
  directories: readonly string[];
}>;

/** No scripts or modules are imported. Every listed and unlisted directory entry is inspected. */
export async function verifyLocalPluginPackage(
  input: VerifyLocalPluginPackageInput,
): Promise<VerifiedLocalPluginPackage> {
  return (await captureLocalPluginPackage(input, false)).verification;
}

/** Installer-private bytes: copying these prevents mixing source revisions after authorization. */
export async function captureLocalPluginPackage(
  input: VerifyLocalPluginPackageInput,
  captureFiles: boolean,
): Promise<PackageSnapshot> {
  try {
    return await capture(input, captureFiles);
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (
      error instanceof LocalPluginPackageError ||
      error instanceof PluginPackageContractError
    )
      throw error;
    packageFailure("plugin_package_filesystem_unavailable", error);
  }
}

async function capture(
  input: VerifyLocalPluginPackageInput,
  captureFiles: boolean,
): Promise<PackageSnapshot> {
  input.signal?.throwIfAborted();
  const limits = resolvePackageLimits(input.limits);
  const root = await pinDirectory(input.directory);
  const descriptorBytes = await readPackageFile({
    path: join(root.path, PLUGIN_PACKAGE_DESCRIPTOR_PATH),
    maximumBytes: Math.min(
      PLUGIN_PACKAGE_LIMITS.descriptorBytes,
      limits.fileBytes,
      limits.totalBytes,
    ),
    parents: [root],
    signal: input.signal,
  });
  let descriptor: PluginPackageDescriptor;
  try {
    descriptor = parsePluginPackageDescriptor(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(descriptorBytes),
      ),
    );
  } catch (error) {
    if (error instanceof PluginPackageContractError) throw error;
    packageFailure("plugin_package_descriptor_invalid", error);
  }
  const expected = new Map(descriptor.files.map((file) => [file.path, file]));
  let declaredBytes = descriptorBytes.byteLength;
  for (const file of descriptor.files) {
    if (file.byteLength > limits.fileBytes)
      packageFailure("plugin_package_file_limit");
    declaredBytes += file.byteLength;
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > limits.totalBytes
    )
      packageFailure("plugin_package_total_limit");
  }
  const found = new Set<string>();
  const pins: DirectoryPin[] = [root];
  const directories: string[] = [];
  const files = new Map<string, Buffer>();
  let entries = 0;
  let totalBytes = 0;
  let descriptorFound = false;

  const walk = async (
    relative: string,
    parents: readonly DirectoryPin[],
  ): Promise<void> => {
    input.signal?.throwIfAborted();
    await assertDirectoryPins(parents);
    const directory = await opendir(join(root.path, relative));
    try {
      for await (const entry of directory) {
        input.signal?.throwIfAborted();
        if (++entries > limits.directoryEntries)
          packageFailure("plugin_package_directory_entry_limit");
        const path = relative ? relative + "/" + entry.name : entry.name;
        const absolute = join(root.path, path);
        const stats = await lstat(absolute, { bigint: true });
        if (stats.isSymbolicLink())
          packageFailure("plugin_package_file_type_invalid");
        if (stats.isDirectory()) {
          if (directories.length >= limits.directories)
            packageFailure("plugin_package_directory_limit");
          // The same path grammar applies to directories, including empty ones.
          if (
            new TextEncoder().encode(path).byteLength >
              PLUGIN_PACKAGE_LIMITS.pathBytes ||
            /[\\%:?#\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)
          )
            packageFailure("plugin_package_directory_invalid");
          const pin = await pinDirectory(absolute);
          if (pin.path !== absolute)
            packageFailure("plugin_package_directory_invalid");
          pins.push(pin);
          directories.push(path);
          await walk(path, [...parents, pin]);
          continue;
        }
        if (!stats.isFile() || stats.nlink !== 1n)
          packageFailure("plugin_package_file_type_invalid");
        if (path === PLUGIN_PACKAGE_DESCRIPTOR_PATH) {
          if (descriptorFound) packageFailure("plugin_package_file_conflict");
          descriptorFound = true;
          const bytes = await readPackageFile({
            path: absolute,
            maximumBytes: PLUGIN_PACKAGE_LIMITS.descriptorBytes,
            expectedBytes: descriptorBytes.byteLength,
            parents,
            signal: input.signal,
          });
          if (!bytes.equals(descriptorBytes))
            packageFailure("plugin_package_source_changed");
          totalBytes += bytes.byteLength;
          continue;
        }
        const declared = expected.get(path);
        if (declared === undefined)
          packageFailure("plugin_package_file_undeclared");
        if (found.has(path)) packageFailure("plugin_package_file_conflict");
        const bytes = await readPackageFile({
          path: absolute,
          maximumBytes: limits.fileBytes,
          expectedBytes: declared.byteLength,
          parents,
          signal: input.signal,
        });
        if (sha256(bytes) !== declared.sha256)
          packageFailure("plugin_package_file_digest_mismatch");
        totalBytes += bytes.byteLength;
        if (totalBytes > limits.totalBytes)
          packageFailure("plugin_package_total_limit");
        found.add(path);
        if (captureFiles) files.set(path, bytes);
      }
    } finally {
      await directory.close().catch((error: unknown) => {
        if (!hasCode(error, "ERR_DIR_CLOSED")) throw error;
      });
    }
    await assertDirectoryPins(parents);
  };
  await walk("", [root]);
  if (!descriptorFound || found.size !== descriptor.files.length)
    packageFailure("plugin_package_artifact_missing");
  await assertDirectoryPins(pins);
  input.signal?.throwIfAborted();
  directories.sort();
  // Actual descriptor bytes participate, including formatting; no fabricated identity claim.
  const identity = {
    schemaVersion: "crewon.local-plugin-package-identity.v1",
    descriptorSha256: sha256(descriptorBytes),
    directories,
    files: descriptor.files
      .map((file) => ({
        path: file.path,
        byteLength: file.byteLength,
        sha256: file.sha256,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  const verification: VerifiedLocalPluginPackage = Object.freeze({
    directory: root.path,
    descriptor,
    packageDigest: "sha256:" + sha256(Buffer.from(JSON.stringify(identity))),
    totalBytes,
    fileCount: found.size + 1,
  });
  return Object.freeze({
    verification,
    descriptorBytes,
    files,
    directories: Object.freeze(directories),
  });
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
