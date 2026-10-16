import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { RetainedExtensionBuild } from "@crewon/agent-version/extension-build";
import { deriveExtensionRecoveryCapsuleId } from "@crewon/agent-version/extension-recovery-inputs";
import {
  parseExtensionRecoveryManifest,
  parseExtensionRecoveryProviderBinding,
  putExtensionRecoveryFile,
  resolveExtensionRecoveryCapsule,
  writeExtensionRecoveryStartupReport,
  type ExtensionRecoveryManifest,
  type ExtensionRecoveryProviderBinding,
  type ExtensionRecoverySelection,
} from "@crewon/agent-version/extension-recovery";
import type { ActorContext } from "@crewon/application";
import {
  parseExtensionHostActor,
  type ExtensionHostActor,
} from "@crewon/contracts";
import { extensionCanonicalJson } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store/sqlite-run-store";
import {
  compileRuntimeAgentVersion,
  verifyRuntimeAgentVersionRelease,
  type RuntimeAgentVersionReleasePlan,
} from "./agent-version-release.ts";
import {
  captureRuntimeBootstrapInputs,
  replayRuntimeBootstrapInputs,
  type RuntimeBootstrapCaptureResult,
} from "./runtime-bootstrap-inputs.ts";
import type { RuntimeEnvironment } from "./runtime-environment-values.ts";
import { createModelTransport } from "./runtime-process-environment.ts";
import { parseRuntimeBindingConfig } from "./runtime-binding-config.ts";
import {
  inspectExtensionRecoveryInputs,
  prepareExtensionRecoveryInputs,
  type PreparedExtensionRecoveryInputs,
} from "./extensions/extension-recovery-inputs.ts";
import type { ExtensionReleaseInput } from "./extensions/extension-release-input.ts";
import { loadRuntimeExtensionSnapshot } from "./extensions/extension-runtime-config.ts";

export type ExtensionRecoveryReleaseRequest = Readonly<{
  attemptId: string;
  dataRoot: string;
  providerBinding: ExtensionRecoveryProviderBinding;
  owner: ExtensionHostActor;
  databasePath: string | null;
  baseBindingsPath: string | null;
  runtimeBindingsPath: string | null;
  agentVersionAssetsPath: string | null;
  bootstrap: RuntimeBootstrapCaptureResult;
  postgres: boolean;
  modelCredentialAvailable: boolean;
}>;
export type ExtensionRecoveryReleasePreparation = Readonly<{
  extension: ExtensionReleaseInput | null;
}>;
type PreparationState = Readonly<{
  request: ExtensionRecoveryReleaseRequest;
  retainedBuild: RetainedExtensionBuild | undefined;
  prepared: PreparedExtensionRecoveryInputs | null;
  selection: ExtensionRecoverySelection | null;
  unsupportedReason: string | null;
  pluginUnavailable?: true;
}>;
const states = new WeakMap<
  ExtensionRecoveryReleasePreparation,
  PreparationState
>();

/** Native-only explicit opt-in. Snapshot and validate before any retention/storage await. */
export function parseExtensionRecoveryReleaseRequest(
  environment: RuntimeEnvironment,
): ExtensionRecoveryReleaseRequest | null {
  const attemptId = environment.CREWON_EXTENSION_RECOVERY_ATTEMPT_ID;
  const providerJson = environment.CREWON_EXTENSION_RECOVERY_PROVIDER_JSON;
  if (attemptId === undefined && providerJson === undefined) return null;
  if (
    typeof attemptId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(attemptId) ||
    typeof providerJson !== "string" ||
    Buffer.byteLength(providerJson) > 8192 ||
    environment.CREWON_EXTENSIONS_ENABLED !== "1" ||
    (environment.CREWON_CONTROL_SECURITY_MODE !== undefined &&
      environment.CREWON_CONTROL_SECURITY_MODE !== "standalone")
  )
    invalid();
  let provider: unknown;
  try {
    provider = JSON.parse(providerJson);
  } catch {
    return invalid();
  }
  const providerBinding = parseExtensionRecoveryProviderBinding(provider);
  const dataRoot = path(environment.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT);
  if (dataRoot === null) invalid();
  const owner = parseExtensionHostActor({
    principalId: environment.CREWON_PRINCIPAL_ID,
    actorId: environment.CREWON_ACTOR_ID,
    tenantId: environment.CREWON_TENANT_ID,
    spaceId: environment.CREWON_SPACE_ID,
  });
  const databasePath = path(environment.CREWON_CONTROL_DB_PATH);
  const baseBindingsPath = path(
    environment.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH,
  );
  const runtimeBindingsPath = path(
    environment.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH,
  );
  const agentVersionAssetsPath = path(
    environment.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH,
  );
  if ((runtimeBindingsPath === null) !== (agentVersionAssetsPath === null))
    invalid();
  return Object.freeze({
    attemptId,
    providerBinding,
    dataRoot,
    owner,
    databasePath,
    baseBindingsPath,
    runtimeBindingsPath,
    agentVersionAssetsPath,
    bootstrap: captureRuntimeBootstrapInputs(environment),
    postgres: Boolean(environment.CREWON_CONTROL_DATABASE_URL?.trim()),
    modelCredentialAvailable: Boolean(environment.CREWON_MODEL_API_KEY?.trim()),
  });
}

/** Retain is performed by the executing installed Release; this helper cannot discover or select a build. */
export async function prepareExtensionRecoveryRelease(input: {
  request: ExtensionRecoveryReleaseRequest | null;
  extension: ExtensionReleaseInput | null;
  retainedBuild: RetainedExtensionBuild | undefined;
  releaseActor: ActorContext;
  defaultAgentVersionId: string;
}): Promise<ExtensionRecoveryReleasePreparation | null> {
  const request = input.request;
  if (request === null) return null;
  const extension = input.extension;
  const retainedBuild = input.retainedBuild;
  const releaseActor = parseExtensionHostActor(input.releaseActor);
  const defaultAgentVersionId = input.defaultAgentVersionId;
  const unsupportedReason =
    retainedBuild === undefined
      ? "extension_recovery_build_unavailable"
      : request.postgres
        ? "extension_recovery_postgres_unsupported"
        : extension === null ||
            request.runtimeBindingsPath === null ||
            request.agentVersionAssetsPath === null
          ? "extension_recovery_plugin_inputs_unavailable"
          : extensionCanonicalJson(releaseActor) !==
              extensionCanonicalJson(request.owner)
            ? "extension_recovery_owner_mismatch"
            : request.databasePath === null
              ? "extension_recovery_database_unavailable"
              : null;
  const token = Object.freeze({ extension });
  if (unsupportedReason !== null) {
    states.set(
      token,
      Object.freeze({
        request,
        retainedBuild,
        prepared: null,
        selection: null,
        unsupportedReason,
      }),
    );
    return token;
  }
  const bootstrap = request.bootstrap;
  if (
    extension === null ||
    request.runtimeBindingsPath === null ||
    request.agentVersionAssetsPath === null ||
    retainedBuild === undefined ||
    request.databasePath === null
  )
    invalid();
  const currentUnsupported =
    bootstrap.outcome === "unsupported"
      ? bootstrap.reasonCode
      : new URL(bootstrap.inputs.model.endpoint).href !==
            request.providerBinding.responsesEndpoint ||
          bootstrap.inputs.model.credentialRequired !==
            request.providerBinding.credentialRequired
        ? "extension_recovery_provider_mismatch"
        : null;
  const store = new SqliteRunStore(request.databasePath);
  try {
    const published = await Promise.all(
      extension.versions.map((version) =>
        store.loadAgentVersionDeployment({
          tenantId: request.owner.tenantId,
          agentVersionId: version.agentVersionId,
        }),
      ),
    );
    const previouslyPublished = published.some(
      (deployment) => deployment !== null,
    );
    if (
      previouslyPublished &&
      extension.runtimeBindings.bindings.some(
        (binding) =>
          binding.provider.kind !== "directResponses" ||
          new URL(binding.provider.endpoint).href !==
            request.providerBinding.responsesEndpoint,
      )
    ) {
      const result = Object.freeze({ extension: null });
      states.set(
        result,
        Object.freeze({
          request,
          retainedBuild,
          prepared: null,
          selection: null,
          unsupportedReason: "extension_recovery_current_provider_mismatch",
          pluginUnavailable: true,
        }),
      );
      return result;
    }
    if (
      previouslyPublished &&
      !request.modelCredentialAvailable &&
      extension.runtimeBindings.bindings.some(
        (binding) =>
          binding.provider.kind === "directResponses" &&
          binding.provider.apiKeyEnvironment === "CREWON_MODEL_API_KEY",
      )
    ) {
      const result = Object.freeze({ extension: null });
      states.set(
        result,
        Object.freeze({
          request,
          retainedBuild,
          prepared: null,
          selection: null,
          unsupportedReason:
            "extension_recovery_current_credential_unavailable",
          pluginUnavailable: true,
        }),
      );
      return result;
    }
    if (!previouslyPublished && currentUnsupported !== null) {
      states.set(
        token,
        Object.freeze({
          request,
          retainedBuild,
          prepared: null,
          selection: null,
          unsupportedReason: currentUnsupported,
        }),
      );
      return token;
    }
    let inspection;
    try {
      inspection = inspectExtensionRecoveryInputs({
        extension,
        runtimeBindingsPath: request.runtimeBindingsPath,
        agentVersionAssetsPath: request.agentVersionAssetsPath,
        owner: request.owner,
        defaultAgentVersionId,
        model: {
          endpoint: request.providerBinding.responsesEndpoint,
          credentialEnvironment: request.providerBinding.credentialRequired
            ? "CREWON_MODEL_API_KEY"
            : null,
        },
      });
    } catch (error) {
      if (previouslyPublished || !recoverySourceUnsafe(error)) throw error;
      states.set(
        token,
        Object.freeze({
          request,
          retainedBuild,
          prepared: null,
          selection: null,
          unsupportedReason: "extension_recovery_source_unsupported",
        }),
      );
      return token;
    }
    const capsuleId = deriveExtensionRecoveryCapsuleId({
      implementationDigest: retainedBuild.implementationDigest,
      buildIdentityDigest: retainedBuild.buildIdentityDigest,
      owner: request.owner,
      originalInputIdentityDigest: inspection.originalInputIdentityDigest,
    });
    const selection = Object.freeze({ dataRoot: request.dataRoot, capsuleId });
    let prepared: Awaited<ReturnType<typeof prepareExtensionRecoveryInputs>>;
    try {
      prepared = await prepareExtensionRecoveryInputs({
        inspection,
        selection,
        deployments: store,
      });
    } catch (error) {
      if (previouslyPublished || !optionalStorageError(error, selection))
        throw error;
      states.set(
        token,
        Object.freeze({
          request,
          retainedBuild,
          prepared: null,
          selection: null,
          unsupportedReason: "extension_recovery_storage_unavailable",
        }),
      );
      return token;
    }
    const result = Object.freeze({ extension: prepared.extension });
    states.set(
      result,
      Object.freeze({
        request,
        retainedBuild,
        selection,
        prepared: prepared.outcome === "prepared" ? prepared : null,
        unsupportedReason:
          prepared.outcome === "unsupported"
            ? prepared.reasonCode
            : (currentUnsupported ??
              (inspection.eligibility.outcome === "unsupported"
                ? inspection.eligibility.reasonCode
                : null)),
      }),
    );
    return result;
  } finally {
    await store.close();
  }
}

/** Called only after successful publication. Reports a candidate; Native owns readiness and the complete marker. */
export async function finishExtensionRecoveryRelease(input: {
  preparation: ExtensionRecoveryReleasePreparation | null;
  plan: RuntimeAgentVersionReleasePlan;
}): Promise<void> {
  const preparation = input.preparation;
  if (preparation === null) return;
  const state = states.get(preparation);
  if (state === undefined)
    throw new Error("extension_recovery_preparation_invalid");
  const plan = structuredClone(input.plan);
  const { request, prepared, retainedBuild, selection } = state;
  if (state.pluginUnavailable) {
    await writeExtensionRecoveryStartupReport({
      dataRoot: request.dataRoot,
      report: {
        schemaVersion: "crewon.extension-recovery-startup.v0",
        attemptId: request.attemptId,
        outcome: "pluginUnavailable",
        reasonCode:
          state.unsupportedReason ===
          "extension_recovery_current_credential_unavailable"
            ? state.unsupportedReason
            : "extension_recovery_current_provider_mismatch",
      },
    });
    return;
  }
  if (
    prepared === null ||
    selection === null ||
    retainedBuild === undefined ||
    request.databasePath === null
  ) {
    await unsupportedReport(
      request,
      state.unsupportedReason ?? "extension_recovery_inputs_unsupported",
      null,
    );
    return;
  }
  // Verification is a publication/identity gate, not a best-effort recovery enhancement.
  const store = new SqliteRunStore(request.databasePath);
  try {
    await verifyRuntimeAgentVersionRelease({
      tenantId: request.owner.tenantId,
      store,
      plan,
    });
  } finally {
    await store.close();
  }
  const currentUnsupported =
    state.unsupportedReason ??
    (request.bootstrap.outcome === "unsupported"
      ? request.bootstrap.reasonCode
      : null);
  let manifest: ExtensionRecoveryManifest;
  let missingMarker = false;
  try {
    try {
      const existing = await resolveExtensionRecoveryCapsule(selection);
      manifest = existing.manifest;
      if (
        manifest.implementationDigest !== retainedBuild.implementationDigest ||
        manifest.buildIdentityDigest !== retainedBuild.buildIdentityDigest ||
        extensionCanonicalJson(manifest.owner) !==
          extensionCanonicalJson(request.owner) ||
        extensionCanonicalJson(manifest.targets) !==
          extensionCanonicalJson(prepared.targets)
      )
        throw new Error("extension_recovery_existing_capsule_mismatch");
      if (currentUnsupported !== null) {
        await unsupportedReport(
          request,
          currentUnsupported,
          selection.capsuleId,
        );
        return;
      }
      if (
        extensionCanonicalJson(manifest.providerBinding) !==
        extensionCanonicalJson(request.providerBinding)
      ) {
        await unsupportedReport(
          request,
          "extension_recovery_provider_mismatch",
          selection.capsuleId,
        );
        return;
      }
      // The original bootstrap, provider and release remain immutable across current default/catalog upgrades.
    } catch (error) {
      if (
        !hasCode(error, "ENOENT") ||
        !errorPath(
          error,
          join(dirname(prepared.runtimeBindingsPath), "manifest.json"),
        )
      )
        throw error;
      missingMarker = true;
      if (
        currentUnsupported !== null ||
        request.bootstrap.outcome !== "eligible"
      ) {
        await unsupportedReport(
          request,
          currentUnsupported ?? "extension_recovery_inputs_unsupported",
          selection.capsuleId,
        );
        return;
      }
      const bootstrap = request.bootstrap.inputs;
      const transport = createModelTransport(
        "responses",
        {},
        replayRuntimeBootstrapInputs(bootstrap),
      );
      try {
        const compiled = compileRuntimeAgentVersion({
          runtimeTenantId: request.owner.tenantId,
          route: bootstrap.route,
          transport,
          agentInstructions: bootstrap.agent.instructions,
          modelContextWindowTokens: bootstrap.agent.contextWindowTokens,
          autoCompactAtTokens: bootstrap.agent.autoCompactAtTokens,
          streamMaxRetries: bootstrap.agent.streamMaxRetries,
          maxToolRounds: bootstrap.agent.maxToolRounds,
          nativeWorkspaceReadCatalog: "disabled",
        });
        if (compiled.contentDigest !== plan.bootstrapVersion.contentDigest)
          throw new Error("extension_recovery_bootstrap_changed");
      } finally {
        await transport.close?.();
      }
      if (request.baseBindingsPath === null)
        throw new Error("extension_recovery_base_bindings_unavailable");
      const baseBytes = readBaseBindings(request.baseBindingsPath);
      validateBaseBindings(
        baseBytes,
        request.providerBinding,
        plan,
        prepared,
        request.owner.tenantId,
      );
      const files = [...prepared.files];
      for (const [file, bytes] of [
        ["base-bindings.json", baseBytes],
        [
          "bootstrap.json",
          // This parsed DTO has its own 128 KiB boundary. The plugin protocol's
          // 64 KiB canonicalizer is not the recovery file format.
          Buffer.from(`${JSON.stringify(bootstrap)}\n`),
        ],
        [
          "release.json",
          Buffer.from(
            `${JSON.stringify({ schemaVersion: "crewon.extension-recovery-release.v0", tenantId: request.owner.tenantId, plan })}\n`,
          ),
        ],
      ] as const)
        files.push(await putExtensionRecoveryFile({ selection, file, bytes }));
      const registrations = prepared.extension.runtimeBindings.bindings.map(
        (binding) => {
          const snapshot = loadRuntimeExtensionSnapshot(
            binding.extensionConfigPath!,
          );
          return {
            pluginId: snapshot.configuration.pluginId,
            pluginVersion: snapshot.configuration.pluginVersion,
            manifestDigest: snapshot.registration.manifestDigest,
            implementationDigest: snapshot.registration.implementationDigest,
          };
        },
      );
      manifest = parseExtensionRecoveryManifest({
        schemaVersion: "crewon.extension-recovery-capsule.v0",
        capsuleId: selection.capsuleId,
        owner: request.owner,
        implementationDigest: retainedBuild.implementationDigest,
        buildIdentityDigest: retainedBuild.buildIdentityDigest,
        providerBinding: request.providerBinding,
        releaseId: plan.bundle.releaseId,
        registrations: [
          ...new Map(
            registrations.map((registration) => [
              extensionCanonicalJson(registration),
              registration,
            ]),
          ).values(),
        ],
        targets: prepared.targets,
        files,
      });
    }
  } catch (error) {
    if (!missingMarker || !optionalMetadataError(error, selection)) throw error;
    // Incomplete or mismatched optional recovery metadata never overwrites an existing input.
    // Current Worker must still receive the prepared plugin paths used in the published deployment.
    await unsupportedReport(
      request,
      "extension_recovery_release_inputs_unsupported",
      selection.capsuleId,
    );
    return;
  }
  await writeExtensionRecoveryStartupReport({
    dataRoot: request.dataRoot,
    report: {
      schemaVersion: "crewon.extension-recovery-startup.v0",
      attemptId: request.attemptId,
      outcome: "prepared",
      manifest,
    },
  });
}

function validateBaseBindings(
  bytes: Buffer,
  provider: ExtensionRecoveryProviderBinding,
  plan: RuntimeAgentVersionReleasePlan,
  prepared: PreparedExtensionRecoveryInputs,
  tenantId: string,
) {
  const base = parseRuntimeBindingConfig(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  for (const binding of base.bindings) {
    const version = plan.versions.find(
      (version) => version.agentVersionId === binding.agentVersionId,
    );
    if (
      binding.tenantId !== tenantId ||
      version === undefined ||
      version.contentDigest !== binding.contentDigest ||
      prepared.targets.some(
        (target) => target.agentVersionId === binding.agentVersionId,
      ) ||
      binding.provider.kind !== "directResponses" ||
      new URL(binding.provider.endpoint).href !== provider.responsesEndpoint ||
      binding.provider.apiKeyEnvironment !==
        (provider.credentialRequired ? "CREWON_MODEL_API_KEY" : null) ||
      binding.workspaceBindingId !== null ||
      binding.mcpStdioConfigPath !== null ||
      binding.deviceToolConfigPath !== null ||
      binding.remoteMcpConfigPath !== null ||
      binding.extensionConfigPath !== undefined
    )
      throw new Error("extension_recovery_base_bindings_unsupported");
  }
}
function readBaseBindings(path: string): Buffer {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 2 || before.size > 1024 * 1024)
      throw new Error("extension_recovery_base_bindings_invalid");
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(fd);
    if (
      used !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("extension_recovery_base_bindings_changed");
    return bytes.subarray(0, used);
  } finally {
    closeSync(fd);
  }
}
async function unsupportedReport(
  request: ExtensionRecoveryReleaseRequest,
  reasonCode: string,
  preparedInputCapsuleId: string | null,
) {
  await writeExtensionRecoveryStartupReport({
    dataRoot: request.dataRoot,
    report: {
      schemaVersion: "crewon.extension-recovery-startup.v0",
      attemptId: request.attemptId,
      outcome: "unsupported",
      reasonCode,
      preparedInputCapsuleId,
    },
  });
}
function path(input: string | undefined): string | null {
  if (input === undefined) return null;
  if (
    !isAbsolute(input) ||
    input.trim() !== input ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    invalid();
  return input;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function errorPath(error: unknown, path: string): boolean {
  return error instanceof Error && "path" in error && error.path === path;
}
function optionalStorageError(
  error: unknown,
  selection: ExtensionRecoverySelection,
): boolean {
  if (
    error instanceof Error &&
    error.message === "extension_recovery_capacity_exceeded"
  )
    return true;
  const root = join(selection.dataRoot, "extension-recoveries");
  return (
    error instanceof Error &&
    "path" in error &&
    typeof error.path === "string" &&
    (error.path === root || error.path.startsWith(`${root}${sep}`)) &&
    ["EACCES", "EPERM", "EROFS", "ENOSPC"].some((code) => hasCode(error, code))
  );
}
function optionalMetadataError(
  error: unknown,
  selection: ExtensionRecoverySelection,
): boolean {
  return (
    optionalStorageError(error, selection) ||
    (error instanceof Error &&
      [
        "extension_recovery_file_mismatch",
        "extension_recovery_file_size_invalid",
        "extension_recovery_base_bindings_unavailable",
        "extension_recovery_base_bindings_unsupported",
      ].includes(error.message))
  );
}
function recoverySourceUnsafe(error: unknown): boolean {
  return (
    hasCode(error, "ELOOP") ||
    (error instanceof Error &&
      error.message === "extension_recovery_source_path_invalid")
  );
}
function invalid(): never {
  throw new Error("extension_recovery_request_invalid");
}
