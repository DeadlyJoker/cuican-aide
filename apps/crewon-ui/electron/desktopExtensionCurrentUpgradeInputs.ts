import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  listExtensionRecoveryCapsules,
  resolveExtensionRecoveryCapsule,
} from "@crewon/agent-version/extension-recovery";
import {
  inspectInstalledExtensionRuntimeBuild,
  matchExtensionRecoveryOriginalInputs,
} from "@crewon/agent-version/extension-recovery-inputs";
import {
  DESKTOP_RUNTIME_OWNER,
  parseDesktopExtensionRuntimeConfiguration,
  type DesktopExtensionRuntimeConfiguration,
  type DesktopExtensionRuntimeEnvironments,
} from "./desktopExtensionRuntime.ts";
import { prepareDesktopExtensionHistoricalWorker } from "./desktopExtensionHistoricalInputs.ts";
import type {
  ProviderRuntimeCredentialInput,
  ProviderRuntimeCredentialResolution,
} from "./providerCredentials.ts";

export type DesktopExtensionCurrentUpgradeInputs =
  | Readonly<{
      outcome: "unchanged";
      environments: DesktopExtensionRuntimeEnvironments;
      reasonCode: null | "desktop_extension_current_upgrade_unavailable";
    }>
  | Readonly<{
      outcome: "historyOnly";
      environments: DesktopExtensionRuntimeEnvironments;
      capsuleId: string;
      reasonCode: "desktop_extension_current_upgrade_history_only";
    }>;

const DEADLINE_MS = 20_000;
const PLUGIN_PATH_NAMES = [
  "CREWON_EXTENSION_RUNTIME_BINDINGS_PATH",
  "CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH",
] as const;

/**
 * Before current release, isolate only inputs proved to belong to one complete
 * old build. This never rewrites configuration, publishes or launches an old
 * Worker. Current release still performs all its ordinary identity/DB gates;
 * historical selection repeats its own verification after current readiness.
 */
export async function prepareDesktopExtensionCurrentUpgradeInputs(input: {
  dataRoot: string;
  currentBuildDirectory: string;
  source: boolean;
  configuration: DesktopExtensionRuntimeConfiguration;
  environments: DesktopExtensionRuntimeEnvironments;
  resolveProvider: (
    binding: ProviderRuntimeCredentialInput,
  ) => ProviderRuntimeCredentialResolution;
  signal?: AbortSignal;
}): Promise<DesktopExtensionCurrentUpgradeInputs> {
  const original = input.environments;
  const startupSignal = input.signal;
  startupSignal?.throwIfAborted();
  // Preserve source, disabled and metadata-only startup without inspecting files.
  if (input.source || !original.enabled) return unchanged(original, null);
  const configuration = parseDesktopExtensionRuntimeConfiguration(
    input.configuration,
  );
  if (!configuration.enabled || configuration.runtimeBindingsPath === null)
    return unchanged(original, null);
  const dataRoot = input.dataRoot;
  const currentBuildDirectory = input.currentBuildDirectory;
  const resolveProvider = input.resolveProvider;
  const environments = Object.freeze({
    ...original,
    release: Object.freeze({ ...original.release }),
    worker: Object.freeze({ ...original.worker }),
  });
  if (
    !safePath(dataRoot) ||
    !safePath(currentBuildDirectory) ||
    typeof resolveProvider !== "function" ||
    !currentScopeMatches(environments, dataRoot, configuration)
  )
    return unchanged(original, "desktop_extension_current_upgrade_unavailable");
  const signal = AbortSignal.any([
    ...(startupSignal ? [startupSignal] : []),
    AbortSignal.timeout(DEADLINE_MS),
  ]);
  try {
    return await cancelable(
      qualify({
        dataRoot,
        currentBuildDirectory,
        configuration,
        environments,
        resolveProvider,
        signal,
      }),
      signal,
    );
  } catch {
    // Startup cancellation remains cancellation. Optional proof failures retain
    // the original strict release path; they never trigger a release retry.
    startupSignal?.throwIfAborted();
    return unchanged(original, "desktop_extension_current_upgrade_unavailable");
  }
}

async function qualify(input: {
  dataRoot: string;
  currentBuildDirectory: string;
  configuration: Extract<
    DesktopExtensionRuntimeConfiguration,
    { enabled: true }
  >;
  environments: DesktopExtensionRuntimeEnvironments;
  resolveProvider: (
    binding: ProviderRuntimeCredentialInput,
  ) => ProviderRuntimeCredentialResolution;
  signal: AbortSignal;
}): Promise<DesktopExtensionCurrentUpgradeInputs> {
  const { signal, environments } = input;
  const installed = await inspectInstalledExtensionRuntimeBuild({
    directory: input.currentBuildDirectory,
  });
  signal.throwIfAborted();
  const inventory = await listExtensionRecoveryCapsules({
    dataRoot: input.dataRoot,
  });
  signal.throwIfAborted();
  const matching = [];
  for (const capsule of inventory.capsules) {
    signal.throwIfAborted();
    if (
      capsule.manifest.implementationDigest ===
        installed.implementationDigest ||
      !isDeepStrictEqual(capsule.manifest.owner, DESKTOP_RUNTIME_OWNER)
    )
      continue;
    const selection = {
      dataRoot: input.dataRoot,
      capsuleId: capsule.manifest.capsuleId,
    };
    const match = await matchExtensionRecoveryOriginalInputs({
      selection,
      runtimeBindingsPath: input.configuration.runtimeBindingsPath!,
      agentVersionAssetsPath: input.configuration.agentVersionAssetsPath!,
    });
    signal.throwIfAborted();
    if (match.matches)
      matching.push({ capsule, selection, inputKind: match.inputKind });
    if (matching.length > 1)
      return unchanged(
        environments,
        "desktop_extension_current_upgrade_unavailable",
      );
  }
  if (matching.length !== 1)
    return unchanged(
      environments,
      "desktop_extension_current_upgrade_unavailable",
    );
  const selected = matching[0]!;
  // Full saved release assets, deployments, bundle, retained scope and exact
  // current Provider availability are checked by the existing historical port.
  // Its private launch environment/key/token are deliberately not returned.
  const historical = await prepareDesktopExtensionHistoricalWorker({
    selection: selected.selection,
    resolveProvider: input.resolveProvider,
    signal,
  });
  signal.throwIfAborted();
  if (
    historical.outcome !== "ready" ||
    !isDeepStrictEqual(historical.manifest, selected.capsule.manifest)
  )
    return unchanged(
      environments,
      "desktop_extension_current_upgrade_unavailable",
    );
  const checkedInstalled = await inspectInstalledExtensionRuntimeBuild({
    directory: input.currentBuildDirectory,
  });
  signal.throwIfAborted();
  const checkedMatch = await matchExtensionRecoveryOriginalInputs({
    selection: selected.selection,
    runtimeBindingsPath: input.configuration.runtimeBindingsPath!,
    agentVersionAssetsPath: input.configuration.agentVersionAssetsPath!,
  });
  signal.throwIfAborted();
  const checkedInventory = await listExtensionRecoveryCapsules({
    dataRoot: input.dataRoot,
  });
  signal.throwIfAborted();
  const checkedCapsule = await resolveExtensionRecoveryCapsule(
    selected.selection,
  );
  signal.throwIfAborted();
  if (
    !isDeepStrictEqual(installed, checkedInstalled) ||
    !isDeepStrictEqual(inventory, checkedInventory) ||
    !checkedMatch.matches ||
    checkedMatch.inputKind !== selected.inputKind ||
    !isDeepStrictEqual(selected.capsule.manifest, checkedCapsule.manifest)
  )
    return unchanged(
      environments,
      "desktop_extension_current_upgrade_unavailable",
    );
  // Repeat the full DB/build gate and current exact credential lookup last.
  // A Provider can be deleted or changed during the preceding filesystem awaits.
  const finalHistorical = await prepareDesktopExtensionHistoricalWorker({
    selection: selected.selection,
    resolveProvider: input.resolveProvider,
    signal,
  });
  signal.throwIfAborted();
  if (
    finalHistorical.outcome !== "ready" ||
    !isDeepStrictEqual(finalHistorical.manifest, checkedCapsule.manifest)
  )
    return unchanged(
      environments,
      "desktop_extension_current_upgrade_unavailable",
    );
  const release = { ...environments.release };
  const worker = { ...environments.worker };
  for (const name of PLUGIN_PATH_NAMES) {
    delete release[name];
    delete worker[name];
  }
  return Object.freeze({
    outcome: "historyOnly",
    environments: Object.freeze({
      ...environments,
      release: Object.freeze(release),
      worker: Object.freeze(worker),
    }),
    capsuleId: selected.selection.capsuleId,
    reasonCode: "desktop_extension_current_upgrade_history_only",
  });
}

function currentScopeMatches(
  environments: DesktopExtensionRuntimeEnvironments,
  dataRoot: string,
  configuration: Extract<
    DesktopExtensionRuntimeConfiguration,
    { enabled: true }
  >,
): boolean {
  for (const environment of [environments.release, environments.worker]) {
    if (
      environment.CREWON_CONTROL_SECURITY_MODE !== "standalone" ||
      environment.CREWON_CONTROL_DATABASE_URL !== undefined ||
      environment.CREWON_CONTROL_DATABASE_SCHEMA !== undefined ||
      environment.CREWON_CONTROL_DB_PATH !== join(dataRoot, "control.sqlite") ||
      environment.CREWON_EXTENSIONS_ENABLED !== "1" ||
      environment.CREWON_PRINCIPAL_ID !== DESKTOP_RUNTIME_OWNER.principalId ||
      environment.CREWON_ACTOR_ID !== DESKTOP_RUNTIME_OWNER.actorId ||
      environment.CREWON_TENANT_ID !== DESKTOP_RUNTIME_OWNER.tenantId ||
      environment.CREWON_SPACE_ID !== DESKTOP_RUNTIME_OWNER.spaceId ||
      environment.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH !==
        configuration.runtimeBindingsPath ||
      environment.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH !==
        configuration.agentVersionAssetsPath
    )
      return false;
  }
  return (
    environments.release.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT ===
      dataRoot &&
    environments.release.CREWON_RELEASE_PRINCIPAL_ID ===
      DESKTOP_RUNTIME_OWNER.principalId &&
    environments.release.CREWON_RELEASE_ACTOR_ID ===
      DESKTOP_RUNTIME_OWNER.actorId
  );
}

function safePath(input: unknown): input is string {
  return (
    typeof input === "string" &&
    isAbsolute(input) &&
    resolve(input) === input &&
    input.trim() === input &&
    Buffer.byteLength(input) <= 4096 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  );
}
function unchanged(
  environments: DesktopExtensionRuntimeEnvironments,
  reasonCode: null | "desktop_extension_current_upgrade_unavailable",
): DesktopExtensionCurrentUpgradeInputs {
  return Object.freeze({ outcome: "unchanged", environments, reasonCode });
}
function cancelable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
