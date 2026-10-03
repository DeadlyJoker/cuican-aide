import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_INPUT_BYTES = 128 * 1024;
type Pin = Readonly<{ path: string; stat: Stats; contents: boolean }>;

export function nativePreparationFailure(code: string): never {
  throw new Error(`installed_plugin_native_preparation_${code}`);
}

export function nativePreparationPath(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input.trim() !== input ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    nativePreparationFailure("path_invalid");
  return input;
}

function currentUser(): number {
  if (typeof process.getuid !== "function")
    nativePreparationFailure("platform_unsupported");
  return process.getuid();
}

function unchanged(pin: Pin): boolean {
  const actual = lstatSync(pin.path),
    before = pin.stat;
  return (
    !actual.isSymbolicLink() &&
    actual.dev === before.dev &&
    actual.ino === before.ino &&
    actual.mode === before.mode &&
    actual.uid === before.uid &&
    actual.gid === before.gid &&
    actual.isDirectory() === before.isDirectory() &&
    (actual.isDirectory() || actual.nlink === before.nlink) &&
    (!pin.contents ||
      (actual.size === before.size &&
        actual.mtimeMs === before.mtimeMs &&
        actual.ctimeMs === before.ctimeMs))
  );
}

/** Captures real ancestor inodes and private inputs. SQLite contents may change legitimately. */
export class NativePreparationFiles {
  readonly #pins = new Map<string, Pin>();
  #output: Pin | null = null;

  #ancestors(path: string): void {
    let parent = dirname(path);
    for (;;) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        nativePreparationFailure("ancestor_invalid");
      const prior = this.#pins.get(parent);
      if (prior !== undefined && !unchanged(prior))
        nativePreparationFailure("files_changed");
      if (prior === undefined)
        this.#pins.set(parent, { path: parent, stat, contents: false });
      if (parent === dirname(parent)) break;
      parent = dirname(parent);
    }
    if (realpathSync(path) !== path) nativePreparationFailure("path_invalid");
  }

  privateDirectory(pathInput: string): void {
    const path = nativePreparationPath(pathInput),
      stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== currentUser() ||
      (stat.mode & 0o777) !== 0o700
    )
      nativePreparationFailure("directory_invalid");
    this.#ancestors(path);
    this.#pins.set(path, { path, stat, contents: false });
  }

  database(pathInput: string): void {
    const path = nativePreparationPath(pathInput),
      stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== currentUser() ||
      (stat.mode & 0o022) !== 0
    )
      nativePreparationFailure("database_invalid");
    this.#ancestors(path);
    this.#pins.set(path, { path, stat, contents: false });
  }

  readJson(pathInput: string): unknown {
    const path = nativePreparationPath(pathInput),
      original = lstatSync(path);
    if (!original.isFile() || original.isSymbolicLink())
      nativePreparationFailure("file_invalid");
    this.#ancestors(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== currentUser() ||
        (before.mode & 0o777) !== 0o600 ||
        before.size < 1 ||
        before.size > MAX_INPUT_BYTES ||
        before.dev !== original.dev ||
        before.ino !== original.ino
      )
        nativePreparationFailure("file_invalid");
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, count);
        if (read === 0) break;
        count += read;
      }
      const after = fstatSync(fd),
        pin = { path, stat: before, contents: true };
      if (
        count !== before.size ||
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        !unchanged(pin)
      )
        nativePreparationFailure("files_changed");
      this.#pins.set(path, pin);
      this.assertCurrent();
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, count),
        ),
      );
    } finally {
      closeSync(fd);
    }
  }

  assertCurrent(): void {
    try {
      for (const pin of this.#pins.values())
        if (!unchanged(pin)) nativePreparationFailure("files_changed");
      if (this.#output !== null && !unchanged(this.#output))
        nativePreparationFailure("files_changed");
    } catch {
      nativePreparationFailure("files_changed");
    }
  }

  assertAbsent(path: string): void {
    this.assertCurrent();
    try {
      lstatSync(path);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      throw error;
    }
    nativePreparationFailure("output_exists");
  }

  /** Atomic no-replace publication; the temporary hard link is removed before any reader returns. */
  publish(path: string, contents: string): void {
    this.assertAbsent(path);
    const staging = join(dirname(path), `.release-${randomUUID()}.tmp`);
    let fd: number | null = null,
      staged: Stats | null = null;
    try {
      fd = openSync(
        staging,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      staged = fstatSync(fd);
      const bytes = Buffer.from(contents, "utf8");
      let count = 0;
      while (count < bytes.length) {
        const written = writeSync(fd, bytes, count, bytes.length - count);
        if (written < 1) nativePreparationFailure("output_write_failed");
        count += written;
      }
      fsyncSync(fd);
      this.assertAbsent(path);
      const actual = lstatSync(staging);
      if (
        actual.dev !== staged.dev ||
        actual.ino !== staged.ino ||
        actual.nlink !== 1 ||
        actual.isSymbolicLink()
      )
        nativePreparationFailure("files_changed");
      linkSync(staging, path);
      this.#output = { path, stat: fstatSync(fd), contents: true };
      unlinkSync(staging);
      const stat = fstatSync(fd);
      this.#output = { path, stat, contents: true };
      if (stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
        nativePreparationFailure("file_invalid");
      this.assertCurrent();
    } finally {
      if (fd !== null) closeSync(fd);
      if (staged !== null) {
        try {
          const current = lstatSync(staging);
          if (
            current.dev === staged.dev &&
            current.ino === staged.ino &&
            !current.isSymbolicLink()
          )
            unlinkSync(staging);
        } catch (error) {
          if (
            !(
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            throw error;
        }
      }
    }
  }

  /** A failed preparation may delete only the exact output inode it published. */
  discardOutput(): void {
    const pin = this.#output;
    if (pin === null) return;
    const current = lstatSync(pin.path);
    if (
      current.dev !== pin.stat.dev ||
      current.ino !== pin.stat.ino ||
      current.isSymbolicLink()
    )
      nativePreparationFailure("output_ownership_lost");
    unlinkSync(pin.path);
    this.#output = null;
  }
}
