import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { inspect, isDeepStrictEqual } from "node:util";
import {
  EXTENSION_HISTORICAL_WORK_ITEM_SCOPE,
  resolveRetainedExtensionBuild,
} from "@crewon/agent-version/extension-build";
import {
  readExtensionRecoveryFile,
  resolveExtensionRecoveryCapsule,
  type ExtensionRecoveryManifest,
  type ExtensionRecoveryProviderBinding,
  type ExtensionRecoverySelection,
} from "@crewon/agent-version/extension-recovery";
import { replayRuntimeBootstrapInputs } from "@crewon/contracts/runtime";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import { verifyDesktopExtensionHistoricalMaterials } from "./desktopExtensionHistoricalMaterials.ts";
import type { ProviderRuntimeCredentialResolution } from "./providerCredentials.ts";

export type DesktopExtensionHistoricalWorkerLaunchPlan = Readonly<{
  outcome: "ready";
  manifest: ExtensionRecoveryManifest;
  workerPath: string;
  environment: NodeJS.ProcessEnv;
  token: string;
  deadlineMs: number;
}>;
export type DesktopExtensionHistoricalWorkerUnavailable = Readonly<{
  outcome: "unavailable";
  capsuleId: string;
  reasonCode:
    | "desktop_extension_historical_inputs_unavailable"
    | "desktop_extension_historical_provider_unavailable";
}>;
const DEADLINE_MS = 20_000;

/**
 * Selects only a complete Native-owned capsule and its exact retained code.
 * No ambient environment, active Provider fallback, publication or release is
 * performed. Material verification grants no execution authority: the retained
 * Worker still recompiles its bootstrap and verifies the persisted release.
 */
export async function prepareDesktopExtensionHistoricalWorker(input: {
  selection: ExtensionRecoverySelection;
  resolveProvider: (
    binding: ExtensionRecoveryProviderBinding,
  ) => ProviderRuntimeCredentialResolution;
  signal?: AbortSignal;
}): Promise<
  | DesktopExtensionHistoricalWorkerLaunchPlan
  | DesktopExtensionHistoricalWorkerUnavailable
> {
  const selected = record(input.selection, ["dataRoot", "capsuleId"]);
  const dataRoot = selected.dataRoot;
  const capsuleId = selected.capsuleId;
  if (
    typeof dataRoot !== "string" ||
    !isAbsolute(dataRoot) ||
    dataRoot.trim() !== dataRoot ||
    Buffer.byteLength(dataRoot) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(dataRoot) ||
    typeof capsuleId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(capsuleId)
  )
    invalid();
  const selection = Object.freeze({ dataRoot, capsuleId });
  const resolveProvider = input.resolveProvider;
  const signal = input.signal;
  if (typeof resolveProvider !== "function") invalid();
  signal?.throwIfAborted();
  try {
    const capsule = await resolveExtensionRecoveryCapsule(selection);
    signal?.throwIfAborted();
    const { manifest, directory } = capsule;
    if (!same(manifest.owner, DESKTOP_RUNTIME_OWNER)) invalid();
    const build = await resolveRetainedExtensionBuild({
      dataRoot,
      implementationDigest: manifest.implementationDigest,
      expectedBuildIdentityDigest: manifest.buildIdentityDigest,
    });
    if (
      build.historicalWorkItemScope !== EXTENSION_HISTORICAL_WORK_ITEM_SCOPE ||
      build.implementationDigest !== manifest.implementationDigest ||
      build.buildIdentityDigest !== manifest.buildIdentityDigest
    )
      invalid();
    const worker = build.bundles.find(
      (bundle) => bundle.file === "runtime-worker.mjs",
    );
    if (worker === undefined) invalid();
    const documents = new Map<string, unknown>();
    for (const pin of manifest.files) {
      signal?.throwIfAborted();
      documents.set(
        pin.file,
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readExtensionRecoveryFile({
              selection,
              file: pin.file,
              expectedDigest: pin.digest,
            }),
          ),
        ),
      );
    }
    const materials = verifyDesktopExtensionHistoricalMaterials({
      dataRoot,
      manifest,
      directory,
      documents,
    });
    const bootstrap = materials.inputs;
    // Re-resolve after the bounded material reads, including the complete marker.
    const checked = await resolveExtensionRecoveryCapsule(selection);
    if (!same(checked.manifest, manifest)) invalid();
    signal?.throwIfAborted();
    const credential = resolveProvider(manifest.providerBinding);
    if (
      credential.availability !== "available" ||
      (manifest.providerBinding.credentialRequired &&
        (typeof credential.apiKey !== "string" ||
          credential.apiKey.trim().length === 0)) ||
      (credential.apiKey !== null &&
        (typeof credential.apiKey !== "string" ||
          credential.apiKey.trim() !== credential.apiKey ||
          Buffer.byteLength(credential.apiKey) > 32 * 1024 ||
          /[\u0000-\u001f\u007f]/u.test(credential.apiKey)))
    )
      return unavailable(capsuleId, "provider");
    const token = randomBytes(32).toString("hex");
    const environment: NodeJS.ProcessEnv = {
      ...replayRuntimeBootstrapInputs(bootstrap),
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_PRINCIPAL_ID: DESKTOP_RUNTIME_OWNER.principalId,
      CREWON_ACTOR_ID: DESKTOP_RUNTIME_OWNER.actorId,
      CREWON_TENANT_ID: DESKTOP_RUNTIME_OWNER.tenantId,
      CREWON_SPACE_ID: DESKTOP_RUNTIME_OWNER.spaceId,
      CREWON_CONTROL_DB_PATH: join(dataRoot, "control.sqlite"),
      CREWON_ARTIFACT_DB_PATH: join(dataRoot, "artifact-metadata.sqlite"),
      CREWON_ARTIFACT_ROOT: join(dataRoot, "artifacts"),
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: join(
        dataRoot,
        "artifact-encryption.key",
      ),
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "desktop-artifact-key-v1",
      CREWON_AGENT_VERSION_CONTENT_DIGEST: materials.bootstrapContentDigest,
      CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: join(
        directory,
        "base-bindings.json",
      ),
      CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: join(
        directory,
        "plugin-bindings.json",
      ),
      CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: join(
        directory,
        "plugin-assets.json",
      ),
      CREWON_EXTENSIONS_ENABLED: "1",
      CREWON_EXTENSION_EXECUTION_MODE: "historical",
      CREWON_EXTENSION_HOST_PORT: "0",
      CREWON_EXTENSION_HOST_TOKEN: token,
      CREWON_EXTENSION_HOST_DEADLINE_MS: String(DEADLINE_MS),
      ...(manifest.providerBinding.credentialRequired
        ? { CREWON_MODEL_API_KEY: credential.apiKey! }
        : {}),
    };
    const redactEnvironment = () => ({
      ...environment,
      CREWON_EXTENSION_HOST_TOKEN: "[REDACTED]",
      ...(environment.CREWON_MODEL_API_KEY === undefined
        ? {}
        : { CREWON_MODEL_API_KEY: "[REDACTED]" }),
    });
    Object.defineProperties(environment, {
      toJSON: { value: redactEnvironment },
      [inspect.custom]: { value: redactEnvironment },
    });
    Object.freeze(environment);
    const plan = {
      outcome: "ready" as const,
      manifest,
      workerPath: worker.path,
      environment,
      token,
      deadlineMs: DEADLINE_MS,
    };
    const redacted = () => ({ ...plan, token: "[REDACTED]" });
    Object.defineProperties(plan, {
      toJSON: { value: redacted },
      [inspect.custom]: { value: redacted },
    });
    return Object.freeze(plan);
  } catch {
    signal?.throwIfAborted();
    return unavailable(capsuleId, "inputs");
  }
}

function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.getOwnPropertySymbols(input).length !== 0
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some(
      (value) => !("value" in value) || !value.enumerable,
    )
  )
    invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
function unavailable(
  capsuleId: string,
  reason: "inputs" | "provider",
): DesktopExtensionHistoricalWorkerUnavailable {
  return Object.freeze({
    outcome: "unavailable",
    capsuleId,
    reasonCode:
      reason === "inputs"
        ? "desktop_extension_historical_inputs_unavailable"
        : "desktop_extension_historical_provider_unavailable",
  });
}
function invalid(): never {
  throw new Error("desktop_extension_historical_inputs_invalid");
}
