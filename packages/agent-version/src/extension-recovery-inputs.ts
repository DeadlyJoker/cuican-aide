import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  parseExtensionHostActor,
  type ExtensionHostActor,
} from "@crewon/contracts";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  readExtensionRecoveryFile,
  resolveExtensionRecoveryCapsule,
  type ExtensionRecoverySelection,
} from "./extension-recovery.ts";
import { parseRuntimeBindingConfig } from "./runtime-binding-schema.ts";

export { inspectInstalledExtensionRuntimeBuild } from "./extension-build-archive.ts";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_BINDINGS = 1024 * 1024,
  MAX_ASSETS = 32 * 1024 * 1024,
  MAX_SNAPSHOT = 32 * 1024;

/** The original Worker raw-byte recipe. It is input identity, not publication authority. */
export function extensionRecoveryOriginalInputIdentity(
  input: Readonly<{
    bindings: Uint8Array;
    assets: Uint8Array;
    snapshots: readonly Uint8Array[];
  }>,
): string {
  const value = record(input, ["bindings", "assets", "snapshots"]);
  const bindings = bytes(value.bindings, MAX_BINDINGS),
    assets = bytes(value.assets, MAX_ASSETS);
  if (
    !Array.isArray(value.snapshots) ||
    value.snapshots.length < 1 ||
    value.snapshots.length > 32 ||
    Object.keys(value.snapshots).length !== value.snapshots.length
  )
    invalid();
  const snapshots = value.snapshots.map((value: unknown) =>
    bytes(value, MAX_SNAPSHOT),
  );
  return hash(
    Buffer.from(
      extensionCanonicalJson({
        schemaVersion: "crewon.extension-recovery-source.v0",
        bindings: hash(bindings),
        assets: hash(assets),
        snapshots: snapshots.map(hash),
      }),
    ),
  );
}

/** The existing release selection recipe, shared without choosing a model or executing code. */
export function deriveExtensionRecoveryCapsuleId(
  input: Readonly<{
    implementationDigest: string;
    buildIdentityDigest: string;
    owner: ExtensionHostActor;
    originalInputIdentityDigest: string;
  }>,
): string {
  const value = record(input, [
    "implementationDigest",
    "buildIdentityDigest",
    "owner",
    "originalInputIdentityDigest",
  ]);
  return hash(
    Buffer.from(
      extensionCanonicalJson({
        schemaVersion: "crewon.extension-recovery-selection.v0",
        implementationDigest: digest(value.implementationDigest),
        buildIdentityDigest: digest(value.buildIdentityDigest),
        owner: parseExtensionHostActor(value.owner),
        originalInputIdentityDigest: digest(value.originalInputIdentityDigest),
      }),
    ),
  );
}

/** Compatibility reader used by Worker inspection and Native input matching. No writes. */
export function readExtensionRecoverySourceFile(
  path: string,
  maximum: number,
): Buffer {
  extensionRecoverySourcePath(path);
  if (!Number.isSafeInteger(maximum) || maximum < 2 || maximum > MAX_ASSETS)
    invalid();
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const segment of absolute
    .slice(current.length)
    .split(sep)
    .filter(Boolean)
    .slice(0, -1)) {
    current = join(current, segment);
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("extension_recovery_source_path_invalid");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 2 || before.size > maximum)
      throw new Error("extension_recovery_source_size_invalid");
    const buffer = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(descriptor);
    if (
      used !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      changed();
    new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
    return buffer.subarray(0, used);
  } finally {
    closeSync(descriptor);
  }
}
export function extensionRecoverySourcePath(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    input !== input.trim() ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    throw new Error("extension_recovery_source_path_invalid");
  return input;
}

/**
 * Matches only a committed capsule's complete original or exact frozen plugin inputs.
 * It grants no registration, deployment, provider, executable-path or Run authority.
 */
export async function matchExtensionRecoveryOriginalInputs(
  input: Readonly<{
    selection: ExtensionRecoverySelection;
    runtimeBindingsPath: string;
    agentVersionAssetsPath: string;
  }>,
): Promise<
  Readonly<{ matches: boolean; inputKind: "original" | "prepared" | null }>
> {
  const value = record(input, [
    "selection",
    "runtimeBindingsPath",
    "agentVersionAssetsPath",
  ]);
  const selected = record(value.selection, ["dataRoot", "capsuleId"]);
  const selection = Object.freeze({
    dataRoot: extensionRecoverySourcePath(selected.dataRoot),
    capsuleId: digest(selected.capsuleId),
  });
  const runtimeBindingsPath = extensionRecoverySourcePath(
      value.runtimeBindingsPath,
    ),
    agentVersionAssetsPath = extensionRecoverySourcePath(
      value.agentVersionAssetsPath,
    );
  // Capture and strictly project the entire current input set before the first await.
  const bindingBytes = readExtensionRecoverySourceFile(
      runtimeBindingsPath,
      MAX_BINDINGS,
    ),
    assetBytes = readExtensionRecoverySourceFile(
      agentVersionAssetsPath,
      MAX_ASSETS,
    );
  const bindings = parseRuntimeBindingConfig(
    JSON.parse(bindingBytes.toString("utf8")),
  );
  if (
    bindings.bindings.length < 1 ||
    bindings.bindings.length > 32 ||
    bindings.bindings.some(
      (binding) => binding.extensionConfigPath === undefined,
    )
  )
    invalid();
  const snapshots = bindings.bindings.map((binding) => ({
    path: extensionRecoverySourcePath(binding.extensionConfigPath),
    bytes: readExtensionRecoverySourceFile(
      binding.extensionConfigPath!,
      MAX_SNAPSHOT,
    ),
  }));
  const assertUnchanged = () => {
    if (
      !bindingBytes.equals(
        readExtensionRecoverySourceFile(runtimeBindingsPath, MAX_BINDINGS),
      ) ||
      !assetBytes.equals(
        readExtensionRecoverySourceFile(agentVersionAssetsPath, MAX_ASSETS),
      ) ||
      snapshots.some(
        (file) =>
          !file.bytes.equals(
            readExtensionRecoverySourceFile(file.path, MAX_SNAPSHOT),
          ),
      )
    )
      changed();
  };
  assertUnchanged();
  const capsule = await resolveExtensionRecoveryCapsule(selection);
  const frozenBindingsPath = join(capsule.directory, "plugin-bindings.json"),
    frozenAssetsPath = join(capsule.directory, "plugin-assets.json");
  const preparedBindings = runtimeBindingsPath === frozenBindingsPath,
    preparedAssets = agentVersionAssetsPath === frozenAssetsPath;
  const noMatch = () => Object.freeze({ matches: false, inputKind: null });
  if (preparedBindings !== preparedAssets) {
    assertUnchanged();
    return noMatch();
  }
  if (
    !preparedBindings &&
    deriveExtensionRecoveryCapsuleId({
      implementationDigest: capsule.manifest.implementationDigest,
      buildIdentityDigest: capsule.manifest.buildIdentityDigest,
      owner: capsule.manifest.owner,
      originalInputIdentityDigest: extensionRecoveryOriginalInputIdentity({
        bindings: bindingBytes,
        assets: assetBytes,
        snapshots: snapshots.map((file) => file.bytes),
      }),
    }) !== selection.capsuleId
  ) {
    assertUnchanged();
    return noMatch();
  }
  const frozenBindings = parseRuntimeBindingConfig(
    JSON.parse(
      (
        await readExtensionRecoveryFile({
          selection,
          file: "plugin-bindings.json",
        })
      ).toString("utf8"),
    ),
  );
  if (
    !assetBytes.equals(
      await readExtensionRecoveryFile({
        selection,
        file: "plugin-assets.json",
      }),
    )
  ) {
    assertUnchanged();
    return noMatch();
  }
  const projected = {
    ...bindings,
    bindings: bindings.bindings.map((binding, index) => ({
      ...binding,
      extensionConfigPath: join(
        capsule.directory,
        `snapshot-${String(index).padStart(2, "0")}.json`,
      ),
    })),
  };
  if (JSON.stringify(projected) !== JSON.stringify(frozenBindings)) {
    assertUnchanged();
    return noMatch();
  }
  const snapshotPins = capsule.manifest.files.filter((pin) =>
    pin.file.startsWith("snapshot-"),
  );
  if (snapshotPins.length !== snapshots.length) {
    assertUnchanged();
    return noMatch();
  }
  for (const [index, file] of snapshots.entries()) {
    const name = `snapshot-${String(index).padStart(2, "0")}.json` as const;
    if (
      !snapshotPins.some((pin) => pin.file === name) ||
      !file.bytes.equals(
        await readExtensionRecoveryFile({ selection, file: name }),
      )
    ) {
      assertUnchanged();
      return noMatch();
    }
    if (preparedBindings && file.path !== join(capsule.directory, name)) {
      assertUnchanged();
      return noMatch();
    }
  }
  const checked = await resolveExtensionRecoveryCapsule(selection);
  if (
    extensionCanonicalJson(checked.manifest) !==
    extensionCanonicalJson(capsule.manifest)
  )
    changed();
  assertUnchanged();
  return Object.freeze({
    matches: true,
    inputKind: preparedBindings ? "prepared" : "original",
  });
}

function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function bytes(input: unknown, maximum: number): Buffer {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength < 2 ||
    input.byteLength > maximum
  )
    invalid();
  return Buffer.from(input);
}
function digest(input: unknown): string {
  if (typeof input !== "string" || !DIGEST.test(input)) invalid();
  return input;
}
function hash(input: Uint8Array): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
function changed(): never {
  throw new Error("extension_recovery_input_changed");
}
function invalid(): never {
  throw new Error("extension_recovery_source_identity_invalid");
}
