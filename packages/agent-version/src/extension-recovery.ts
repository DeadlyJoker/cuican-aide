import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  parseExtensionHostActor,
  parseExtensionHostRegistrationIdentity,
  type ExtensionHostActor,
  type ExtensionHostRegistrationIdentity,
} from "@crewon/contracts";
import {
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionExecutionTarget,
  type ExtensionExecutionTarget,
} from "@crewon/domain";

export * from "./extension-recovery-startup.ts";

const SCHEMA = "crewon.extension-recovery-capsule.v0";
const ROOT = "extension-recoveries";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_CAPSULES = 64;
const MAX_CAPSULE_BYTES = 40 * 1024 * 1024;
const MANIFEST_LIMIT = 128 * 1024;
const LOCK_WAIT_MS = 5_000;

export type ExtensionRecoverySelection = Readonly<{
  dataRoot: string;
  capsuleId: string;
}>;
export type ExtensionRecoveryInputFile =
  | "plugin-bindings.json"
  | "plugin-assets.json"
  | "base-bindings.json"
  | "bootstrap.json"
  | "release.json"
  | `snapshot-${string}.json`;
export type ExtensionRecoveryFilePin = Readonly<{
  file: ExtensionRecoveryInputFile;
  digest: string;
}>;
export type ExtensionRecoveryProviderBinding = Readonly<{
  providerId: string;
  endpoint: string;
  responsesEndpoint: string;
  credentialRequired: boolean;
}>;
export type ExtensionRecoveryManifest = Readonly<{
  schemaVersion: typeof SCHEMA;
  capsuleId: string;
  owner: ExtensionHostActor;
  implementationDigest: string;
  buildIdentityDigest: string;
  providerBinding: ExtensionRecoveryProviderBinding;
  releaseId: string;
  registrations: readonly ExtensionHostRegistrationIdentity[];
  targets: readonly ExtensionExecutionTarget[];
  files: readonly ExtensionRecoveryFilePin[];
}>;
export type ResolvedExtensionRecoveryCapsule = Readonly<{
  directory: string;
  manifest: ExtensionRecoveryManifest;
  files: readonly Readonly<ExtensionRecoveryFilePin & { path: string }>[];
}>;

/** Native-owned file identity only. It grants neither publication nor execution authority. */
export async function extensionRecoveryDirectory(
  input: Readonly<{
    selection: ExtensionRecoverySelection;
    create: boolean;
  }>,
): Promise<string> {
  const selection = pinSelection(input.selection);
  const root = join(selection.dataRoot, ROOT);
  await assertDirectory(selection.dataRoot);
  if (input.create) await mkdir(root, { mode: 0o700 }).catch(existing);
  await assertDirectory(root);
  const directory = join(root, selection.capsuleId.slice(7));
  if (!input.create) {
    await assertDirectory(directory);
    return directory;
  }
  try {
    await assertDirectory(directory);
    return directory;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const lock = await allocationLock(root);
  try {
    // The lock serializes the inventory and exclusive allocation across processes.
    const entries = await inventory(root, MAX_CAPSULES + 1);
    const capsules = entries.filter((name) => name !== ".allocation-lock");
    if (capsules.some((name) => !/^[a-f0-9]{64}$/u.test(name)))
      fail("extension_recovery_inventory_invalid");
    if (capsules.includes(selection.capsuleId.slice(7))) {
      await assertDirectory(directory);
      return directory;
    }
    if (capsules.length >= MAX_CAPSULES)
      fail("extension_recovery_capacity_exceeded");
    await mkdir(directory, { mode: 0o700 });
    await assertDirectory(directory);
    return directory;
  } finally {
    await lock();
  }
}

/** Fixed JSON inputs only; a complete marker cannot be supplied through this API. */
export async function putExtensionRecoveryFile(
  input: Readonly<{
    selection: ExtensionRecoverySelection;
    file: ExtensionRecoveryInputFile;
    bytes: Uint8Array;
  }>,
): Promise<ExtensionRecoveryFilePin> {
  const selection = pinSelection(input.selection);
  const file = inputFile(input.file);
  const bytes = Buffer.from(input.bytes);
  if (bytes.length < 2 || bytes.length > fileLimit(file))
    fail("extension_recovery_file_size_invalid");
  decodeJson(bytes);
  const directory = await extensionRecoveryDirectory({
    selection,
    create: true,
  });
  // A complete capsule is immutable. An exact existing input can be reused.
  const digest = hash(bytes);
  const unlock = await mutationLock(directory);
  try {
    await writeImmutable(directory, file, bytes);
  } finally {
    await unlock();
  }
  return Object.freeze({ file, digest });
}

export async function readExtensionRecoveryFile(
  input: Readonly<{
    selection: ExtensionRecoverySelection;
    file: ExtensionRecoveryInputFile;
    expectedDigest?: string;
  }>,
): Promise<Buffer> {
  const selection = pinSelection(input.selection);
  const file = inputFile(input.file);
  const expected = input.expectedDigest;
  if (expected !== undefined) assertDigest(expected);
  const directory = await extensionRecoveryDirectory({
    selection,
    create: false,
  });
  const bytes = await readBounded(join(directory, file), fileLimit(file));
  if (expected !== undefined && hash(bytes) !== expected)
    fail("extension_recovery_file_mismatch");
  return bytes;
}

/** Invoke only after actual release verification and owned Worker readiness. Marker is last. */
export async function commitExtensionRecoveryCapsule(
  input: Readonly<{
    selection: ExtensionRecoverySelection;
    manifest: ExtensionRecoveryManifest;
  }>,
): Promise<ResolvedExtensionRecoveryCapsule> {
  const selection = pinSelection(input.selection);
  const manifest = parseExtensionRecoveryManifest(input.manifest);
  if (manifest.capsuleId !== selection.capsuleId)
    fail("extension_recovery_selection_mismatch");
  const directory = await extensionRecoveryDirectory({
    selection,
    create: false,
  });
  const bytes = Buffer.from(`${extensionCanonicalJson(manifest)}\n`, "utf8");
  if (bytes.length > MANIFEST_LIMIT)
    fail("extension_recovery_manifest_invalid");
  const unlock = await mutationLock(directory);
  try {
    await verifyFiles(directory, manifest, false, true);
    await writeImmutable(directory, "manifest.json", bytes);
  } finally {
    await unlock();
  }
  return resolveExtensionRecoveryCapsule(selection);
}

/** Recheck all saved bytes each time. A partial directory is never promoted or deleted. */
export async function resolveExtensionRecoveryCapsule(
  input: ExtensionRecoverySelection,
): Promise<ResolvedExtensionRecoveryCapsule> {
  const selection = pinSelection(input);
  const directory = await extensionRecoveryDirectory({
    selection,
    create: false,
  });
  const bytes = await readBounded(
    join(directory, "manifest.json"),
    MANIFEST_LIMIT,
  );
  const manifest = parseExtensionRecoveryManifest(decodeJson(bytes));
  if (manifest.capsuleId !== selection.capsuleId)
    fail("extension_recovery_selection_mismatch");
  await verifyFiles(directory, manifest, true);
  const unchanged = await readBounded(
    join(directory, "manifest.json"),
    MANIFEST_LIMIT,
  );
  if (!bytes.equals(unchanged)) fail("extension_recovery_manifest_changed");
  return Object.freeze({
    directory,
    manifest,
    files: Object.freeze(
      manifest.files.map((pin) =>
        Object.freeze({ ...pin, path: join(directory, pin.file) }),
      ),
    ),
  });
}

export function parseExtensionRecoveryManifest(
  input: unknown,
): ExtensionRecoveryManifest {
  const value = record(input, [
    "schemaVersion",
    "capsuleId",
    "owner",
    "implementationDigest",
    "buildIdentityDigest",
    "providerBinding",
    "releaseId",
    "registrations",
    "targets",
    "files",
  ]);
  if (value.schemaVersion !== SCHEMA)
    fail("extension_recovery_manifest_invalid");
  const capsuleId = digestValue(value.capsuleId);
  const owner = parseExtensionHostActor(value.owner);
  const implementationDigest = digestValue(value.implementationDigest);
  const buildIdentityDigest = digestValue(value.buildIdentityDigest);
  const providerBinding = parseExtensionRecoveryProviderBinding(
    value.providerBinding,
  );
  const releaseId = extensionOpaqueId(value.releaseId);
  const registrations = denseArray(value.registrations, 1, 32).map(
    parseExtensionHostRegistrationIdentity,
  );
  const targets = denseArray(value.targets, 1, 32).map(
    parseExtensionExecutionTarget,
  );
  const files = denseArray(value.files, 6, 37).map((entry) => {
    const pin = record(entry, ["file", "digest"]);
    return Object.freeze({
      file: inputFile(pin.file),
      digest: digestValue(pin.digest),
    });
  });
  for (const list of [registrations, targets]) {
    if (
      new Set(list.map((item) => extensionCanonicalJson(item))).size !==
      list.length
    )
      fail("extension_recovery_manifest_invalid");
  }
  const names = new Set(files.map((pin) => pin.file));
  if (
    names.size !== files.length ||
    [
      "plugin-bindings.json",
      "plugin-assets.json",
      "base-bindings.json",
      "bootstrap.json",
      "release.json",
    ].some((file) => !names.has(file as ExtensionRecoveryInputFile)) ||
    !files.some(({ file }) => file.startsWith("snapshot-"))
  )
    fail("extension_recovery_manifest_invalid");
  return Object.freeze({
    schemaVersion: SCHEMA,
    capsuleId,
    owner,
    implementationDigest,
    buildIdentityDigest,
    providerBinding,
    releaseId,
    registrations: Object.freeze(registrations),
    targets: Object.freeze(targets),
    files: Object.freeze(files),
  });
}

export function parseExtensionRecoveryProviderBinding(
  input: unknown,
): ExtensionRecoveryProviderBinding {
  const value = record(input, [
    "providerId",
    "endpoint",
    "responsesEndpoint",
    "credentialRequired",
  ]);
  if (
    typeof value.providerId !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value.providerId) ||
    typeof value.credentialRequired !== "boolean"
  )
    fail("extension_recovery_provider_invalid");
  const providerEndpoint = endpoint(value.endpoint);
  const responsesEndpoint = endpoint(value.responsesEndpoint);
  if (
    responsesEndpoint !==
    new URL(`${providerEndpoint.replace(/\/+$/u, "")}/responses`).toString()
  )
    fail("extension_recovery_provider_invalid");
  return Object.freeze({
    providerId: value.providerId,
    endpoint: providerEndpoint,
    responsesEndpoint,
    credentialRequired: value.credentialRequired,
  });
}

async function verifyFiles(
  directory: string,
  manifest: ExtensionRecoveryManifest,
  complete: boolean,
  ownsMutationLock = false,
) {
  const expected = new Set<string>(manifest.files.map(({ file }) => file));
  if (complete) expected.add("manifest.json");
  if (ownsMutationLock) expected.add(".mutation-lock");
  const names = await inventory(directory, 39);
  if (
    names.some(
      (file) => !expected.has(file) && !(file === "manifest.json" && !complete),
    ) ||
    manifest.files.some(({ file }) => !names.includes(file))
  )
    fail("extension_recovery_inventory_invalid");
  let total = 0;
  for (const pin of manifest.files) {
    const bytes = await readBounded(
      join(directory, pin.file),
      fileLimit(pin.file),
    );
    total += bytes.length;
    if (total > MAX_CAPSULE_BYTES) fail("extension_recovery_size_exceeded");
    if (hash(bytes) !== pin.digest) fail("extension_recovery_file_mismatch");
    // Validate UTF-8/JSON without granting these documents execution semantics.
    decodeJson(bytes);
  }
}

async function writeImmutable(directory: string, file: string, bytes: Buffer) {
  const path = join(directory, file);
  try {
    const existingBytes = await readBounded(
      path,
      file === "manifest.json" ? MANIFEST_LIMIT : fileLimit(inputFile(file)),
    );
    if (!bytes.equals(existingBytes)) fail("extension_recovery_file_mismatch");
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  if (file !== "manifest.json") {
    try {
      await lstat(join(directory, "manifest.json"));
      fail("extension_recovery_capsule_immutable");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  // One fixed pending slot per input prevents repeated crashes accumulating files.
  const temporary = join(directory, `.${file}.pending`);
  const descriptor = await open(temporary, "wx", 0o600);
  let failure: unknown;
  try {
    await descriptor.writeFile(bytes);
    await descriptor.sync();
    await descriptor.close();
    try {
      await link(temporary, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const winner = await readBounded(path, bytes.length);
      if (!winner.equals(bytes)) fail("extension_recovery_file_mismatch");
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await descriptor.close().catch(() => undefined);
    try {
      await unlink(temporary);
    } catch (error) {
      throw new AggregateError(
        failure === undefined ? [error] : [failure, error],
        "extension_recovery_cleanup_failed",
      );
    }
  }
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await descriptor.stat();
    if (!before.isFile() || before.size < 2 || before.size > limit)
      fail("extension_recovery_file_size_invalid");
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await descriptor.read(
        bytes,
        used,
        bytes.length - used,
        null,
      );
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    const after = await descriptor.stat();
    if (
      used !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      fail("extension_recovery_file_changed");
    return bytes.subarray(0, used);
  } finally {
    await descriptor.close();
  }
}

function allocationLock(root: string): Promise<() => Promise<void>> {
  return acquireLock(root, ".allocation-lock");
}
function mutationLock(directory: string): Promise<() => Promise<void>> {
  return acquireLock(directory, ".mutation-lock");
}
async function acquireLock(
  directory: string,
  file: string,
): Promise<() => Promise<void>> {
  const path = join(directory, file);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const descriptor = await open(path, "wx", 0o600);
      const identity = await descriptor.stat();
      return async () => {
        await descriptor.close();
        const current = await lstat(path);
        if (current.dev !== identity.dev || current.ino !== identity.ino)
          fail("extension_recovery_lock_changed");
        await unlink(path);
      };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if (hasCode(error, "ENOENT") && Date.now() < deadline) continue;
        throw error;
      }
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        Date.now() >= deadline
      )
        fail("extension_recovery_busy");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function assertDirectory(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, part);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail("extension_recovery_directory_invalid");
  }
}
async function inventory(path: string, limit: number): Promise<string[]> {
  const directory = await opendir(path);
  const entries: string[] = [];
  try {
    for await (const entry of directory) {
      entries.push(entry.name);
      if (entries.length > limit) fail("extension_recovery_inventory_invalid");
    }
    return entries;
  } finally {
    await directory.close().catch(() => undefined);
  }
}
function pinSelection(input: unknown): ExtensionRecoverySelection {
  const value = record(input, ["dataRoot", "capsuleId"]);
  const dataRoot = value.dataRoot;
  if (
    typeof dataRoot !== "string" ||
    !isAbsolute(dataRoot) ||
    dataRoot.trim() !== dataRoot ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(dataRoot) ||
    Buffer.byteLength(dataRoot) > 4096
  )
    fail("extension_recovery_selection_invalid");
  return Object.freeze({ dataRoot, capsuleId: digestValue(value.capsuleId) });
}
function inputFile(input: unknown): ExtensionRecoveryInputFile {
  if (
    typeof input !== "string" ||
    (![
      "plugin-bindings.json",
      "plugin-assets.json",
      "base-bindings.json",
      "bootstrap.json",
      "release.json",
    ].includes(input) &&
      !/^snapshot-(?:[0-2][0-9]|3[01])\.json$/u.test(input))
  )
    fail("extension_recovery_file_invalid");
  return input as ExtensionRecoveryInputFile;
}
function fileLimit(file: ExtensionRecoveryInputFile): number {
  if (file === "plugin-assets.json") return 32 * 1024 * 1024;
  if (file === "base-bindings.json" || file === "plugin-bindings.json")
    return 1024 * 1024;
  if (file.startsWith("snapshot-")) return 32 * 1024;
  return 256 * 1024;
}
function endpoint(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.trim() !== input ||
    Buffer.byteLength(input) > 2048 ||
    /[\\?#]/u.test(input) ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    fail("extension_recovery_provider_invalid");
  try {
    const url = new URL(input);
    const local =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    )
      throw new Error();
  } catch {
    fail("extension_recovery_provider_invalid");
  }
  const canonical = new URL(input).toString();
  if (Buffer.byteLength(canonical) > 2048)
    fail("extension_recovery_provider_invalid");
  return canonical;
}
function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    fail("extension_recovery_manifest_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some(
      (key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]!),
    )
  )
    fail("extension_recovery_manifest_invalid");
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function denseArray(
  input: unknown,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    input.length < minimum ||
    input.length > maximum ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    fail("extension_recovery_manifest_invalid");
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor))
      fail("extension_recovery_manifest_invalid");
    return descriptor.value;
  });
}
function decodeJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("extension_recovery_json_invalid");
  }
}
function digestValue(input: unknown): string {
  if (typeof input !== "string" || !DIGEST.test(input))
    fail("extension_recovery_digest_invalid");
  return input;
}
function assertDigest(input: string) {
  digestValue(input);
}
function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function existing(error: unknown) {
  if (!hasCode(error, "EEXIST")) throw error;
}
function fail(message: string): never {
  throw new Error(message);
}
