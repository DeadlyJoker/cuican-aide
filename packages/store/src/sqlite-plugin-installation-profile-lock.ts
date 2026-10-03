import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";

type Pin = Readonly<{ path: string; stats: BigIntStats }>;
type DatabaseIdentity = Readonly<{ location: string; file: Pin; parent: Pin }>;
const identities = new WeakMap<DatabaseSync, DatabaseIdentity | null | Error>();
const fences = new WeakMap<
  DatabaseSync,
  { root: Pin | null; files: Map<string, Pin> }
>();

/** Capture the opened host's path identity without changing ordinary SQLite admission. */
export function captureSqliteInstallationDatabase(
  database: DatabaseSync,
): void {
  if (identities.has(database)) return;
  try {
    const location = database.location();
    if (location === null) {
      identities.set(database, null);
      return;
    }
    const canonical = realpathSync(location);
    identities.set(
      database,
      Object.freeze({
        location,
        file: pin(canonical),
        parent: pin(dirname(canonical)),
      }),
    );
  } catch (error) {
    identities.set(
      database,
      new Error("plugin_profile_owner_database_invalid", { cause: error }),
    );
  }
}

export function sqliteInstallationDatabaseKey(
  database: DatabaseSync,
): string | null {
  captureSqliteInstallationDatabase(database);
  const identity = identities.get(database)!;
  if (identity instanceof Error) throw identity;
  if (identity === null) return null;
  assertDatabase(database, identity);
  return identity.file.path;
}

/** An actual, separate SQLite connection owns the OS-backed writer reservation. */
export class SqlitePluginInstallationProfileLock {
  readonly #database: DatabaseSync;
  readonly #host: DatabaseSync;
  readonly #identity: DatabaseIdentity;
  readonly #root: Pin;
  readonly #file: Pin;
  #held = true;

  private constructor(input: {
    database: DatabaseSync;
    host: DatabaseSync;
    identity: DatabaseIdentity;
    root: Pin;
    file: Pin;
  }) {
    this.#database = input.database;
    this.#host = input.host;
    this.#identity = input.identity;
    this.#root = input.root;
    this.#file = input.file;
  }

  static acquire(
    database: DatabaseSync,
    rawScope: PluginProfileScope,
  ): SqlitePluginInstallationProfileLock | null {
    const scope = parsePluginProfileScope(rawScope);
    if (sqliteInstallationDatabaseKey(database) === null) return null;
    const identity = identities.get(database) as DatabaseIdentity;
    const path = identity.file.path + ".plugin-profile-locks";
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const root = pin(path);
    assertPrivateDirectory(root);
    const known = fences.get(database) ?? {
      root: null,
      files: new Map<string, Pin>(),
    };
    fences.set(database, known);
    if (known.root !== null) assertPin(known.root);
    else known.root = root;
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          "crewon.sqlite-plugin-profile-owner.v1",
          identity.file.path,
          scope.tenantId,
          scope.spaceId,
          scope.profileId,
        ]),
      )
      .digest("hex");
    const filePath = join(path, key + ".sqlite");
    try {
      const descriptor = openSync(
        filePath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      closeSync(descriptor);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const file = pin(filePath);
    assertPrivateFile(file);
    const previous = known.files.get(filePath);
    if (previous) assertPin(previous);
    else {
      if (known.files.size >= 256)
        fail("plugin_profile_owner_fence_capacity_exhausted");
      known.files.set(filePath, file);
    }
    assertDatabase(database, identity);
    assertPin(root);
    let connection: DatabaseSync | undefined;
    try {
      connection = new DatabaseSync(filePath, {
        timeout: 0,
        enableForeignKeyConstraints: true,
      });
      if (
        connection.prepare("PRAGMA journal_mode").get()?.journal_mode !==
        "delete"
      )
        fail("plugin_profile_owner_lock_invalid");
      connection.exec("BEGIN IMMEDIATE");
      const lock = new SqlitePluginInstallationProfileLock({
        database: connection,
        host: database,
        identity,
        root,
        file,
      });
      lock.assertHeld();
      return lock;
    } catch (error) {
      connection?.close();
      if (
        hasCode(error, "ERR_SQLITE_ERROR") &&
        (error as { errcode?: unknown }).errcode === 5
      )
        throw new Error("plugin_profile_owner_busy", { cause: error });
      throw error;
    }
  }

  assertHeld(): void {
    if (!this.#held || !this.#database.isOpen || !this.#database.isTransaction)
      fail("plugin_profile_owner_unavailable");
    assertDatabase(this.#host, this.#identity);
    assertPin(this.#root);
    assertPrivateDirectory(this.#root);
    assertPin(this.#file);
    assertPrivateFile(this.#file);
  }

  close(): void {
    if (!this.#held) return;
    // Never unlink the stable fence file: that would permit another inode to bypass its lock.
    if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
    this.#database.close();
    this.#held = false;
  }
}

export function withSqlitePluginInstallationWriter<T>(
  database: DatabaseSync,
  scope: PluginProfileScope,
  operation: () => T,
): T {
  const lock = SqlitePluginInstallationProfileLock.acquire(database, scope);
  try {
    lock?.assertHeld();
    return operation();
  } finally {
    lock?.close();
  }
}

function pin(path: string): Pin {
  return Object.freeze({ path, stats: lstatSync(path, { bigint: true }) });
}
function assertPin(value: Pin): void {
  const actual = lstatSync(value.path, { bigint: true });
  if (
    actual.dev !== value.stats.dev ||
    actual.ino !== value.stats.ino ||
    actual.isSymbolicLink() ||
    actual.uid !== value.stats.uid
  )
    fail("plugin_profile_owner_path_changed");
}
function assertDatabase(
  database: DatabaseSync,
  identity: DatabaseIdentity,
): void {
  if (!database.isOpen) fail("plugin_profile_owner_unavailable");
  if (
    database.location() !== identity.location ||
    realpathSync(identity.location) !== identity.file.path
  )
    fail("plugin_profile_owner_path_changed");
  const original = lstatSync(identity.location, { bigint: true });
  if (original.isSymbolicLink()) fail("plugin_profile_owner_database_invalid");
  assertPin(identity.file);
  assertPin(identity.parent);
  const file = lstatSync(identity.file.path, { bigint: true });
  const parent = lstatSync(identity.parent.path, { bigint: true });
  if (
    !file.isFile() ||
    file.nlink !== 1n ||
    (file.mode & 0o022n) !== 0n ||
    !parent.isDirectory() ||
    (parent.mode & 0o022n) !== 0n ||
    (typeof process.getuid === "function" &&
      (file.uid !== BigInt(process.getuid()) ||
        parent.uid !== BigInt(process.getuid())))
  )
    fail("plugin_profile_owner_database_invalid");
}
function assertPrivateDirectory(value: Pin): void {
  const actual = lstatSync(value.path, { bigint: true });
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    (actual.mode & 0o077n) !== 0n ||
    (typeof process.getuid === "function" &&
      actual.uid !== BigInt(process.getuid()))
  )
    fail("plugin_profile_owner_lock_invalid");
}
function assertPrivateFile(value: Pin): void {
  const actual = lstatSync(value.path, { bigint: true });
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1n ||
    (actual.mode & 0o077n) !== 0n ||
    (typeof process.getuid === "function" &&
      actual.uid !== BigInt(process.getuid()))
  )
    fail("plugin_profile_owner_lock_invalid");
}
function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
function fail(code: string): never {
  throw new Error(code);
}
