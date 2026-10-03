import type { ActorContext } from "@crewon/application";
import { extensionOpaqueId } from "@crewon/domain";
import {
  createInstalledPluginWorkerAuthority,
  type InstalledPluginWorkerAuthority,
} from "./installed-plugin-worker-authority.ts";
import {
  INSTALLED_PLUGIN_WORKER_CONFIG_ENV,
  loadInstalledPluginWorkerConfig,
} from "./installed-plugin-worker-config.ts";
import { readInstalledPluginReleaseDocument } from "./installed-plugin-release-document.ts";
import {
  loadInstalledPluginRelease,
  type LoadedInstalledPluginRelease,
} from "./installed-plugin-release-loader.ts";

export type InstalledPluginReleaseCliInput = Readonly<{
  authority: InstalledPluginWorkerAuthority;
  release: LoadedInstalledPluginRelease;
}>;
const captured = new WeakSet<object>();
const actorFields = {
  CREWON_RELEASE_PRINCIPAL_ID: "principalId",
  CREWON_RELEASE_ACTOR_ID: "actorId",
  CREWON_TENANT_ID: "tenantId",
  CREWON_SPACE_ID: "spaceId",
} as const;
const legacyFields = [
  "CREWON_EXTENSION_RUNTIME_BINDINGS_PATH",
  "CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH",
  "CREWON_EXTENSION_HOST_PORT",
  "CREWON_EXTENSION_HOST_TOKEN",
  "CREWON_EXTENSION_HOST_DEADLINE_MS",
  "CREWON_EXTENSION_EXECUTION_MODE",
  "CREWON_EXTENSION_RECOVERY_ATTEMPT_ID",
  "CREWON_EXTENSION_RECOVERY_PROVIDER_JSON",
] as const;

function value(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const field = Object.getOwnPropertyDescriptor(environment, name);
  if (field === undefined) return undefined;
  if (
    !("value" in field) ||
    (field.value !== undefined && typeof field.value !== "string")
  )
    throw new Error("installed_plugin_release_environment_invalid");
  return field.value;
}

/** A private deployment opt-in; package read permission is separate from the original OS release operator's publish/deploy authority. */
export async function loadInstalledPluginReleaseCliInput(
  input: Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    actor: ActorContext;
    defaultAgentVersionId: string;
    signal?: AbortSignal;
  }>,
): Promise<InstalledPluginReleaseCliInput | null> {
  const path = value(input.environment, INSTALLED_PLUGIN_WORKER_CONFIG_ENV);
  if (path === undefined) return null;
  const legacyFlag = value(input.environment, "CREWON_EXTENSIONS_ENABLED");
  if (legacyFlag !== undefined && legacyFlag !== "0" && legacyFlag !== "1")
    throw new Error("installed_plugin_release_environment_invalid");
  if (
    legacyFlag === "1" ||
    legacyFields.some((name) => value(input.environment, name) !== undefined)
  )
    throw new Error("installed_plugin_release_legacy_runtime_conflict");
  for (const [name, field] of Object.entries(actorFields)) {
    const explicit = value(input.environment, name);
    if (
      explicit === undefined ||
      explicit !== explicit.trim() ||
      explicit !== input.actor[field as keyof ActorContext]
    )
      throw new Error("installed_plugin_release_operator_required");
    try {
      extensionOpaqueId(explicit);
    } catch {
      throw new Error("installed_plugin_release_operator_required");
    }
  }
  input.signal?.throwIfAborted();
  const config = loadInstalledPluginWorkerConfig(path, input.environment);
  const document = readInstalledPluginReleaseDocument(
    config.releaseDocumentPath,
  );
  if (
    document.tenantId !== input.actor.tenantId ||
    document.defaultAgentVersionId !== input.defaultAgentVersionId ||
    document.entries.some(
      (entry) => entry.scope.spaceId !== input.actor.spaceId,
    )
  )
    throw new Error("installed_plugin_release_bootstrap_mismatch");
  const authority = createInstalledPluginWorkerAuthority(config);
  let release: LoadedInstalledPluginRelease | undefined;
  try {
    release = await loadInstalledPluginRelease({
      document,
      installRoot: authority.installRoot,
      authorizeRead: authority.authorizeRead,
      environment: input.environment,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    input.signal?.throwIfAborted();
    const result = Object.freeze({ authority, release });
    captured.add(result);
    return result;
  } catch (error) {
    await Promise.allSettled([release?.close()]);
    await Promise.allSettled([authority.close()]);
    throw error;
  }
}

export function assertInstalledPluginReleaseCliInput(
  input: unknown,
): asserts input is InstalledPluginReleaseCliInput {
  if (!input || typeof input !== "object" || !captured.has(input))
    throw new Error("installed_plugin_release_cli_input_unverified");
}
