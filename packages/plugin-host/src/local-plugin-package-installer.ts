import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PLUGIN_PACKAGE_DESCRIPTOR_PATH } from "@crewon/contracts/plugins";
import {
  assertDirectoryPins,
  pinDirectory,
  sameIdentity,
  type DirectoryPin,
} from "./local-plugin-package-files.ts";
import {
  LocalPluginPackageError,
  packageFailure,
  resolvePackageLimits,
  type InstallLocalPluginPackageInput,
  type InstalledLocalPluginPackage,
} from "./local-plugin-package-types.ts";
import {
  captureLocalPluginPackage,
  hasCode,
  verifyLocalPluginPackage,
  type PackageSnapshot,
} from "./local-plugin-package-verifier.ts";

/**
 * Local prebuilt directories only. No imports, scripts, dependency resolution or activation.
 * Root must be host-owned: content-addressed names and read-only modes are not an OS sandbox.
 */
export async function installLocalPluginPackage(
  input: InstallLocalPluginPackageInput,
): Promise<InstalledLocalPluginPackage> {
  if (typeof input.authorization !== "function")
    packageFailure("plugin_package_installation_authorization_required");
  try {
    return await install(input);
  } catch (error) {
    if (
      error instanceof LocalPluginPackageError &&
      error.code === "plugin_package_publication_protection_failed"
    )
      throw error;
    if (input.signal?.aborted) throw input.signal.reason;
    if (
      error instanceof LocalPluginPackageError ||
      (error instanceof Error && error.name === "PluginPackageContractError")
    )
      throw error;
    packageFailure("plugin_package_installation_unavailable", error);
  }
}

async function install(
  input: InstallLocalPluginPackageInput,
): Promise<InstalledLocalPluginPackage> {
  const limits = resolvePackageLimits(input.limits);
  const snapshot = await captureLocalPluginPackage(input, true);
  const root = await privateHostDirectory(input.installRoot);
  if (
    containsPath(root.path, snapshot.verification.directory) ||
    containsPath(snapshot.verification.directory, root.path)
  )
    packageFailure("plugin_package_installation_paths_overlap");
  input.signal?.throwIfAborted();
  let decision: unknown;
  try {
    decision = await abortable(
      Promise.resolve().then(() => {
        input.signal?.throwIfAborted();
        return input.authorization(
          Object.freeze({
            descriptor: snapshot.verification.descriptor,
            packageDigest: snapshot.verification.packageDigest,
          }),
        );
      }),
      input.signal,
    );
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    packageFailure(
      "plugin_package_installation_authorization_unavailable",
      error,
    );
  }
  if (
    decision === null ||
    typeof decision !== "object" ||
    !("outcome" in decision) ||
    (decision.outcome !== "allow" && decision.outcome !== "deny")
  )
    packageFailure("plugin_package_installation_authorization_unavailable");
  if (decision.outcome !== "allow")
    packageFailure("plugin_package_installation_denied");
  input.signal?.throwIfAborted();
  await assertDirectoryPins([root], false);
  const packages = await hostChildDirectory(root, "packages");
  const stagingRoot = await hostChildDirectory(root, ".staging");
  const locks = await hostChildDirectory(root, ".locks");
  const digest = snapshot.verification.packageDigest.slice("sha256:".length);
  const unlock = await acquirePackageLock(locks, digest, input.signal);
  let stage: DirectoryPin | undefined;
  try {
    await assertDirectoryPins([root, packages, stagingRoot, locks], false);
    stage = await pinDirectory(
      await mkdtemp(join(stagingRoot.path, "package-")),
    );
    await writeSnapshot(stage, snapshot, input.signal);
    const staged = await verifyLocalPluginPackage({
      directory: stage.path,
      limits,
      signal: input.signal,
    });
    if (staged.packageDigest !== snapshot.verification.packageDigest)
      packageFailure("plugin_package_staging_digest_mismatch");
    await makeReadOnly(stage, snapshot);
    for (const directory of [...snapshot.directories].sort(
      (a, b) => b.length - a.length,
    ))
      await syncDirectory(join(stage.path, directory));
    await syncDirectory(stage.path);
    await assertDirectoryPins([root, packages, stagingRoot, locks], false);
    input.signal?.throwIfAborted();
    const target = join(packages.path, digest);
    if (await exists(target))
      return await existingPackage(target, snapshot, limits, input.signal);
    try {
      // All cooperating writers hold this digest lock; never replace an existing version.
      await rename(stage.path, target);
    } catch (error) {
      if (
        (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")) &&
        (await exists(target))
      )
        return await existingPackage(target, snapshot, limits, input.signal);
      throw error;
    }
    // Publication is the commit point. Do not report cancellation after a completed rename.
    stage = undefined;
    // macOS requires the moved directory to be owner-writable during rename.
    // The host owns this root; installation returns only after final permissions are set.
    try {
      await protectPublishedPackage(
        await privateHostDirectory(target),
        snapshot,
      );
      await syncDirectory(packages.path);
    } catch (error) {
      // Bytes are published but not activated. Preserve them for a verified retry.
      packageFailure("plugin_package_publication_protection_failed", error);
    }
    return Object.freeze({
      ...staged,
      directory: target,
      outcome: "installed",
    });
  } finally {
    try {
      if (stage !== undefined) await removeOwnStaging(stage, snapshot);
    } finally {
      await unlock();
    }
  }
}

async function existingPackage(
  path: string,
  snapshot: PackageSnapshot,
  limits: ReturnType<typeof resolvePackageLimits>,
  signal?: AbortSignal,
): Promise<InstalledLocalPluginPackage> {
  try {
    const pin = await privateHostDirectory(path);
    const existing = await verifyLocalPluginPackage({
      directory: path,
      limits,
      signal,
    });
    if (existing.packageDigest !== snapshot.verification.packageDigest)
      packageFailure("plugin_package_existing_invalid");
    signal?.throwIfAborted();
    // Recover permissions after a previous post-rename failure, only for verified same bytes.
    try {
      await protectPublishedPackage(pin, snapshot);
    } catch (error) {
      packageFailure("plugin_package_publication_protection_failed", error);
    }
    return Object.freeze({ ...existing, outcome: "alreadyInstalled" });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (
      error instanceof LocalPluginPackageError &&
      (error.code === "plugin_package_existing_invalid" ||
        error.code === "plugin_package_publication_protection_failed")
    )
      throw error;
    packageFailure("plugin_package_existing_invalid", error);
  }
}

async function privateHostDirectory(path: string): Promise<DirectoryPin> {
  const pin = await pinDirectory(path);
  if (
    (typeof process.getuid === "function" &&
      pin.stats.uid !== BigInt(process.getuid())) ||
    (pin.stats.mode & 0o022n) !== 0n
  )
    packageFailure("plugin_package_install_root_invalid");
  return pin;
}

async function hostChildDirectory(
  parent: DirectoryPin,
  name: string,
): Promise<DirectoryPin> {
  await assertDirectoryPins([parent], false);
  const path = join(parent.path, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const pin = await privateHostDirectory(path);
  if (pin.path !== path) packageFailure("plugin_package_install_root_invalid");
  await assertDirectoryPins([parent], false);
  return pin;
}

async function acquirePackageLock(
  root: DirectoryPin,
  digest: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const path = join(root.path, digest);
  const deadline = performance.now() + 10_000;
  while (true) {
    signal?.throwIfAborted();
    await assertDirectoryPins([root], false);
    try {
      await mkdir(path, { mode: 0o700 });
      const pin = await privateHostDirectory(path);
      return async () => {
        const current = await lstat(pin.path, { bigint: true });
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          !sameIdentity(current, pin.stats)
        )
          packageFailure("plugin_package_install_lock_changed");
        await rmdir(pin.path);
      };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      try {
        await privateHostDirectory(path);
      } catch (lookupError) {
        // The owning installer may have released between mkdir and lstat.
        if (hasCode(lookupError, "ENOENT")) continue;
        throw lookupError;
      }
      if (performance.now() >= deadline)
        packageFailure("plugin_package_installation_busy");
      await delay(10, undefined, { signal });
    }
  }
}

async function writeSnapshot(
  stage: DirectoryPin,
  snapshot: PackageSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  for (const directory of snapshot.directories) {
    signal?.throwIfAborted();
    await mkdir(join(stage.path, directory), { mode: 0o700 });
  }
  for (const [path, content] of [
    [PLUGIN_PACKAGE_DESCRIPTOR_PATH, snapshot.descriptorBytes] as const,
    ...snapshot.files.entries(),
  ]) {
    signal?.throwIfAborted();
    const file = await open(
      join(stage.path, path),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stats = await file.stat({ bigint: true });
      if (!stats.isFile() || stats.nlink !== 1n)
        packageFailure("plugin_package_file_type_invalid");
      let offset = 0;
      while (offset < content.byteLength) {
        signal?.throwIfAborted();
        const written = await file.write(
          content,
          offset,
          content.byteLength - offset,
          offset,
        );
        if (written.bytesWritten === 0)
          packageFailure("plugin_package_write_stalled");
        offset += written.bytesWritten;
      }
      await file.sync();
    } finally {
      await file.close();
    }
  }
}

async function makeReadOnly(
  stage: DirectoryPin,
  snapshot: PackageSnapshot,
): Promise<void> {
  for (const path of [PLUGIN_PACKAGE_DESCRIPTOR_PATH, ...snapshot.files.keys()])
    await chmodIfNeeded(join(stage.path, path), 0o444);
  for (const path of [...snapshot.directories].sort(
    (a, b) => b.length - a.length,
  ))
    await chmodIfNeeded(join(stage.path, path), 0o555);
}

async function protectPublishedPackage(
  published: DirectoryPin,
  snapshot: PackageSnapshot,
): Promise<void> {
  await assertDirectoryPins([published], false);
  await makeReadOnly(published, snapshot);
  await chmodIfNeeded(published.path, 0o555);
  for (const directory of [...snapshot.directories].sort(
    (a, b) => b.length - a.length,
  ))
    await syncDirectory(join(published.path, directory));
  await syncDirectory(published.path);
  await assertDirectoryPins([published], false);
}

async function chmodIfNeeded(path: string, mode: number): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink())
    packageFailure("plugin_package_file_type_invalid");
  // Reinstalling unchanged bytes must not invalidate a concurrent verification via ctime.
  if ((stats.mode & 0o7777) !== mode) await chmod(path, mode);
}

async function removeOwnStaging(
  stage: DirectoryPin,
  snapshot: PackageSnapshot,
): Promise<void> {
  const current = await lstat(stage.path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameIdentity(current, stage.stats)
  )
    packageFailure("plugin_package_staging_changed");
  await chmod(stage.path, 0o700);
  for (const directory of snapshot.directories) {
    const path = join(stage.path, directory);
    try {
      const stats = await lstat(path);
      if (stats.isDirectory() && !stats.isSymbolicLink())
        await chmod(path, 0o700);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  await rm(stage.path, { recursive: true, force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep))
  );
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    if (!(await file.stat()).isDirectory())
      packageFailure("plugin_package_directory_invalid");
    await file.sync();
  } finally {
    await file.close();
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
