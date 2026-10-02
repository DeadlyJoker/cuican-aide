import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { packageFailure } from "./local-plugin-package-types.ts";

export type DirectoryPin = Readonly<{
  path: string;
  stats: BigIntStats;
}>;

export function hostPath(input: string): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 4096 ||
    input.includes("\0") ||
    !isAbsolute(input)
  )
    packageFailure("plugin_package_directory_invalid");
  return resolve(input);
}

export async function pinDirectory(input: string): Promise<DirectoryPin> {
  const path = hostPath(input);
  const initial = await lstat(path, { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink())
    packageFailure("plugin_package_directory_invalid");
  const canonical = await realpath(path);
  const stats = await lstat(canonical, { bigint: true });
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !sameIdentity(initial, stats)
  )
    packageFailure("plugin_package_source_changed");
  return Object.freeze({ path: canonical, stats });
}

export async function assertDirectoryPins(
  pins: readonly DirectoryPin[],
  checkChanges = true,
): Promise<void> {
  for (const pin of pins) {
    const current = await lstat(pin.path, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameIdentity(current, pin.stats) ||
      (checkChanges && !sameModification(current, pin.stats))
    )
      packageFailure("plugin_package_source_changed");
  }
}

export function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameModification(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}

/** Pin the regular inode before reading; no-follow and non-blocking reject link/FIFO races. */
export async function readPackageFile(input: {
  path: string;
  maximumBytes: number;
  expectedBytes?: number;
  parents: readonly DirectoryPin[];
  signal?: AbortSignal;
}): Promise<Buffer> {
  input.signal?.throwIfAborted();
  const initial = await lstat(input.path, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n)
    packageFailure("plugin_package_file_type_invalid");
  if (initial.size > BigInt(input.maximumBytes))
    packageFailure("plugin_package_file_limit");
  if (
    input.expectedBytes !== undefined &&
    initial.size !== BigInt(input.expectedBytes)
  )
    packageFailure("plugin_package_file_size_mismatch");
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0)
    packageFailure("plugin_package_nofollow_unavailable");
  await assertDirectoryPins(input.parents);
  let file: FileHandle | undefined;
  try {
    file = await open(
      input.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameIdentity(initial, before) ||
      !sameModification(initial, before)
    )
      packageFailure("plugin_package_source_changed");
    await assertDirectoryPins(input.parents);
    const content = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < content.byteLength) {
      input.signal?.throwIfAborted();
      const read = await file.read(
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (read.bytesRead === 0) packageFailure("plugin_package_source_changed");
      offset += read.bytesRead;
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, content.byteLength);
    const after = await file.stat({ bigint: true });
    const current = await lstat(input.path, { bigint: true });
    if (
      extra.bytesRead !== 0 ||
      !sameIdentity(before, current) ||
      !sameModification(before, after) ||
      !sameModification(before, current) ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n
    )
      packageFailure("plugin_package_source_changed");
    await assertDirectoryPins(input.parents);
    input.signal?.throwIfAborted();
    return content;
  } finally {
    await file?.close();
  }
}
