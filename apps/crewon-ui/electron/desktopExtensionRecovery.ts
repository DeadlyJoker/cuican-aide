import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  EXTENSION_HISTORICAL_WORK_ITEM_SCOPE,
  resolveRetainedExtensionBuild,
} from "@crewon/agent-version/extension-build";
import {
  commitExtensionRecoveryCapsule,
  extensionRecoveryDirectory,
  parseExtensionRecoveryManifest,
  parseExtensionRecoveryProviderBinding,
  readExtensionRecoveryFile,
  readExtensionRecoveryStartupReport,
  type ExtensionRecoveryManifest,
  type ExtensionRecoveryProviderBinding,
  type ExtensionRecoverySelection,
} from "@crewon/agent-version/extension-recovery";
import {
  EXTENSION_HOST_PRIVATE_PATH,
  EXTENSION_HOST_WIRE_LIMITS,
  parseExtensionHostRequest,
  parseExtensionHostResponse,
  type ExtensionHostRequest,
} from "@crewon/contracts";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import {
  DESKTOP_RUNTIME_OWNER,
  parseDesktopExtensionHostOrigin,
  type DesktopExtensionRuntimeEnvironments,
  type DesktopExtensionHostCatalogRegistration,
} from "./desktopExtensionRuntime.ts";
import type { ActiveProvider } from "./providerCredentials.ts";

export type DesktopExtensionRecoveryAttempt = Readonly<{
  dataRoot: string;
  attemptId: string;
  providerBinding: ExtensionRecoveryProviderBinding;
}>;
export type DesktopExtensionRecoveryPrepared = Readonly<{
  environments: DesktopExtensionRuntimeEnvironments;
  candidate: ExtensionRecoveryManifest | null;
  reasonCode: string | null;
}>;

/** Native composition alone supplies this request; ordinary source startup stays unchanged. */
export function desktopExtensionRecoveryAttempt(input: {
  dataRoot: string;
  provider: ActiveProvider;
  source: boolean;
  environments: DesktopExtensionRuntimeEnvironments;
}): Readonly<{
  attempt: DesktopExtensionRecoveryAttempt | null;
  environments: DesktopExtensionRuntimeEnvironments;
}> {
  const environments = input.environments;
  if (!environments.enabled || input.source)
    return { attempt: null, environments };
  let providerBinding: ExtensionRecoveryProviderBinding;
  try {
    providerBinding = parseExtensionRecoveryProviderBinding({
      providerId: input.provider.providerId,
      endpoint: input.provider.endpoint,
      responsesEndpoint: environments.release.CREWON_RESPONSES_ENDPOINT,
      credentialRequired:
        environments.release.CREWON_MODEL_CREDENTIAL_REQUIRED !== "0",
    });
  } catch {
    // An unsupported recovery binding does not change current provider startup.
    return { attempt: null, environments };
  }
  const attempt = Object.freeze({
    dataRoot: input.dataRoot,
    attemptId: randomBytes(32).toString("hex"),
    providerBinding,
  });
  return {
    attempt,
    environments: {
      ...environments,
      release: {
        ...environments.release,
        CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: attempt.attemptId,
        CREWON_EXTENSION_RECOVERY_PROVIDER_JSON:
          JSON.stringify(providerBinding),
      },
    },
  };
}

/** A release may already have published the frozen plugin paths, even without a complete capsule. */
export async function loadDesktopExtensionRecovery(input: {
  attempt: DesktopExtensionRecoveryAttempt;
  environments: DesktopExtensionRuntimeEnvironments;
}): Promise<DesktopExtensionRecoveryPrepared> {
  const attempt = Object.freeze({
    dataRoot: input.attempt.dataRoot,
    attemptId: input.attempt.attemptId,
    providerBinding: parseExtensionRecoveryProviderBinding(
      input.attempt.providerBinding,
    ),
  });
  const environments = {
    ...input.environments,
    release: { ...input.environments.release },
    worker: { ...input.environments.worker },
  };
  const report = await readExtensionRecoveryStartupReport({
    dataRoot: attempt.dataRoot,
    expectedAttemptId: attempt.attemptId,
  });
  if (report.outcome === "pluginUnavailable") {
    return withoutCurrentPluginInputs(environments, report.reasonCode);
  }
  const manifest = report.outcome === "prepared" ? report.manifest : null;
  const capsuleId =
    manifest?.capsuleId ??
    (report.outcome === "unsupported" ? report.preparedInputCapsuleId : null);
  if (capsuleId === null)
    return {
      environments,
      candidate: null,
      reasonCode: report.outcome === "unsupported" ? report.reasonCode : null,
    };
  if (!environments.enabled) unavailable();
  if (manifest !== null && !same(manifest.owner, DESKTOP_RUNTIME_OWNER))
    unavailable();
  const selection = { dataRoot: attempt.dataRoot, capsuleId };
  const directory = await extensionRecoveryDirectory({
    selection,
    create: false,
  });
  for (const file of ["plugin-bindings.json", "plugin-assets.json"] as const) {
    const pin = manifest?.files.find((value) => value.file === file);
    if (manifest !== null && pin === undefined) unavailable();
    const bytes = await readExtensionRecoveryFile({
      selection,
      file,
      expectedDigest: pin?.digest,
    });
    if (file === "plugin-bindings.json") {
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as {
        bindings?: {
          provider?: {
            kind?: unknown;
            endpoint?: unknown;
            apiKeyEnvironment?: unknown;
          };
        }[];
      };
      if (!Array.isArray(value.bindings)) unavailable();
      if (
        value.bindings.some(
          ({ provider }) =>
            provider?.kind === "directResponses" &&
            provider.apiKeyEnvironment === "CREWON_MODEL_API_KEY" &&
            (typeof provider.endpoint !== "string" ||
              new URL(provider.endpoint).href !==
                attempt.providerBinding.responsesEndpoint),
        )
      )
        return withoutCurrentPluginInputs(
          environments,
          "extension_recovery_current_provider_mismatch",
        );
      if (
        value.bindings.some(
          ({ provider }) =>
            provider?.kind === "directResponses" &&
            provider.apiKeyEnvironment === "CREWON_MODEL_API_KEY",
        ) &&
        !environments.worker.CREWON_MODEL_API_KEY?.trim()
      )
        return withoutCurrentPluginInputs(
          environments,
          "extension_recovery_current_credential_unavailable",
        );
    }
  }
  return {
    environments: {
      ...environments,
      worker: {
        ...environments.worker,
        CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: join(
          directory,
          "plugin-bindings.json",
        ),
        CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: join(
          directory,
          "plugin-assets.json",
        ),
      },
    },
    candidate:
      manifest !== null &&
      same(manifest.providerBinding, attempt.providerBinding)
        ? manifest
        : null,
    reasonCode:
      report.outcome === "unsupported"
        ? report.reasonCode
        : manifest !== null &&
            !same(manifest.providerBinding, attempt.providerBinding)
          ? "extension_recovery_provider_mismatch"
          : null,
  };
}

export type DesktopExtensionRecoveryHostVerification = Readonly<{
  dataRoot: string;
  manifest: ExtensionRecoveryManifest;
  origin: string;
  token: string;
  signal: AbortSignal;
  deadlineMs: number;
  /** Historical verification uses only the manifest returned by that owned old host. */
  catalog?: readonly DesktopExtensionHostCatalogRegistration[];
}>;

/** Complete is published only after the actual owned Worker attests every exact target. */
export async function completeDesktopExtensionRecovery(
  request: DesktopExtensionRecoveryHostVerification,
): Promise<
  Readonly<
    | { outcome: "ready" }
    | {
        outcome: "unavailable";
        reasonCode: "desktop_extension_recovery_unavailable";
      }
  >
> {
  const input = Object.freeze({ ...request });
  try {
    const manifest = await verifyDesktopExtensionRecoveryHost(input);
    await commitExtensionRecoveryCapsule({
      selection: { dataRoot: input.dataRoot, capsuleId: manifest.capsuleId },
      manifest,
    });
    return { outcome: "ready" };
  } catch {
    input.signal.throwIfAborted();
    return {
      outcome: "unavailable",
      reasonCode: "desktop_extension_recovery_unavailable",
    };
  }
}

/** Reusable attestation for an owned current or retained Worker; never publishes a capsule. */
export async function verifyDesktopExtensionRecoveryHost(
  request: DesktopExtensionRecoveryHostVerification,
): Promise<ExtensionRecoveryManifest> {
  const input = Object.freeze({ ...request });
  if (
    !/^[a-f0-9]{64}$/u.test(input.token) ||
    !Number.isSafeInteger(input.deadlineMs) ||
    input.deadlineMs < 1000 ||
    input.deadlineMs > 30_000
  )
    unavailable();
  const origin = parseDesktopExtensionHostOrigin(input.origin);
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.deadlineMs),
  ]);
  signal.throwIfAborted();
  const manifest = parseExtensionRecoveryManifest(input.manifest);
  if (!same(manifest.owner, DESKTOP_RUNTIME_OWNER)) unavailable();
  const build = await resolveRetainedExtensionBuild({
    dataRoot: input.dataRoot,
    implementationDigest: manifest.implementationDigest,
    expectedBuildIdentityDigest: manifest.buildIdentityDigest,
  });
  if (build.historicalWorkItemScope !== EXTENSION_HISTORICAL_WORK_ITEM_SCOPE)
    unavailable();
  const selection = {
    dataRoot: input.dataRoot,
    capsuleId: manifest.capsuleId,
  };
  const directory = await extensionRecoveryDirectory({
    selection,
    create: false,
  });
  const value = (await pinnedJson(
    selection,
    manifest,
    "plugin-bindings.json",
  )) as {
    bindings?: { agentVersionId?: unknown; extensionConfigPath?: unknown }[];
  };
  const bindings = value.bindings;
  if (
    !Array.isArray(bindings) ||
    bindings.length !== manifest.targets.length ||
    new Set(bindings.map((binding) => binding.agentVersionId)).size !==
      bindings.length
  )
    unavailable();
  const requests: ExtensionHostRequest[] = [];
  for (const [index, binding] of bindings.entries()) {
    signal.throwIfAborted();
    const file = `snapshot-${String(index).padStart(2, "0")}.json` as const;
    if (binding.extensionConfigPath !== join(directory, file)) unavailable();
    const snapshot = (await pinnedJson(selection, manifest, file)) as {
      schemaVersion?: unknown;
      configuration?: unknown;
      approvalRequirement?: unknown;
    };
    const configuration = parseExtensionConfiguration(snapshot.configuration, {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    });
    const registration = {
      pluginId: configuration.pluginId,
      pluginVersion: configuration.pluginVersion,
      manifestDigest: configuration.manifestDigest,
      implementationDigest: configuration.implementationDigest,
    };
    if (
      configuration.tenantId !== manifest.owner.tenantId ||
      configuration.spaceId !== manifest.owner.spaceId ||
      !manifest.registrations.some((candidate) => same(candidate, registration))
    )
      unavailable();
    if (input.catalog !== undefined) {
      const observed = input.catalog.find((candidate) =>
        same(
          {
            pluginId: candidate.manifest.pluginId,
            pluginVersion: candidate.manifest.version,
            manifestDigest: candidate.manifestDigest,
            implementationDigest: candidate.implementationDigest,
          },
          registration,
        ),
      );
      const expected = manifest.targets.find(
        (target) => target.agentVersionId === binding.agentVersionId,
      );
      if (
        !observed ||
        !expected ||
        snapshot.schemaVersion !== "crewon.extension-runtime-config.v0" ||
        (snapshot.approvalRequirement !== "none" &&
          snapshot.approvalRequirement !== "perAction")
      )
        unavailable();
      const materialization = `sha256:${createHash("sha256")
        .update(
          extensionCanonicalJson({
            schemaVersion: "crewon.agent-version-materialization.v0",
            binding,
            extension: {
              schemaVersion: "crewon.extension-runtime-config.v0",
              configuration,
              approvalRequirement: snapshot.approvalRequirement,
              registration: observed,
            },
            mcpStdioConfig: null,
            deviceToolConfig: null,
            remoteMcpConfig: null,
          }),
        )
        .digest("hex")}`;
      if (materialization !== expected.materializationDigest) unavailable();
    }
    requests.push(
      parseExtensionHostRequest({
        protocol: "crewon.extension-host-request.v0",
        operation: "readiness",
        actor: manifest.owner,
        registration,
        configuration,
        agentVersionId: binding.agentVersionId,
      }),
    );
  }
  for (let index = 0; index < requests.length; index += 4) {
    const results = await Promise.allSettled(
      requests.slice(index, index + 4).map(async (request) => {
        const response = await privateReadiness(
          origin,
          input.token,
          request,
          signal,
        );
        if (
          request.operation !== "readiness" ||
          response.operation !== "readiness" ||
          !same(response.actor, manifest.owner) ||
          !same(response.registration, request.registration) ||
          response.configurationDigest !==
            (request.configuration as { contentDigest: string })
              .contentDigest ||
          response.agentVersionId !== request.agentVersionId ||
          response.result.outcome !== "ready"
        )
          unavailable();
        const expected = manifest.targets.find(
          (target) => target.agentVersionId === request.agentVersionId,
        );
        if (
          !expected ||
          !same(parseExtensionExecutionTarget(response.result.target), expected)
        )
          unavailable();
      }),
    );
    if (results.some((result) => result.status === "rejected")) unavailable();
  }
  signal.throwIfAborted();
  return manifest;
}

async function pinnedJson(
  selection: ExtensionRecoverySelection,
  manifest: ExtensionRecoveryManifest,
  file: Parameters<typeof readExtensionRecoveryFile>[0]["file"],
): Promise<unknown> {
  const pin = manifest.files.find((pin) => pin.file === file);
  if (pin === undefined) unavailable();
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await readExtensionRecoveryFile({
        selection,
        file,
        expectedDigest: pin.digest,
      }),
    ),
  );
}

async function privateReadiness(
  origin: string,
  token: string,
  request: ExtensionHostRequest,
  signal: AbortSignal,
) {
  const response = await fetch(`${origin}${EXTENSION_HOST_PRIVATE_PATH}`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/json"
  ) {
    await response.body?.cancel();
    unavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) unavailable();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > EXTENSION_HOST_WIRE_LIMITS.messageBytes) unavailable();
      chunks.push(chunk.value);
    }
    return parseExtensionHostResponse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function same(left: unknown, right: unknown): boolean {
  return extensionCanonicalJson(left) === extensionCanonicalJson(right);
}
function withoutCurrentPluginInputs(
  environments: DesktopExtensionRuntimeEnvironments,
  reasonCode: string,
): DesktopExtensionRecoveryPrepared {
  const worker = { ...environments.worker };
  const release = { ...environments.release };
  delete worker.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH;
  delete worker.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH;
  delete release.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH;
  delete release.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH;
  return {
    environments: { ...environments, release, worker },
    candidate: null,
    reasonCode,
  };
}
function unavailable(): never {
  throw new Error("desktop_extension_recovery_unavailable");
}
