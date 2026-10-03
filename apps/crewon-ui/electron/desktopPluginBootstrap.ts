import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  parseExtensionHostActor,
  parsePluginControlAssetPath,
  parsePluginSourceView,
  type ExtensionHostActor,
} from "@crewon/contracts";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";

export const DESKTOP_PLUGIN_APPROVAL_FILE = "plugin-approvals.json";
export const DESKTOP_PLUGIN_APPROVAL_SCHEMA =
  "crewon.desktop-plugin-approval.v1";
export const DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA =
  "crewon.desktop-plugin-bootstrap.v1";
const PROFILE_FILE = "plugin-profile.json";
const PROFILE_SCHEMA = "crewon.desktop-plugin-profile.v1";
const MAX_BYTES = 128 * 1024;

type Source = Readonly<{
  sourceId: string;
  directory: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
}>;
type Publication = Readonly<{
  pluginId: string;
  publisherId: string;
  packageDigest: string;
  publicAssets: readonly string[];
}>;
export type DesktopPluginBootstrapManifest = Readonly<{
  schemaVersion: typeof DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA;
  actor: ExtensionHostActor;
  scope: PluginProfileScope;
  authorityEpoch: string;
  installRoot: string;
  sources: readonly Source[];
  publications: readonly Publication[];
}>;
export type DesktopPluginBootstrap = Readonly<{
  bootstrapPath: string;
  environment: Readonly<{ CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH: string }>;
  scope: PluginProfileScope;
  authorityEpoch: string;
  /** Invoke only after the Control process that consumed this file has stopped. */
  cleanup(): Promise<void>;
}>;
type FileSnapshot = Readonly<{ bytes: Buffer; metadata: Stats }>;

/** Host-owned opt-in only. No package scan, implicit install, activation or business grant. */
export async function prepareDesktopPluginBootstrap(
  input: Readonly<{
    dataDirectory: string;
    actor: ExtensionHostActor;
    /** Existing Native session token + generation; used only as hash input, never persisted. */
    sessionEntropy: string;
  }>,
): Promise<DesktopPluginBootstrap | null> {
  const value = record(input, ["dataDirectory", "actor", "sessionEntropy"]);
  const dataDirectory = absolutePath(value.dataDirectory);
  const actor = parseExtensionHostActor(value.actor);
  if (JSON.stringify(actor) !== JSON.stringify(DESKTOP_RUNTIME_OWNER))
    invalid("actor");
  const entropy = value.sessionEntropy;
  if (typeof entropy !== "string" || !/^[\x21-\x7e]{32,8192}$/u.test(entropy))
    invalid("session");
  const approvalPath = join(dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE);
  // The absent fixed opt-in is the sole read. In particular, do not create/inspect a profile or install root.
  try {
    lstatSync(approvalPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  privateDirectory(dataDirectory, false);
  const approval = privateFile(approvalPath, MAX_BYTES);
  const settings = parseApproval(json(approval.bytes));
  const profilePath = join(dataDirectory, PROFILE_FILE);
  let profile: FileSnapshot;
  try {
    profile = privateFile(profilePath, 16 * 1024);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    const scope = parsePluginProfileScope({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: randomUUID(),
    });
    writeExclusive(
      profilePath,
      Buffer.from(
        JSON.stringify({ schemaVersion: PROFILE_SCHEMA, actor, scope }),
      ),
    );
    profile = privateFile(profilePath, 16 * 1024);
  }
  const persisted = record(json(profile.bytes), [
    "schemaVersion",
    "actor",
    "scope",
  ]);
  const owner = parseExtensionHostActor(persisted.actor);
  const scope = parsePluginProfileScope(persisted.scope);
  if (
    persisted.schemaVersion !== PROFILE_SCHEMA ||
    JSON.stringify(owner) !== JSON.stringify(actor) ||
    scope.tenantId !== actor.tenantId ||
    scope.spaceId !== actor.spaceId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      scope.profileId,
    )
  )
    invalid("profile");
  const installRoot = join(dataDirectory, "plugins");
  privateDirectory(installRoot, true);
  const authorityEpoch = digest(
    JSON.stringify({
      schemaVersion: "crewon.desktop-plugin-epoch.v1",
      approvalDigest: digest(approval.bytes),
      sessionEntropy: entropy,
    }),
  );
  const manifest: DesktopPluginBootstrapManifest = Object.freeze({
    schemaVersion: DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA,
    actor,
    scope,
    authorityEpoch,
    installRoot,
    sources: settings.sources,
    publications: settings.publications,
  });
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (bytes.byteLength > MAX_BYTES) invalid("size");
  const bootstrapPath = join(
    dataDirectory,
    `plugin-bootstrap-${digest(entropy)}.json`,
  );
  assertUnchanged(approvalPath, approval, MAX_BYTES);
  assertUnchanged(profilePath, profile, 16 * 1024);
  const created = writeExclusive(bootstrapPath, bytes);
  const bootstrap = privateFile(bootstrapPath, MAX_BYTES);
  try {
    assertUnchanged(approvalPath, approval, MAX_BYTES);
    assertUnchanged(profilePath, profile, 16 * 1024);
  } catch (error) {
    // Only our still-exact, unpublished allocation may be removed on failure.
    if (created) {
      assertUnchanged(bootstrapPath, bootstrap, MAX_BYTES);
      unlinkSync(bootstrapPath);
    }
    throw error;
  }
  let cleaned = false;
  return Object.freeze({
    bootstrapPath,
    environment: Object.freeze({
      CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH: bootstrapPath,
    }),
    scope,
    authorityEpoch,
    async cleanup() {
      if (cleaned) return;
      try {
        assertUnchanged(bootstrapPath, bootstrap, MAX_BYTES);
        unlinkSync(bootstrapPath);
        cleaned = true;
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          cleaned = true;
          return;
        }
        throw error;
      }
    },
  });
}

function parseApproval(input: unknown) {
  const value = record(input, ["schemaVersion", "sources", "publications"]);
  if (value.schemaVersion !== DESKTOP_PLUGIN_APPROVAL_SCHEMA)
    invalid("approval");
  const ids = new Set<string>(),
    directories = new Set<string>(),
    digests = new Set<string>(),
    versions = new Set<string>();
  const publishers = new Map<string, string>();
  const sources = dense(value.sources, 32).map((raw): Source => {
    const source = record(raw, [
      "sourceId",
      "directory",
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
    ]);
    const checked = parsePluginSourceView({
      sourceId: source.sourceId,
      pluginId: source.pluginId,
      publisherId: source.publisherId,
      version: source.version,
      packageDigest: source.packageDigest,
      title: "Approved source",
      description: "Native host approval",
    });
    const directory = absolutePath(source.directory);
    const version = `${checked.pluginId}@${checked.version}`;
    if (
      ids.has(checked.sourceId) ||
      directories.has(directory) ||
      digests.has(checked.packageDigest) ||
      versions.has(version) ||
      (publishers.has(checked.pluginId) &&
        publishers.get(checked.pluginId) !== checked.publisherId)
    )
      invalid("approval");
    ids.add(checked.sourceId);
    directories.add(directory);
    digests.add(checked.packageDigest);
    versions.add(version);
    publishers.set(checked.pluginId, checked.publisherId);
    return Object.freeze({
      sourceId: checked.sourceId,
      directory,
      pluginId: checked.pluginId,
      publisherId: checked.publisherId,
      version: checked.version,
      packageDigest: checked.packageDigest,
    });
  });
  const approved = new Set<string>();
  const publications = dense(value.publications, 32).map((raw): Publication => {
    const publication = record(raw, [
      "pluginId",
      "publisherId",
      "packageDigest",
      "publicAssets",
    ]);
    const checked = parsePluginSourceView({
      sourceId: "publication",
      pluginId: publication.pluginId,
      publisherId: publication.publisherId,
      packageDigest: publication.packageDigest,
      version: "0.0.0",
      title: "Publication",
      description: "Native host approval",
    });
    const publicAssets = dense(publication.publicAssets, 256).map(
      parsePluginControlAssetPath,
    );
    if (
      !publicAssets.length ||
      new Set(publicAssets).size !== publicAssets.length ||
      approved.has(checked.packageDigest) ||
      !sources.some(
        (source) =>
          source.pluginId === checked.pluginId &&
          source.publisherId === checked.publisherId &&
          source.packageDigest === checked.packageDigest,
      )
    )
      invalid("approval");
    approved.add(checked.packageDigest);
    return Object.freeze({
      pluginId: checked.pluginId,
      publisherId: checked.publisherId,
      packageDigest: checked.packageDigest,
      publicAssets: Object.freeze(publicAssets),
    });
  });
  return Object.freeze({
    sources: Object.freeze(sources),
    publications: Object.freeze(publications),
  });
}

function privateFile(path: string, maximum: number): FileSnapshot {
  const ancestors = directoryPins(dirname(path));
  const before = lstatSync(path);
  const uid = process.getuid?.();
  if (uid === undefined) invalid("platform");
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== uid ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 1 ||
    before.size > maximum
  )
    invalid("file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameStat(before, opened)) invalid("changed");
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
    const bytes = storage.subarray(0, count);
    if (
      bytes.byteLength > maximum ||
      bytes.byteLength !== before.size ||
      !sameStat(opened, fstatSync(fd)) ||
      !sameStat(before, lstatSync(path))
    )
      invalid("changed");
    assertDirectories(ancestors);
    return Object.freeze({ bytes, metadata: before });
  } finally {
    closeSync(fd);
  }
}
function writeExclusive(path: string, bytes: Buffer): boolean {
  if (bytes.byteLength > MAX_BYTES) invalid("size");
  const ancestors = directoryPins(dirname(path));
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    if (!privateFile(path, MAX_BYTES).bytes.equals(bytes)) invalid("changed");
    return false;
  }
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    assertDirectories(ancestors);
  } finally {
    closeSync(fd);
  }
  return true;
}
function privateDirectory(path: string, create: boolean): void {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (!create || !hasCode(error, "ENOENT")) throw error;
    directoryPins(dirname(path));
    mkdirSync(path, { mode: 0o700 });
    metadata = lstatSync(path);
  }
  const uid = process.getuid?.();
  if (uid === undefined) invalid("platform");
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o777) !== 0o700
  )
    invalid("directory");
  directoryPins(path);
}
function directoryPins(
  path: string,
): readonly Readonly<{ path: string; metadata: Stats }>[] {
  const result: { path: string; metadata: Stats }[] = [];
  for (let current = path; ; current = dirname(current)) {
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      invalid("directory");
    result.push({ path: current, metadata });
    if (dirname(current) === current) return result;
  }
}
function assertDirectories(pins: ReturnType<typeof directoryPins>): void {
  for (const pin of pins) {
    const actual = lstatSync(pin.path);
    if (
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      actual.dev !== pin.metadata.dev ||
      actual.ino !== pin.metadata.ino
    )
      invalid("changed");
  }
}
function assertUnchanged(
  path: string,
  expected: FileSnapshot,
  maximum: number,
): void {
  const actual = privateFile(path, maximum);
  if (
    !sameStat(actual.metadata, expected.metadata) ||
    !actual.bytes.equals(expected.bytes)
  )
    invalid("changed");
}
function sameStat(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    invalid("shape");
  return Object.fromEntries(
    keys.map((key) => {
      const value = Object.getOwnPropertyDescriptor(input, key);
      if (!value || !Object.hasOwn(value, "value") || !value.enumerable)
        invalid("shape");
      return [key, value.value];
    }),
  );
}
function dense(input: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > maximum ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid("shape");
  return Array.from({ length: input.length }, (_, index) => {
    const value = Object.getOwnPropertyDescriptor(input, String(index));
    if (!value || !Object.hasOwn(value, "value") || !value.enumerable)
      invalid("shape");
    return value.value;
  });
}
function absolutePath(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input.trim() !== input ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(input)
  )
    invalid("path");
  return input;
}
function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid("json");
  }
}
function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function invalid(reason: string): never {
  throw new Error(`desktop_plugin_bootstrap_${reason}_invalid`);
}
