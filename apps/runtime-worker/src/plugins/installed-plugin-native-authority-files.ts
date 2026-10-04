import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseDesktopNativePluginAuthority,
  DESKTOP_NATIVE_PLUGIN_AUTHORITY_MAX_BYTES,
  type DesktopNativePluginAuthority,
} from "@crewon/contracts/plugins";

export function nativeAuthorityFailure(code: string): never {
  throw new Error(`installed_plugin_native_authority_${code}`);
}
type Pin = Readonly<{ path: string; metadata: Stats }>;
type PrivateFile = Readonly<{
  bytes: Buffer;
  value: unknown;
  assertCurrent(): void;
}>;
function same(a: Stats, b: Stats): boolean {
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
function directories(path: string): readonly Pin[] {
  const pins: Pin[] = [];
  for (let current = path; ; current = dirname(current)) {
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      nativeAuthorityFailure("directory_invalid");
    pins.push({ path: current, metadata });
    if (dirname(current) === current) return pins;
  }
}
function assertDirectories(pins: readonly Pin[]): void {
  for (const pin of pins) {
    const metadata = lstatSync(pin.path);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== pin.metadata.dev ||
      metadata.ino !== pin.metadata.ino ||
      metadata.uid !== pin.metadata.uid ||
      metadata.mode !== pin.metadata.mode
    )
      nativeAuthorityFailure("directory_changed");
  }
}
function read(
  path: string,
  maximum: number,
): Readonly<{ bytes: Buffer; metadata: Stats }> {
  const original = lstatSync(path),
    uid = process.getuid?.();
  if (
    uid === undefined ||
    !original.isFile() ||
    original.isSymbolicLink() ||
    original.nlink !== 1 ||
    original.uid !== uid ||
    (original.mode & 0o777) !== 0o600 ||
    original.size < 1 ||
    original.size > maximum
  )
    nativeAuthorityFailure("file_invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(original, fstatSync(fd))) nativeAuthorityFailure("file_changed");
    const bytes = Buffer.alloc(original.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (
      size !== original.size ||
      !same(original, fstatSync(fd)) ||
      !same(original, lstatSync(path))
    )
      nativeAuthorityFailure("file_changed");
    return { bytes: bytes.subarray(0, size), metadata: original };
  } finally {
    closeSync(fd);
  }
}
export function captureNativeAuthorityFile(
  path: string,
  maximum: number,
): PrivateFile {
  const pins = directories(dirname(path)),
    snapshot = read(path, maximum);
  assertDirectories(pins);
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes),
  );
  return Object.freeze({
    bytes: snapshot.bytes,
    value,
    assertCurrent() {
      assertDirectories(pins);
      const current = read(path, maximum);
      if (
        !same(snapshot.metadata, current.metadata) ||
        !snapshot.bytes.equals(current.bytes)
      )
        nativeAuthorityFailure("file_changed");
      assertDirectories(pins);
    },
  });
}
function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    nativeAuthorityFailure("document_invalid");
  return input as Record<string, unknown>;
}
function withdrawalFence(path: string): () => void {
  let withdrawn = false;
  return () => {
    if (withdrawn) nativeAuthorityFailure("withdrawn");
    try {
      lstatSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    withdrawn = true;
    nativeAuthorityFailure("withdrawn");
  };
}
/** Captures actual Main-issued files. All checks remain live until every borrower closes. */
export function captureNativePluginAuthority(path: string): Readonly<{
  authority: DesktopNativePluginAuthority;
  assertCurrent(): void;
}> {
  const publication = captureNativeAuthorityFile(
      path,
      DESKTOP_NATIVE_PLUGIN_AUTHORITY_MAX_BYTES,
    ),
    authority = parseDesktopNativePluginAuthority(publication.value);
  const dataDirectory = dirname(authority.controlDatabasePath),
    directory = lstatSync(dataDirectory),
    authorityDirectory = dirname(path),
    privateDirectory = lstatSync(authorityDirectory),
    assertUnwithdrawn = withdrawalFence(
      join(authorityDirectory, "withdrawn.json"),
    );
  if (
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o777) !== 0o700 ||
    authority.installRoot !== join(dataDirectory, "plugins") ||
    authority.controlDatabasePath !== join(dataDirectory, "control.sqlite") ||
    authority.approvalPath !== join(dataDirectory, "plugin-approvals.json") ||
    authority.policyPath !== join(dataDirectory, "plugin-native-policy.json") ||
    authority.profilePath !== join(dataDirectory, "plugin-profile.json") ||
    dirname(authority.bootstrapPath) !== dataDirectory ||
    !/^plugin-bootstrap-[a-f0-9]{64}\.json$/u.test(
      authority.bootstrapPath.slice(dataDirectory.length + 1),
    ) ||
    dirname(authorityDirectory) !== dataDirectory ||
    basename(path) !== "authority.json" ||
    !/^\.native-plugin-authority-[a-zA-Z0-9_-]+$/u.test(
      basename(authorityDirectory),
    ) ||
    privateDirectory.uid !== process.getuid?.() ||
    (privateDirectory.mode & 0o777) !== 0o700
  )
    nativeAuthorityFailure("publication_binding_invalid");
  assertUnwithdrawn();
  const bootstrap = captureNativeAuthorityFile(
      authority.bootstrapPath,
      128 * 1024,
    ),
    approval = captureNativeAuthorityFile(authority.approvalPath, 128 * 1024),
    policy = captureNativeAuthorityFile(authority.policyPath, 128 * 1024),
    profile = captureNativeAuthorityFile(authority.profilePath, 16 * 1024);
  if (
    digest(bootstrap.bytes) !== authority.bootstrapDigest ||
    digest(approval.bytes) !== authority.approvalDigest ||
    digest(policy.bytes) !== authority.policyDigest ||
    digest(profile.bytes) !== authority.profileDigest
  )
    nativeAuthorityFailure("publication_digest_mismatch");
  const original = object(bootstrap.value),
    approved = object(approval.value),
    localPolicy = object(policy.value),
    savedProfile = object(profile.value);
  if (
    ![
      "crewon.desktop-plugin-bootstrap.v1",
      "crewon.desktop-plugin-bootstrap.v2",
      "crewon.desktop-plugin-bootstrap.v3",
    ].includes(original.schemaVersion as string) ||
    !isDeepStrictEqual(original.actor, authority.actor) ||
    !isDeepStrictEqual(original.scope, authority.scope) ||
    original.installRoot !== authority.installRoot ||
    savedProfile.schemaVersion !== "crewon.desktop-plugin-profile.v1" ||
    !isDeepStrictEqual(savedProfile.actor, authority.actor) ||
    !isDeepStrictEqual(savedProfile.scope, authority.scope) ||
    ![
      "crewon.desktop-plugin-approval.v1",
      "crewon.desktop-plugin-approval.v2",
      "crewon.desktop-plugin-approval.v3",
    ].includes(approved.schemaVersion as string) ||
    !Array.isArray(original.sources) ||
    !Array.isArray(approved.sources)
  )
    nativeAuthorityFailure("owner_binding_invalid");
  if (
    localPolicy.schemaVersion !== "crewon.desktop-native-plugin-policy.v1" ||
    !Array.isArray(localPolicy.packages) ||
    !isDeepStrictEqual(localPolicy.networkGrants, authority.networkGrants)
  )
    nativeAuthorityFailure("policy_binding_invalid");
  const policyPackages = localPolicy.packages.map((raw) => {
    const row = object(raw);
    return {
      pluginId: row.pluginId,
      publisherId: row.publisherId,
      version: row.version,
      packageDigest: row.packageDigest,
    };
  });
  if (!isDeepStrictEqual(policyPackages, authority.packages))
    nativeAuthorityFailure("policy_binding_invalid");
  for (const pkg of authority.packages) {
    const matches = (source: unknown) => {
      const row = object(source);
      return Object.entries(pkg).every(
        ([field, expected]) => row[field] === expected,
      );
    };
    if (!original.sources.some(matches) || !approved.sources.some(matches))
      nativeAuthorityFailure("package_unapproved");
  }
  const installPins = directories(authority.installRoot),
    database = lstatSync(authority.controlDatabasePath);
  if (
    !database.isFile() ||
    database.isSymbolicLink() ||
    database.nlink !== 1 ||
    database.uid !== process.getuid?.() ||
    (database.mode & 0o022) !== 0
  )
    nativeAuthorityFailure("database_invalid");
  const assertCurrent = () => {
    assertUnwithdrawn();
    publication.assertCurrent();
    bootstrap.assertCurrent();
    approval.assertCurrent();
    policy.assertCurrent();
    profile.assertCurrent();
    assertDirectories(installPins);
    const current = lstatSync(authority.controlDatabasePath);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.uid !== database.uid ||
      current.mode !== database.mode ||
      current.dev !== database.dev ||
      current.ino !== database.ino
    )
      nativeAuthorityFailure("database_changed");
    assertUnwithdrawn();
  };
  assertCurrent();
  return Object.freeze({ authority, assertCurrent });
}
