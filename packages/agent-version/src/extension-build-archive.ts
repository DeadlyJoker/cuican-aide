import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import type {
  ExtensionBuildIdentity,
  ExtensionHistoricalWorkItemScope,
} from "./extension-build.ts";

const IDENTITY_FILE = "extension-build-identity.json";
const ARCHIVE_DIRECTORY = "extension-builds";
const MAX_BUILDS = 64;
const MAX_BUNDLES = 64;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_BUILD_BYTES = 128 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 64 * 1024;
const MAX_SOURCE_ENTRIES = 256;
const MAX_ARCHIVE_ENTRIES = MAX_BUILDS * 3 + 1;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const BUNDLE = /^[a-z][a-z0-9-]*\.mjs$/u;
const BUILD_DIRECTORY = /^([a-f0-9]{64})-([a-f0-9]{64})$/u;
const TEMP_DIRECTORY = /^\.tmp-[a-f0-9]{64}-[A-Za-z0-9]{6}$/u;
const PUBLISH_LOCK = /^\.[a-f0-9]{64}\.publish-lock$/u;
const ALLOCATION_LOCK = ".allocation-lock";
const LOCK_WAIT_MS = 5_000;

export type RetainedExtensionBuild = Readonly<{
  implementationDigest: string;
  buildIdentityDigest: string;
  /** Older scope markers remain immutable; only v1 attests prepared-target isolation. */
  historicalWorkItemScope: ExtensionHistoricalWorkItemScope | null;
  directory: string;
  identityPath: string;
  bundles: readonly Readonly<{ file: string; path: string; digest: string }>[];
}>;

type BuildSnapshot = Readonly<{
  identity: ExtensionBuildIdentity;
  identityBytes: Buffer;
  artifactDigest: string;
  files: ReadonlyMap<string, Buffer>;
}>;
type FileIdentity = Readonly<{ dev: number; ino: number }>;
type Lock = Readonly<{ release(): Promise<void> }>;

/**
 * Explicit native-host operation: inputs must come from the trusted installed
 * runtime directory and native data root, never an HTTP request or plugin config.
 * Only the sidecar and its complete local .mjs collection are retained. No config,
 * credential file or unlisted asset is copied or executed.
 *
 * Files are prepared and verified in a private temporary directory, then linked
 * without replacement. The sidecar is linked last as the atomic complete marker.
 * No executable paths are returned before that marker and a full verification.
 * Storage integrity does not authorize a publisher or replace current execution
 * permissions. Both filesystem roots are fixed by trusted native composition.
 * A hard crash can leave a partial directory or lock; those remain unavailable
 * or busy and are never automatically promoted, removed or garbage-collected.
 */
export async function retainExtensionBuild(
  input: Readonly<{
    dataRoot: string;
    currentBuildDirectory: string;
    expectedImplementationDigest: string;
  }>,
): Promise<RetainedExtensionBuild> {
  const { dataRoot, currentBuildDirectory, expectedImplementationDigest } =
    input;
  assertDigest(expectedImplementationDigest);
  assertPath(dataRoot);
  assertPath(currentBuildDirectory);
  await assertDirectory(currentBuildDirectory);
  const source = await readBuild(
    currentBuildDirectory,
    expectedImplementationDigest,
    "source",
  );
  const root = await archiveRoot(dataRoot, true);
  const existing = await findBuild(root, expectedImplementationDigest);
  if (existing !== null) {
    try {
      return await verifyExisting(existing, source);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "extension_retained_build_incomplete"
      )
        throw error;
      // Only an active/crashed publication lock explains an incomplete candidate.
      // Without it, this is an unknown partial directory and must stay untouched.
      try {
        await lstat(
          join(root, `.${hex(expectedImplementationDigest)}.publish-lock`),
        );
      } catch (lockError) {
        if (hasCode(lockError, "ENOENT")) throw error;
        throw lockError;
      }
    }
  }

  const lease = await acquireLock(
    join(root, `.${hex(expectedImplementationDigest)}.publish-lock`),
  );
  let temporary: string | null = null;
  let destination: string | null = null;
  let destinationIdentity: FileIdentity | null = null;
  let committed = false;
  let failure: unknown;
  try {
    const found = await findBuild(root, expectedImplementationDigest);
    if (found !== null) return await verifyExisting(found, source);
    const allocation = await acquireLock(join(root, ALLOCATION_LOCK));
    try {
      const inventory = await readArchiveInventory(root);
      if (inventory.builds.length >= MAX_BUILDS)
        fail("extension_build_archive_capacity_exceeded");
      destination = join(
        root,
        `${hex(source.identity.implementationDigest)}-${hex(source.artifactDigest)}`,
      );
      // mkdir is exclusive; a pre-existing partial directory is never replaced.
      await mkdir(destination, { mode: 0o700 });
      destinationIdentity = await fileIdentity(destination);
      temporary = await mkdtemp(
        join(root, `.tmp-${hex(source.identity.implementationDigest)}-`),
      );
    } finally {
      await allocation.release();
    }
    for (const [file, bytes] of source.files)
      await writeImmutableFile(join(temporary, file), bytes);
    await writeImmutableFile(
      join(temporary, IDENTITY_FILE),
      source.identityBytes,
    );
    const prepared = await readBuild(
      temporary,
      expectedImplementationDigest,
      "retained",
    );
    assertSameBuild(source, prepared);
    const unchanged = await readBuild(
      currentBuildDirectory,
      expectedImplementationDigest,
      "source",
    );
    if (
      unchanged.artifactDigest !== source.artifactDigest ||
      hash(unchanged.identityBytes) !== hash(source.identityBytes)
    )
      fail("extension_build_archive_source_changed");
    await assertDirectory(destination);
    for (const { file } of source.identity.bundles)
      await link(join(temporary, file), join(destination, file));
    // link is atomic and fails if any target already exists, including a symlink.
    await link(
      join(temporary, IDENTITY_FILE),
      join(destination, IDENTITY_FILE),
    );
    committed = true;
    return await resolveRetainedExtensionBuild({
      dataRoot,
      implementationDigest: expectedImplementationDigest,
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanups: unknown[] = [];
    if (temporary !== null) {
      try {
        await rm(temporary, { recursive: true, force: true });
      } catch (error) {
        cleanups.push(error);
      }
    }
    if (!committed && destination !== null && destinationIdentity !== null) {
      try {
        await removeOwnedPartial(destination, destinationIdentity);
      } catch (error) {
        cleanups.push(error);
      }
    }
    try {
      await lease.release();
    } catch (error) {
      cleanups.push(error);
    }
    if (cleanups.length > 0)
      throw new AggregateError(
        failure === undefined ? cleanups : [failure, ...cleanups],
        "extension_build_archive_cleanup_failed",
      );
  }
}

/** Resolve a retained implementation only after rechecking every artifact byte. */
export async function resolveRetainedExtensionBuild(
  input: Readonly<{
    dataRoot: string;
    implementationDigest: string;
    expectedBuildIdentityDigest?: string;
  }>,
): Promise<RetainedExtensionBuild> {
  const { dataRoot, implementationDigest, expectedBuildIdentityDigest } = input;
  assertDigest(implementationDigest);
  assertPath(dataRoot);
  if (
    expectedBuildIdentityDigest !== undefined &&
    (typeof expectedBuildIdentityDigest !== "string" ||
      !DIGEST.test(expectedBuildIdentityDigest))
  )
    fail("extension_retained_build_mismatch");
  const root = await archiveRoot(dataRoot, false);
  const directory = await findBuild(root, implementationDigest);
  if (directory === null) fail("extension_retained_build_not_found");
  const snapshot = await readBuild(directory, implementationDigest, "retained");
  if (
    expectedBuildIdentityDigest !== undefined &&
    snapshot.artifactDigest !== expectedBuildIdentityDigest
  )
    fail("extension_retained_build_mismatch");
  return projection(directory, snapshot);
}

/** Inspects only the exact installed seven-entry collection; never retains or executes it. */
export async function inspectInstalledExtensionRuntimeBuild(
  input: Readonly<{ directory: string }>,
): Promise<
  Readonly<{ implementationDigest: string; buildIdentityDigest: string }>
> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 1
  )
    fail("extension_installed_build_input_invalid");
  const value = Object.getOwnPropertyDescriptor(input, "directory");
  if (!value?.enumerable || !("value" in value))
    fail("extension_installed_build_input_invalid");
  const directory = value.value as string;
  assertPath(directory);
  const first = await readBuild(directory, undefined, "installed");
  const expected = [
    "control-api.mjs",
    "device-gateway.mjs",
    "local-workspace-checks-mcp.mjs",
    "provider-model-catalog.mjs",
    "provider-settings-coordinator.mjs",
    "runtime-release.mjs",
    "runtime-worker.mjs",
  ];
  if (
    first.identity.schemaVersion !== "crewon.extension-build-identity.v1" ||
    first.identity.historicalWorkItemScope !==
      "crewon.extension-work-item-scope.v1" ||
    first.identity.bundles.map(({ file }) => file).join() !== expected.join()
  )
    fail("extension_installed_build_identity_invalid");
  // Re-read the complete pins after collection inspection, including ancestor checks.
  const checked = await readBuild(
    directory,
    first.identity.implementationDigest,
    "installed",
  );
  if (
    checked.artifactDigest !== first.artifactDigest ||
    !checked.identityBytes.equals(first.identityBytes)
  )
    fail("extension_build_archive_source_changed");
  await assertDirectory(directory);
  return Object.freeze({
    implementationDigest: first.identity.implementationDigest,
    buildIdentityDigest: first.artifactDigest,
  });
}

async function verifyExisting(
  directory: string,
  source: BuildSnapshot,
): Promise<RetainedExtensionBuild> {
  const existing = await readBuild(
    directory,
    source.identity.implementationDigest,
    "retained",
  );
  assertSameBuild(source, existing);
  return projection(directory, existing);
}
function projection(
  directory: string,
  snapshot: BuildSnapshot,
): RetainedExtensionBuild {
  return Object.freeze({
    implementationDigest: snapshot.identity.implementationDigest,
    buildIdentityDigest: snapshot.artifactDigest,
    historicalWorkItemScope:
      snapshot.identity.schemaVersion === "crewon.extension-build-identity.v1"
        ? snapshot.identity.historicalWorkItemScope
        : null,
    directory,
    identityPath: join(directory, IDENTITY_FILE),
    bundles: Object.freeze(
      snapshot.identity.bundles.map(({ file, digest }) =>
        Object.freeze({ file, path: join(directory, file), digest }),
      ),
    ),
  });
}
function assertSameBuild(expected: BuildSnapshot, actual: BuildSnapshot): void {
  if (expected.artifactDigest !== actual.artifactDigest)
    fail("extension_retained_build_mismatch");
}

async function readBuild(
  directory: string,
  expected: string | undefined,
  mode: "source" | "retained" | "installed",
): Promise<BuildSnapshot> {
  await assertDirectory(directory);
  let identityBytes: Buffer;
  try {
    identityBytes = await readFileBounded(
      join(directory, IDENTITY_FILE),
      MAX_IDENTITY_BYTES,
      mode === "installed",
    );
  } catch (error) {
    if (hasCode(error, "ENOENT")) fail("extension_retained_build_incomplete");
    throw error;
  }
  const identity = parseIdentity(identityBytes, expected);
  const artifactDigest = hash(JSON.stringify(identity));
  if (mode === "retained") {
    const address = BUILD_DIRECTORY.exec(parse(directory).base);
    if (
      address !== null &&
      (address[1] !== hex(identity.implementationDigest) ||
        address[2] !== hex(artifactDigest))
    )
      fail("extension_retained_build_mismatch");
  }
  const names = new Set(identity.bundles.map(({ file }) => file));
  const directoryHandle = await opendir(directory);
  let count = 0;
  const seen = new Set<string>();
  for await (const entry of directoryHandle) {
    if (++count > (mode === "source" ? MAX_SOURCE_ENTRIES : MAX_BUNDLES + 1))
      fail("extension_build_archive_limit_exceeded");
    if (entry.isSymbolicLink()) fail("extension_build_archive_path_invalid");
    if (entry.name === IDENTITY_FILE) {
      if (!entry.isFile()) fail("extension_build_archive_identity_invalid");
      continue;
    }
    if (mode === "source" && !entry.name.endsWith(".mjs")) continue;
    if (!entry.isFile() || !names.has(entry.name))
      fail("extension_retained_build_incomplete");
    seen.add(entry.name);
  }
  if (seen.size !== names.size) fail("extension_retained_build_incomplete");
  const files = new Map<string, Buffer>();
  let totalBytes = identityBytes.length;
  for (const { file, digest } of identity.bundles) {
    const bytes = await readFileBounded(
      join(directory, file),
      MAX_BUNDLE_BYTES,
      mode === "installed",
    );
    totalBytes += bytes.length;
    if (totalBytes > MAX_BUILD_BYTES)
      fail("extension_build_archive_limit_exceeded");
    if (hash(bytes) !== digest) fail("extension_retained_build_mismatch");
    files.set(file, bytes);
  }
  // Detect replacement or rewritten metadata while the collection was read.
  if (
    hash(
      await readFileBounded(
        join(directory, IDENTITY_FILE),
        MAX_IDENTITY_BYTES,
        mode === "installed",
      ),
    ) !== hash(identityBytes)
  )
    fail("extension_build_archive_source_changed");
  return { identity, identityBytes, artifactDigest, files };
}

function parseIdentity(
  bytes: Buffer,
  expected: string | undefined,
): ExtensionBuildIdentity {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    fail("extension_build_archive_identity_invalid");
  }
  if (
    !(
      (record(value, ["schemaVersion", "implementationDigest", "bundles"]) &&
        value.schemaVersion === "crewon.extension-build-identity.v0") ||
      (record(value, [
        "schemaVersion",
        "implementationDigest",
        "bundles",
        "historicalWorkItemScope",
      ]) &&
        value.schemaVersion === "crewon.extension-build-identity.v1" &&
        supportedHistoricalScope(value.historicalWorkItemScope))
    ) ||
    typeof value.implementationDigest !== "string" ||
    !DIGEST.test(value.implementationDigest) ||
    !Array.isArray(value.bundles) ||
    value.bundles.length < 1 ||
    value.bundles.length > MAX_BUNDLES
  )
    fail("extension_build_archive_identity_invalid");
  if (expected !== undefined && value.implementationDigest !== expected)
    fail("extension_build_archive_implementation_mismatch");
  const names = new Set<string>();
  const bundles = value.bundles
    .map((bundle: unknown) => {
      if (
        !record(bundle, ["file", "digest"]) ||
        typeof bundle.file !== "string" ||
        !BUNDLE.test(bundle.file) ||
        typeof bundle.digest !== "string" ||
        !DIGEST.test(bundle.digest) ||
        names.has(bundle.file)
      )
        fail("extension_build_archive_identity_invalid");
      names.add(bundle.file);
      return Object.freeze({ file: bundle.file, digest: bundle.digest });
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const common = {
    implementationDigest: value.implementationDigest,
    bundles: Object.freeze(bundles),
  };
  if (value.schemaVersion === "crewon.extension-build-identity.v1") {
    const scope = value.historicalWorkItemScope;
    if (!supportedHistoricalScope(scope))
      fail("extension_build_archive_identity_invalid");
    return Object.freeze({
      schemaVersion: "crewon.extension-build-identity.v1",
      ...common,
      historicalWorkItemScope: scope,
    });
  }
  return Object.freeze({
    schemaVersion: "crewon.extension-build-identity.v0",
    ...common,
  });
}

function supportedHistoricalScope(
  value: unknown,
): value is ExtensionHistoricalWorkItemScope {
  return (
    value === "crewon.extension-work-item-scope.v0" ||
    value === "crewon.extension-work-item-scope.v1"
  );
}

async function archiveRoot(dataRoot: string, create: boolean): Promise<string> {
  await assertDirectory(dataRoot);
  const root = join(dataRoot, ARCHIVE_DIRECTORY);
  if (create) {
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  try {
    await assertDirectory(root);
  } catch (error) {
    if (hasCode(error, "ENOENT")) fail("extension_retained_build_not_found");
    throw error;
  }
  return root;
}
async function findBuild(
  root: string,
  implementationDigest: string,
): Promise<string | null> {
  const inventory = await readArchiveInventory(root);
  const candidates = inventory.builds.filter((name) =>
    name.startsWith(`${hex(implementationDigest)}-`),
  );
  if (candidates.length > 1) fail("extension_retained_build_mismatch");
  return candidates.length === 0 ? null : join(root, candidates[0]!);
}
async function readArchiveInventory(
  root: string,
): Promise<Readonly<{ builds: readonly string[] }>> {
  await assertDirectory(root);
  const directory = await opendir(root);
  let count = 0;
  let temporaryCount = 0;
  let publicationCount = 0;
  const builds: string[] = [];
  for await (const entry of directory) {
    if (++count > MAX_ARCHIVE_ENTRIES)
      fail("extension_build_archive_limit_exceeded");
    if (entry.isSymbolicLink()) fail("extension_build_archive_path_invalid");
    if (BUILD_DIRECTORY.test(entry.name) && entry.isDirectory())
      builds.push(entry.name);
    else if (TEMP_DIRECTORY.test(entry.name) && entry.isDirectory()) {
      if (++temporaryCount > MAX_BUILDS)
        fail("extension_build_archive_limit_exceeded");
    } else if (
      (entry.name === ALLOCATION_LOCK || PUBLISH_LOCK.test(entry.name)) &&
      entry.isFile()
    ) {
      if (entry.name !== ALLOCATION_LOCK && ++publicationCount > MAX_BUILDS)
        fail("extension_build_archive_limit_exceeded");
    } else fail("extension_build_archive_path_invalid");
  }
  if (builds.length > MAX_BUILDS)
    fail("extension_build_archive_capacity_exceeded");
  return { builds };
}

async function assertDirectory(path: string): Promise<void> {
  assertPath(path);
  const root = parse(path).root;
  let current = root;
  for (const segment of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("extension_build_archive_path_invalid");
  }
}
function assertPath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length > 4_096 ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    /[\u0000-\u001f\u007f]/u.test(path)
  )
    fail("extension_build_archive_path_invalid");
}
async function readFileBounded(
  path: string,
  maximum: number,
  rejectHardLinks = false,
): Promise<Buffer> {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (rejectHardLinks && before.nlink !== 1)
  )
    fail("extension_build_archive_path_invalid");
  if (before.size > maximum) fail("extension_build_archive_limit_exceeded");
  const descriptor = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await descriptor.stat();
    if (
      !opened.isFile() ||
      (rejectHardLinks && opened.nlink !== 1) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      fail("extension_build_archive_source_changed");
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await descriptor.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await descriptor.stat();
    const named = await lstat(path);
    if (
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      (rejectHardLinks && (after.nlink !== 1 || named.nlink !== 1)) ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      fail("extension_build_archive_source_changed");
    return buffer.subarray(0, length);
  } finally {
    await descriptor.close();
  }
}
async function writeImmutableFile(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, "wx", 0o400);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function acquireLock(path: string): Promise<Lock> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    let file: FileHandle;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await lstat(path).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return null;
        throw error;
      });
      if (
        existing !== null &&
        (!existing.isFile() || existing.isSymbolicLink() || existing.size > 64)
      )
        fail("extension_build_archive_path_invalid");
      if (Date.now() >= deadline) fail("extension_build_archive_publish_busy");
      await new Promise((accept) => setTimeout(accept, 20));
      continue;
    }
    const identity = await file.stat();
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await file.close();
        const current = await lstat(path);
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino
        )
          fail("extension_build_archive_lock_changed");
        await unlink(path);
      },
    };
  }
}
async function removeOwnedPartial(
  path: string,
  identity: FileIdentity,
): Promise<void> {
  const current = await lstat(path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  )
    fail("extension_build_archive_path_invalid");
  try {
    await lstat(join(path, IDENTITY_FILE));
    fail("extension_build_archive_unknown_marker");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  await rm(path, { recursive: true });
}
async function fileIdentity(path: string): Promise<FileIdentity> {
  const stat = await lstat(path);
  return { dev: stat.dev, ino: stat.ino };
}
function record(
  input: unknown,
  keys: readonly string[],
): input is Record<string, unknown> {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).sort().join() === [...keys].sort().join()
  );
}
function assertDigest(value: string): void {
  if (typeof value !== "string" || !DIGEST.test(value))
    fail("extension_build_archive_implementation_mismatch");
}
function hex(value: string): string {
  return value.slice("sha256:".length);
}
function hash(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
