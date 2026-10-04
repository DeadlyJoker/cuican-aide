import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  parseDesktopPluginApproval,
} from "./desktopPluginBootstrap.ts";

export const MAX_APPROVAL_BYTES = 128 * 1024;
export const PENDING_SUFFIX = ".import-pending-v1";
export type DirectoryPin = Readonly<{ path: string; metadata: Stats }>;
export type FileSnapshot = Readonly<{ bytes: Buffer; metadata: Stats }>;

/**
 * Cold recovery after Electron obtains its original single-instance lock. Only a
 * proven, already-committed absent-target hardlink is unlinked. An independent
 * pending write is never promoted or deleted, even if its JSON appears valid.
 */
export function recoverDesktopLocalPluginSourceImport(
  input: Readonly<{ dataDirectory: string; ownsSingleInstance: boolean }>,
): Readonly<{ recovered: boolean; retained: boolean }> {
  const value = fields(input, ["dataDirectory", "ownsSingleInstance"]);
  if (value.ownsSingleInstance !== true) invalid("instance_lock_required");
  const dataDirectory = absolutePath(value.dataDirectory);
  const approvalPath = join(dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE);
  const pendingPath = approvalPath + PENDING_SUFFIX;
  try {
    lstatSync(pendingPath);
  } catch (error) {
    if (hasCode(error, "ENOENT"))
      return Object.freeze({ recovered: false, retained: false });
    throw error;
  }
  // Unsafe or uncommitted leftovers do not grant approval or touch human files.
  let pending: FileSnapshot, approval: FileSnapshot;
  let parents: readonly DirectoryPin[];
  try {
    parents = pinParents(dataDirectory);
    assertPrivateDirectory(dataDirectory);
    pending = readPrivateFile(pendingPath, MAX_APPROVAL_BYTES, 2);
    approval = readPrivateFile(approvalPath, MAX_APPROVAL_BYTES, 2);
    if (
      !sameFile(pending.metadata, approval.metadata) ||
      !pending.bytes.equals(approval.bytes)
    )
      invalid("recovery_uncommitted");
    parseDesktopPluginApproval(parseJson(approval.bytes));
    assertParents(parents);
    assertPrivateDirectory(dataDirectory);
    assertFile(pendingPath, pending, MAX_APPROVAL_BYTES, 2);
    assertFile(approvalPath, approval, MAX_APPROVAL_BYTES, 2);
    assertParents(parents);
  } catch {
    return Object.freeze({ recovered: false, retained: true });
  }
  // No asynchronous work or authority promotion between the exact pair checks
  // and removal of this known redundant link. Failure leaves both links intact.
  try {
    unlinkSync(pendingPath);
  } catch {
    return Object.freeze({ recovered: false, retained: true });
  }
  const recovered = readPrivateFile(approvalPath, MAX_APPROVAL_BYTES);
  assertParents(parents);
  if (
    recovered.metadata.dev !== approval.metadata.dev ||
    recovered.metadata.ino !== approval.metadata.ino ||
    recovered.metadata.uid !== approval.metadata.uid ||
    recovered.metadata.mode !== approval.metadata.mode ||
    recovered.metadata.mtimeMs !== approval.metadata.mtimeMs ||
    !recovered.bytes.equals(approval.bytes)
  )
    invalid("recovery_changed");
  return Object.freeze({ recovered: true, retained: false });
}

/** Final synchronous publication; callers must already hold the exact approval CAS. */
export function commitApproval(
  input: Readonly<{
    approvalPath: string;
    pending: Readonly<{ path: string; snapshot: FileSnapshot }>;
    targetAbsent: boolean;
  }>,
): void {
  if (input.targetAbsent) {
    // Link is an exclusive absent-target publication, never an overwrite.
    linkSync(input.pending.path, input.approvalPath);
    try {
      unlinkSync(input.pending.path);
    } catch {
      // Approval has committed. Retain the interrupted fixed staging slot
      // and return its receipt; the original single-link reader fails closed
      // until cleanup succeeds, and Main can report restartRequired.
    }
  } else {
    renameSync(input.pending.path, input.approvalPath);
  }
}

export function pinParents(path: string): readonly DirectoryPin[] {
  const result: DirectoryPin[] = [];
  for (let current = path; ; current = dirname(current)) {
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("parent");
    result.push(Object.freeze({ path: current, metadata }));
    if (dirname(current) === current) return Object.freeze(result);
  }
}

export function assertParents(pins: readonly DirectoryPin[]): void {
  for (const pin of pins) {
    const actual = lstatSync(pin.path);
    if (
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      actual.dev !== pin.metadata.dev ||
      actual.ino !== pin.metadata.ino ||
      actual.uid !== pin.metadata.uid ||
      actual.mode !== pin.metadata.mode
    )
      invalid("parent_changed");
  }
}

export function assertPrivateDirectory(path: string): void {
  const metadata = lstatSync(path);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o777) !== 0o700
  )
    invalid("directory");
}

export function ensurePrivateDirectory(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    mkdirSync(path, { mode: 0o700 });
  }
  assertPrivateDirectory(path);
}

export function readApproval(path: string): FileSnapshot | null {
  try {
    return readPrivateFile(path, MAX_APPROVAL_BYTES);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function readPrivateFile(
  path: string,
  maximum: number,
  expectedLinks: 1 | 2 = 1,
): FileSnapshot {
  const parents = pinParents(dirname(path));
  const before = lstatSync(path);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== expectedLinks ||
    before.uid !== uid ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 1 ||
    before.size > maximum
  )
    invalid("approval_file");
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0)
    invalid("nofollow_unavailable");
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd);
    if (!sameFile(before, opened)) invalid("approval_changed");
    const storage = Buffer.allocUnsafe(maximum + 1);
    let count = 0;
    while (count < storage.byteLength) {
      const read = readSync(
        fd,
        storage,
        count,
        storage.byteLength - count,
        null,
      );
      if (read === 0) break;
      count += read;
    }
    if (
      count !== before.size ||
      count > maximum ||
      !sameFile(opened, fstatSync(fd)) ||
      !sameFile(before, lstatSync(path))
    )
      invalid("approval_changed");
    assertParents(parents);
    return Object.freeze({
      bytes: Buffer.from(storage.subarray(0, count)),
      metadata: before,
    });
  } finally {
    closeSync(fd);
  }
}

export function assertApproval(
  path: string,
  expected: FileSnapshot | null,
): void {
  const actual = readApproval(path);
  if (expected === null) {
    if (actual !== null) invalid("approval_changed");
    return;
  }
  if (
    actual === null ||
    !sameFile(actual.metadata, expected.metadata) ||
    !actual.bytes.equals(expected.bytes)
  )
    invalid("approval_changed");
}

export function assertFile(
  path: string,
  expected: FileSnapshot,
  maximum: number,
  expectedLinks: 1 | 2 = 1,
): void {
  const actual = readPrivateFile(path, maximum, expectedLinks);
  if (
    !sameFile(actual.metadata, expected.metadata) ||
    !actual.bytes.equals(expected.bytes)
  )
    invalid("pending_changed");
}

export function createPending(
  path: string,
  bytes: Buffer,
  parents: readonly DirectoryPin[],
): Readonly<{ path: string; snapshot: FileSnapshot }> {
  assertParents(parents);
  // A fixed exclusive slot bounds crash leftovers and never deletes an earlier writer's file.
  const fd = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  let own: Stats | undefined;
  try {
    own = fstatSync(fd);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    assertParents(parents);
  } catch (error) {
    try {
      if (own !== undefined) {
        const actual = lstatSync(path);
        if (
          actual.isFile() &&
          !actual.isSymbolicLink() &&
          actual.dev === own.dev &&
          actual.ino === own.ino &&
          actual.uid === own.uid &&
          actual.nlink === 1
        )
          unlinkSync(path);
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "desktop_local_plugin_source_import_cleanup_failed",
        { cause: error },
      );
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  return Object.freeze({
    path,
    snapshot: readPrivateFile(path, MAX_APPROVAL_BYTES),
  });
}

export function removePending(
  pending: Readonly<{ path: string; snapshot: FileSnapshot }>,
): void {
  // Only still-exact bytes allocated by this operation may be removed.
  assertFile(pending.path, pending.snapshot, MAX_APPROVAL_BYTES);
  unlinkSync(pending.path);
}

function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
export function fields(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid("shape");
  const keys = Reflect.ownKeys(input);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" || ![...required, ...optional].includes(key),
    ) ||
    required.some((key) => !keys.includes(key))
  )
    invalid("shape");
  return Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        invalid("shape");
      return [key, descriptor.value];
    }),
  );
}
export function absolutePath(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input.trim() !== input ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(input)
  )
    invalid("directory_path");
  return input;
}
export function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid("approval_json");
  }
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
export function invalid(reason: string): never {
  throw new Error(`desktop_local_plugin_source_import_${reason}`);
}
