import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export {
  retainExtensionBuild,
  resolveRetainedExtensionBuild,
  type RetainedExtensionBuild,
} from "./extension-build-archive.ts";

declare const __CREWON_COMFY_IMPLEMENTATION_DIGEST__: string | undefined;

export const EXTENSION_BUILD_IDENTITY_FILE = "extension-build-identity.json";
const MAX_FILES = 4_096;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 64 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MODULE_PATH = fileURLToPath(import.meta.url);
const BUNDLED_DIGEST =
  typeof __CREWON_COMFY_IMPLEMENTATION_DIGEST__ === "undefined"
    ? null
    : __CREWON_COMFY_IMPLEMENTATION_DIGEST__;
const LOADED_SOURCE_DIGEST =
  BUNDLED_DIGEST === null && MODULE_PATH.endsWith(".ts")
    ? readComfySourceFingerprint(resolve(dirname(MODULE_PATH), "../../.."))
    : null;
const LOADED_BUNDLE_DIGEST =
  BUNDLED_DIGEST === null
    ? null
    : digest(readBoundedFile(MODULE_PATH, MAX_BUNDLE_BYTES));

export const EXTENSION_HISTORICAL_WORK_ITEM_SCOPE =
  "crewon.extension-work-item-scope.v0";

export type ExtensionBuildIdentity = Readonly<{
  implementationDigest: string;
  bundles: readonly Readonly<{ file: string; digest: string }>[];
}> &
  (
    | Readonly<{ schemaVersion: "crewon.extension-build-identity.v0" }>
    | Readonly<{
        schemaVersion: "crewon.extension-build-identity.v1";
        historicalWorkItemScope: typeof EXTENSION_HISTORICAL_WORK_ITEM_SCOPE;
      }>
  );

/**
 * This Node-only entrypoint is shared by Control, Worker and release compilation.
 * Source runs read actual production bytes each time. Staged bundles use the common
 * source fingerprint injected by the existing build and verify their own artifact.
 * The broad dependency closure deliberately fails closed after unrelated host edits.
 */
export function getComfyImplementationDigest(): string {
  if (BUNDLED_DIGEST !== null) {
    if (!DIGEST.test(BUNDLED_DIGEST)) fail("extension_build_identity_invalid");
    verifyBundleIdentity(MODULE_PATH, BUNDLED_DIGEST);
    return BUNDLED_DIGEST;
  }
  if (LOADED_SOURCE_DIGEST === null)
    fail("extension_build_identity_unavailable");
  if (
    readComfySourceFingerprint(resolve(dirname(MODULE_PATH), "../../..")) !==
    LOADED_SOURCE_DIGEST
  )
    fail("extension_source_changed_since_load");
  return LOADED_SOURCE_DIGEST;
}

/** A saved configuration must never be materialized with changed host code. */
export function assertComfyImplementationDigest(expected: string): void {
  if (!DIGEST.test(expected)) fail("extension_implementation_mismatch");
  if (getComfyImplementationDigest() !== expected)
    fail("extension_implementation_mismatch");
}

/** Build/test input only; product callers use the parameterless verified accessor. */
export function readComfySourceFingerprint(repositoryRoot: string): string {
  const root = resolve(repositoryRoot);
  const sources = new Map<string, Buffer>();
  let totalBytes = 0;
  const add = (path: string, maximumBytes = MAX_FILE_BYTES) => {
    const name = relative(root, path).split(sep).join("/");
    if (!name || name.startsWith("../") || sources.has(name))
      fail("extension_source_identity_invalid");
    const bytes = readBoundedFile(path, maximumBytes);
    totalBytes += bytes.length;
    if (sources.size >= MAX_FILES || totalBytes > MAX_SOURCE_BYTES)
      fail("extension_source_identity_limit");
    sources.set(name, bytes);
  };
  const walk = (directory: string) => {
    if (!lstatSync(directory).isDirectory())
      fail("extension_source_identity_invalid");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("extension_source_identity_invalid");
      if (entry.isDirectory()) {
        if (entry.name !== "fixtures") walk(path);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !/\.test(?:-support)?\.ts$/u.test(entry.name)
      ) {
        add(path);
      }
    }
  };
  const packages = new Set<string>();
  const visit = (directory: string, expectedName: string) => {
    if (packages.has(expectedName)) return;
    packages.add(expectedName);
    const path = join(directory, "package.json");
    add(path, MAX_IDENTITY_BYTES);
    const pkg: unknown = JSON.parse(
      sources.get(relative(root, path).split(sep).join("/"))!.toString("utf8"),
    );
    if (!isRecord(pkg) || pkg.name !== expectedName)
      fail("extension_source_identity_invalid");
    walk(join(directory, "src"));
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      const dependencies = pkg[field];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies)) fail("extension_source_identity_invalid");
      for (const [name, version] of Object.entries(dependencies)) {
        if (typeof version !== "string")
          fail("extension_source_identity_invalid");
        if (!version.startsWith("workspace:")) continue;
        if (!/^@crewon\/[a-z][a-z0-9-]*$/u.test(name))
          fail("extension_source_identity_invalid");
        visit(join(root, "packages", name.slice("@crewon/".length)), name);
      }
    }
  };
  visit(join(root, "apps", "runtime-worker"), "@crewon/runtime-worker");
  add(join(root, "pnpm-lock.yaml"));
  add(join(root, ".node-version"), 256);
  add(join(root, "scripts", "stage-desktop-runtime.ts"));
  const files = [...sources.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, bytes]) => ({ file, digest: digest(bytes) }));
  return digest(
    JSON.stringify({ schemaVersion: "crewon.comfy-source-identity.v0", files }),
  );
}

export function createExtensionBuildIdentity(
  implementationDigest: string,
  bundlePaths: readonly string[],
): ExtensionBuildIdentity {
  if (!DIGEST.test(implementationDigest) || bundlePaths.length > 64)
    fail("extension_build_identity_invalid");
  const bundles = bundlePaths.map((path) => ({
    file: basename(path),
    digest: digest(readBoundedFile(path, MAX_BUNDLE_BYTES)),
  }));
  if (new Set(bundles.map(({ file }) => file)).size !== bundles.length)
    fail("extension_build_identity_invalid");
  return {
    schemaVersion: "crewon.extension-build-identity.v0",
    implementationDigest,
    bundles: bundles.sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
    ),
  };
}

/** Build producer only: this marker asserts the staged Worker supports scoped historical claims. */
export function createScopedExtensionBuildIdentity(input: {
  implementationDigest: string;
  bundlePaths: readonly string[];
}): ExtensionBuildIdentity {
  const identity = createExtensionBuildIdentity(
    input.implementationDigest,
    input.bundlePaths,
  );
  return {
    ...identity,
    schemaVersion: "crewon.extension-build-identity.v1",
    historicalWorkItemScope: EXTENSION_HISTORICAL_WORK_ITEM_SCOPE,
  };
}

function verifyBundleIdentity(modulePath: string, expected: string): void {
  const identity: unknown = JSON.parse(
    readBoundedFile(
      join(dirname(modulePath), EXTENSION_BUILD_IDENTITY_FILE),
      MAX_IDENTITY_BYTES,
    ).toString("utf8"),
  );
  const scoped =
    isRecord(identity) &&
    identity.schemaVersion === "crewon.extension-build-identity.v1";
  if (
    !isRecord(identity) ||
    Object.keys(identity).sort().join() !==
      (scoped
        ? "bundles,historicalWorkItemScope,implementationDigest,schemaVersion"
        : "bundles,implementationDigest,schemaVersion") ||
    (!scoped &&
      identity.schemaVersion !== "crewon.extension-build-identity.v0") ||
    (scoped &&
      identity.historicalWorkItemScope !==
        EXTENSION_HISTORICAL_WORK_ITEM_SCOPE) ||
    identity.implementationDigest !== expected ||
    !Array.isArray(identity.bundles) ||
    identity.bundles.length > 64
  )
    fail("extension_build_identity_invalid");
  const files = new Set<string>();
  let ownDigest: string | null = null;
  for (const bundle of identity.bundles) {
    if (
      !isRecord(bundle) ||
      Object.keys(bundle).sort().join() !== "digest,file" ||
      typeof bundle.file !== "string" ||
      !/^[a-z][a-z0-9-]*\.mjs$/u.test(bundle.file) ||
      typeof bundle.digest !== "string" ||
      !DIGEST.test(bundle.digest) ||
      files.has(bundle.file)
    )
      fail("extension_build_identity_invalid");
    files.add(bundle.file);
    if (bundle.file === basename(modulePath)) ownDigest = bundle.digest;
  }
  if (
    ownDigest === null ||
    ownDigest !== LOADED_BUNDLE_DIGEST ||
    ownDigest !== digest(readBoundedFile(modulePath, MAX_BUNDLE_BYTES))
  )
    fail("extension_build_identity_mismatch");
}

function readBoundedFile(path: string, maximumBytes: number): Buffer {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maximumBytes)
      fail("extension_source_identity_invalid");
    const bytes = readFileSync(path);
    if (bytes.length > maximumBytes) fail("extension_source_identity_limit");
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("extension_"))
      throw error;
    fail("extension_build_identity_unavailable");
  }
}
function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(code: string): never {
  throw new Error(code);
}
