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
  extensionRecoveryDirectory,
  putExtensionRecoveryFile,
  readExtensionRecoveryFile,
  type ExtensionRecoveryFilePin,
  type ExtensionRecoveryInputFile,
  type ExtensionRecoverySelection,
} from "@crewon/agent-version/extension-recovery";
import type { AgentVersionDeploymentStore } from "@crewon/application";
import {
  parseExtensionHostActor,
  type ExtensionHostActor,
} from "@crewon/contracts";
import {
  extensionCanonicalJson,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import {
  loadExtensionReleaseInput,
  type ExtensionReleaseInput,
} from "./extension-release-input.ts";
import {
  loadRuntimeExtensionSnapshot,
  runtimeExtensionTarget,
} from "./extension-runtime-config.ts";
import { comfyToolDefinitions } from "./comfyui-tool-catalog.ts";

export type ExtensionRecoveryInputEligibility =
  | Readonly<{ outcome: "eligible" }>
  | Readonly<{ outcome: "unsupported"; reasonCode: string }>;
/** Raw bytes remain private; this token cannot be forged or changed across storage awaits. */
export type InspectedExtensionRecoveryInputs = Readonly<{
  eligibility: ExtensionRecoveryInputEligibility;
  originalInputIdentityDigest: string;
}>;
export type PreparedExtensionRecoveryInputs = Readonly<{
  outcome: "prepared";
  extension: ExtensionReleaseInput;
  files: readonly ExtensionRecoveryFilePin[];
  targets: readonly ExtensionExecutionTarget[];
  runtimeBindingsPath: string;
  agentVersionAssetsPath: string;
  originalInputIdentityDigest: string;
}>;
export type UnsupportedExtensionRecoveryInputs = Readonly<{
  outcome: "unsupported";
  reasonCode: string;
  extension: ExtensionReleaseInput;
  runtimeBindingsPath: string;
  agentVersionAssetsPath: string;
  originalInputIdentityDigest: string;
}>;
type SourceFile = Readonly<{ path: string; bytes: Buffer; maximum: number }>;
type InspectionSnapshot = Readonly<{
  extension: ExtensionReleaseInput;
  runtimeBindingsPath: string;
  agentVersionAssetsPath: string;
  owner: ExtensionHostActor;
  defaultAgentVersionId: string;
  bindings: SourceFile;
  assets: SourceFile;
  snapshots: readonly SourceFile[];
}>;
const inspections = new WeakMap<
  InspectedExtensionRecoveryInputs,
  InspectionSnapshot
>();

/** Trusted operator input only. Unsupported recovery never rewrites the current release inputs. */
export function inspectExtensionRecoveryInputs(input: {
  extension: ExtensionReleaseInput;
  runtimeBindingsPath: string;
  agentVersionAssetsPath: string;
  owner: ExtensionHostActor;
  defaultAgentVersionId: string;
  model: Readonly<{
    endpoint: string;
    credentialEnvironment: "CREWON_MODEL_API_KEY" | null;
  }>;
}): InspectedExtensionRecoveryInputs {
  const owner = parseExtensionHostActor(input.owner);
  const runtimeBindingsPath = sourcePath(input.runtimeBindingsPath);
  const agentVersionAssetsPath = sourcePath(input.agentVersionAssetsPath);
  const defaultAgentVersionId = input.defaultAgentVersionId;
  const model = Object.freeze({ ...input.model });
  const bindings = sourceFile(runtimeBindingsPath, 1024 * 1024);
  const assets = sourceFile(agentVersionAssetsPath, 32 * 1024 * 1024);
  const snapshots = input.extension.runtimeBindings.bindings.map((binding) =>
    sourceFile(sourcePath(binding.extensionConfigPath!), 32 * 1024),
  );
  const extension = loadChecked(
    runtimeBindingsPath,
    agentVersionAssetsPath,
    owner.tenantId,
    defaultAgentVersionId,
  );
  if (
    extensionCanonicalJson(extension) !==
    extensionCanonicalJson(input.extension)
  )
    changed();
  const snapshot: InspectionSnapshot = Object.freeze({
    extension,
    runtimeBindingsPath,
    agentVersionAssetsPath,
    owner,
    defaultAgentVersionId,
    bindings,
    assets,
    snapshots: Object.freeze(snapshots),
  });
  assertSourcesUnchanged(snapshot);
  const originalInputIdentityDigest = hash(
    Buffer.from(
      extensionCanonicalJson({
        schemaVersion: "crewon.extension-recovery-source.v0",
        bindings: hash(bindings.bytes),
        assets: hash(assets.bytes),
        snapshots: snapshots.map((file) => hash(file.bytes)),
      }),
    ),
  );
  const token = Object.freeze({
    eligibility: eligibility(snapshot, model),
    originalInputIdentityDigest,
  });
  assertSourcesUnchanged(snapshot);
  inspections.set(token, snapshot);
  return token;
}

/** Prepare final paths before first publication. Existing durable targets are never relocated. */
export async function prepareExtensionRecoveryInputs(input: {
  inspection: InspectedExtensionRecoveryInputs;
  selection: ExtensionRecoverySelection;
  deployments: Pick<AgentVersionDeploymentStore, "loadAgentVersionDeployment">;
}): Promise<
  PreparedExtensionRecoveryInputs | UnsupportedExtensionRecoveryInputs
> {
  const inspection = input.inspection;
  const source = inspections.get(inspection);
  if (source === undefined)
    throw new Error("extension_recovery_inspection_invalid");
  const selection = copySelection(input.selection);
  const store = input.deployments;
  const unsupported = (
    reasonCode: string,
  ): UnsupportedExtensionRecoveryInputs =>
    Object.freeze({
      outcome: "unsupported",
      reasonCode,
      extension: source.extension,
      runtimeBindingsPath: source.runtimeBindingsPath,
      agentVersionAssetsPath: source.agentVersionAssetsPath,
      originalInputIdentityDigest: inspection.originalInputIdentityDigest,
    });
  assertSourcesUnchanged(source);
  const published = [];
  for (const version of source.extension.versions) {
    const deployment = await store.loadAgentVersionDeployment({
      tenantId: source.owner.tenantId,
      agentVersionId: version.agentVersionId,
    });
    published.push(
      deployment === null ? null : Object.freeze({ ...deployment }),
    );
  }
  assertSourcesUnchanged(source);
  const alreadyPublished = published.some((deployment) => deployment !== null);
  // Current recovery eligibility cannot relocate an already published target.
  // Reuse still requires every saved byte and the complete durable target below.
  if (!alreadyPublished && inspection.eligibility.outcome === "unsupported")
    return unsupported(inspection.eligibility.reasonCode);
  let directory: string;
  try {
    directory = await extensionRecoveryDirectory({
      selection,
      create: !alreadyPublished,
    });
  } catch (error) {
    if (alreadyPublished && hasCode(error, "ENOENT"))
      return unsupported("extension_recovery_published_input_unavailable");
    throw error;
  }
  const runtimeBindingsPath = join(directory, "plugin-bindings.json");
  const agentVersionAssetsPath = join(directory, "plugin-assets.json");
  const rewritten = {
    ...source.extension.runtimeBindings,
    bindings: source.extension.runtimeBindings.bindings.map(
      (binding, index) => ({
        ...binding,
        extensionConfigPath: join(directory, snapshotName(index)),
      }),
    ),
  };
  const files: readonly Readonly<{
    file: ExtensionRecoveryInputFile;
    bytes: Buffer;
  }>[] = [
    ...source.snapshots.map((file, index) => ({
      file: snapshotName(index),
      bytes: file.bytes,
    })),
    { file: "plugin-assets.json", bytes: source.assets.bytes },
    {
      file: "plugin-bindings.json",
      bytes: Buffer.from(`${JSON.stringify(rewritten)}\n`),
    },
  ];
  const pins: ExtensionRecoveryFilePin[] = [];
  if (alreadyPublished) {
    // A complete prepared input set can survive a crash between release and the final manifest.
    // It is not promoted to a historically recoverable capsule here, and no missing file is added.
    for (const file of files) {
      try {
        const bytes = await readExtensionRecoveryFile({
          selection,
          file: file.file,
        });
        if (!bytes.equals(file.bytes))
          return unsupported("extension_recovery_published_input_mismatch");
        pins.push(Object.freeze({ file: file.file, digest: hash(bytes) }));
      } catch (error) {
        if (hasCode(error, "ENOENT"))
          return unsupported("extension_recovery_published_input_unavailable");
        throw error;
      }
    }
  } else {
    for (const file of files)
      pins.push(
        await putExtensionRecoveryFile({
          selection,
          file: file.file,
          bytes: file.bytes,
        }),
      );
  }
  assertSourcesUnchanged(source);
  const extension = loadChecked(
    runtimeBindingsPath,
    agentVersionAssetsPath,
    source.owner.tenantId,
    source.defaultAgentVersionId,
  );
  const targets = extension.runtimeBindings.bindings.map((binding, index) => {
    const version = extension.versions.find(
      (version) => version.agentVersionId === binding.agentVersionId,
    )!;
    return Object.freeze(
      runtimeExtensionTarget({
        snapshot: loadRuntimeExtensionSnapshot(binding.extensionConfigPath!),
        version,
        binding,
        materializationDigest:
          extension.deployments[index]!.materializationDigest,
      }),
    );
  });
  for (const [index, version] of source.extension.versions.entries()) {
    const actual = published[index];
    if (actual === null) continue;
    const target = targets.find(
      (target) => target.agentVersionId === version.agentVersionId,
    )!;
    // The source-derived asset digest pins generation/policy as well as the model and tools.
    const durableTarget: ExtensionExecutionTarget = {
      executionAuthority: "crewonKernel",
      agentVersionId: actual.agentVersionId,
      agentVersionContentDigest: actual.contentDigest,
      materializationDigest: actual.materializationDigest,
      authorityId: actual.authorityId,
      workspaceBindingId: actual.workspaceBindingId,
      runtimeGeneration: version.runtimeGeneration,
      policySnapshotId: version.policySnapshotId,
    };
    if (
      actual.schemaVersion !== "crewon.agent-version-deployment.v0" ||
      actual.tenantId !== source.owner.tenantId ||
      extensionCanonicalJson(target) !== extensionCanonicalJson(durableTarget)
    )
      return unsupported("extension_recovery_published_target_mismatch");
  }
  for (const pin of pins)
    await readExtensionRecoveryFile({
      selection,
      file: pin.file,
      expectedDigest: pin.digest,
    });
  assertSourcesUnchanged(source);
  return Object.freeze({
    outcome: "prepared",
    extension,
    files: Object.freeze(pins),
    targets: Object.freeze(targets),
    runtimeBindingsPath,
    agentVersionAssetsPath,
    originalInputIdentityDigest: inspection.originalInputIdentityDigest,
  });
}

function eligibility(
  source: InspectionSnapshot,
  model: Readonly<{
    endpoint: string;
    credentialEnvironment: "CREWON_MODEL_API_KEY" | null;
  }>,
): ExtensionRecoveryInputEligibility {
  const unsupported = (reasonCode: string) =>
    Object.freeze({ outcome: "unsupported" as const, reasonCode });
  const selectedEndpoint = safeModelEndpoint(model.endpoint);
  if (
    selectedEndpoint === null ||
    (model.credentialEnvironment !== null &&
      model.credentialEnvironment !== "CREWON_MODEL_API_KEY")
  )
    return unsupported("extension_recovery_model_unsupported");
  const definitions = comfyToolDefinitions().map(extensionCanonicalJson).sort();
  for (const binding of source.extension.runtimeBindings.bindings) {
    if (
      binding.provider.kind !== "directResponses" ||
      safeModelEndpoint(binding.provider.endpoint) !== selectedEndpoint ||
      binding.provider.apiKeyEnvironment !== model.credentialEnvironment
    )
      return unsupported("extension_recovery_provider_mismatch");
    if (
      binding.workspaceBindingId !== null ||
      binding.mcpStdioConfigPath !== null ||
      binding.deviceToolConfigPath !== null ||
      binding.remoteMcpConfigPath !== null
    )
      return unsupported("extension_recovery_resources_unsupported");
    const version = source.extension.versions.find(
      (version) => version.agentVersionId === binding.agentVersionId,
    )!;
    if (
      version.resources.workspaceRequired ||
      version.resources.governedContextDigest !== null ||
      extensionCanonicalJson(
        version.tools.map(extensionCanonicalJson).sort(),
      ) !== extensionCanonicalJson(definitions)
    )
      return unsupported("extension_recovery_resources_unsupported");
    const configuration = loadRuntimeExtensionSnapshot(
      binding.extensionConfigPath!,
    ).configuration;
    if (
      configuration.tenantId !== source.owner.tenantId ||
      configuration.spaceId !== source.owner.spaceId ||
      configuration.createdByActorId !== source.owner.actorId
    )
      return unsupported("extension_recovery_owner_mismatch");
  }
  return Object.freeze({ outcome: "eligible" });
}
function loadChecked(
  bindingsPath: string,
  assetsPath: string,
  tenantId: string,
  defaultAgentVersionId: string,
): ExtensionReleaseInput {
  const extension = loadExtensionReleaseInput({
    environment: {
      CREWON_EXTENSIONS_ENABLED: "1",
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: bindingsPath,
      CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: assetsPath,
    },
    tenantId,
    defaultAgentVersionId,
  });
  if (extension === null) throw new Error("extension_recovery_input_invalid");
  return extension;
}
function assertSourcesUnchanged(source: InspectionSnapshot) {
  for (const file of [source.bindings, source.assets, ...source.snapshots])
    if (!file.bytes.equals(readSource(file.path, file.maximum))) changed();
}
function sourceFile(path: string, maximum: number): SourceFile {
  return Object.freeze({ path, maximum, bytes: readSource(path, maximum) });
}
function sourcePath(input: string): string {
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
function readSource(path: string, maximum: number): Buffer {
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
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        used,
        bytes.length - used,
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
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    return bytes.subarray(0, used);
  } finally {
    closeSync(descriptor);
  }
}
function safeModelEndpoint(input: string): string | null {
  try {
    if (
      typeof input !== "string" ||
      input.trim() !== input ||
      Buffer.byteLength(input) > 2048 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
    )
      return null;
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
      return null;
    return url.href;
  } catch {
    return null;
  }
}
function snapshotName(index: number): ExtensionRecoveryInputFile {
  return `snapshot-${String(index).padStart(2, "0")}.json`;
}
function copySelection(
  input: ExtensionRecoverySelection,
): ExtensionRecoverySelection {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 2
  )
    throw new Error("extension_recovery_selection_invalid");
  const root = Object.getOwnPropertyDescriptor(input, "dataRoot");
  const id = Object.getOwnPropertyDescriptor(input, "capsuleId");
  if (
    !root?.enumerable ||
    !("value" in root) ||
    !id?.enumerable ||
    !("value" in id) ||
    typeof id.value !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(id.value)
  )
    throw new Error("extension_recovery_selection_invalid");
  return Object.freeze({
    dataRoot: sourcePath(root.value),
    capsuleId: id.value,
  });
}
function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function changed(): never {
  throw new Error("extension_recovery_input_changed");
}
