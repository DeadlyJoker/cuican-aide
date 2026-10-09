import { isDeepStrictEqual } from "node:util";
import {
  parseCompiledAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { ActorContext } from "@crewon/application";
import {
  NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_SCHEMA,
  parseNativeInstalledPluginPreparationResult,
  type NativeInstalledPluginPreparationResult,
  type NativeInstalledPluginPreparationStatus,
} from "@crewon/contracts/plugins";
import { extensionOpaqueId } from "@crewon/domain";
import {
  NativeCandidateBlocked,
  NativeCandidateMetadataOwner,
  type NativePreparedCandidate,
} from "./installed-plugin-native-candidate-state.ts";
import {
  INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA,
  loadNativeInstalledPluginPreparation,
  type LoadedNativeInstalledPluginPreparation,
} from "./installed-plugin-native-preparation-config.ts";
import { nativePreparationFailure as fail } from "./installed-plugin-native-preparation-files.ts";
import {
  assertNativeInstalledPluginModelPreparation,
  compileNativeInstalledPluginReleaseEntry,
  compileNativeInstalledPluginModelVariants,
} from "./installed-plugin-native-preparation-source.ts";
import {
  INSTALLED_PLUGIN_RELEASE_SCHEMA,
  installedPluginReleaseDigester,
  parseInstalledPluginReleaseDocument,
  type InstalledPluginReleaseDocument,
} from "./installed-plugin-release-document.ts";
import {
  loadInstalledPluginRelease,
  verifyInstalledPluginReleaseInputs,
  type LoadedInstalledPluginRelease,
} from "./installed-plugin-release-loader.ts";
import { ioJson, ioRecord } from "./plugin-execution-io-network.ts";

export type NativeInstalledPluginCandidatesInput = Readonly<{
  inputPath: string;
  environment: Readonly<Record<string, string | undefined>>;
  actor: ActorContext;
  bootstrapVersion: CompiledAgentVersion;
  defaultAgentVersionId: string;
  signal?: AbortSignal;
}>;
export type PreparedNativeInstalledPluginCandidates = Readonly<{
  result: NativeInstalledPluginPreparationResult;
  document: InstalledPluginReleaseDocument | null;
  documentPath: string | null;
  resultPath: string;
}>;

/** Prepares each actual installed candidate independently. This neither publishes nor executes any plugin. */
export async function prepareNativeInstalledPluginCandidates(
  input: NativeInstalledPluginCandidatesInput,
): Promise<PreparedNativeInstalledPluginCandidates> {
  const request = ioRecord(
    input,
    [
      "inputPath",
      "environment",
      "actor",
      "bootstrapVersion",
      "defaultAgentVersionId",
    ],
    ["signal"],
  );
  const loaded = loadNativeInstalledPluginPreparation({
    inputPath: request.inputPath as string,
    environment: request.environment as Readonly<
      Record<string, string | undefined>
    >,
    actor: request.actor as ActorContext,
  });
  if (
    loaded.configuration.schemaVersion !==
    INSTALLED_PLUGIN_NATIVE_CANDIDATES_SCHEMA
  )
    fail("configuration_invalid");
  const defaultAgentVersionId = extensionOpaqueId(
    request.defaultAgentVersionId,
  );
  const bootstrapVersion = parseCompiledAgentVersion(
    JSON.stringify(ioJson(request.bootstrapVersion, 1024 * 1024)),
    installedPluginReleaseDigester,
  );
  assertNativeInstalledPluginModelPreparation({
    bootstrapVersion,
    defaultAgentVersionId,
    environment: loaded.environment,
  });
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal))
    fail("signal_invalid");
  const signal =
    (request.signal as AbortSignal | undefined) ?? new AbortController().signal;
  signal.throwIfAborted();
  const owner = new NativeCandidateMetadataOwner(loaded, signal),
    prepared = new Map<string, NativePreparedCandidate>(),
    statuses = new Map<string, NativeInstalledPluginPreparationStatus>();
  let output: PreparedNativeInstalledPluginCandidates | null = null;
  let failed = false,
    failure: unknown;
  try {
    await owner.open();
    for (const plugin of loaded.configuration.plugins) {
      try {
        const row = await prepareCandidate({
          loaded,
          owner,
          plugin,
          bootstrapVersion,
          defaultAgentVersionId,
          signal,
        });
        prepared.set(plugin.pluginId, row);
        statuses.set(plugin.pluginId, preparedStatus(row));
      } catch (error) {
        if (!(error instanceof NativeCandidateBlocked)) throw error;
        statuses.set(plugin.pluginId, blockedStatus(plugin.pluginId, error));
      }
    }
    // Each retry removes at least one candidate permanently; at most 32 removals can occur.
    for (let round = 0; round <= loaded.configuration.plugins.length; round++) {
      await recheckCandidates(owner, prepared, statuses);
      const document =
        prepared.size === 0
          ? null
          : parseInstalledPluginReleaseDocument({
              schemaVersion: INSTALLED_PLUGIN_RELEASE_SCHEMA,
              tenantId: loaded.configuration.scope.tenantId,
              defaultAgentVersionId,
              entries: [...prepared.values()].flatMap((row) => row.entries),
            });
      const result = parseNativeInstalledPluginPreparationResult({
        schemaVersion: NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_SCHEMA,
        actor: loaded.configuration.actor,
        scope: loaded.configuration.scope,
        defaultAgentVersionId,
        plugins: loaded.configuration.plugins.map(
          (plugin) => statuses.get(plugin.pluginId)!,
        ),
      });
      if (document !== null)
        loaded.files.publish(loaded.documentPath, JSON.stringify(document));
      loaded.files.publish(loaded.resultPath, JSON.stringify(result));
      if (await recheckCandidates(owner, prepared, statuses)) {
        loaded.files.discardOutput();
        continue;
      }
      output = Object.freeze({
        result,
        document,
        documentPath: document === null ? null : loaded.documentPath,
        resultPath: loaded.resultPath,
      });
      break;
    }
    if (output === null) fail("state_changed");
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await owner.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    signal.throwIfAborted();
    loaded.files.assertCurrent();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed || cleanupErrors.length > 0) {
    try {
      loaded.files.discardOutput();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        [...(failed ? [failure] : []), ...cleanupErrors],
        "installed_plugin_native_candidates_failed",
      );
    throw failure;
  }
  if (output === null) fail("result_missing");
  return output;
}

async function prepareCandidate(
  input: Readonly<{
    loaded: LoadedNativeInstalledPluginPreparation;
    owner: NativeCandidateMetadataOwner;
    plugin: LoadedNativeInstalledPluginPreparation["configuration"]["plugins"][number];
    bootstrapVersion: CompiledAgentVersion;
    defaultAgentVersionId: string;
    signal: AbortSignal;
  }>,
): Promise<NativePreparedCandidate> {
  const { loaded, owner, signal } = input;
  const facts = await owner.facts(input.plugin.pluginId);
  const registration = await owner.registration(facts);
  const configuration = owner.validate(registration, facts);
  const compilation = {
    bootstrapVersion: input.bootstrapVersion,
    defaultAgentVersionId: input.defaultAgentVersionId,
    environment: loaded.environment,
    scope: loaded.configuration.scope,
    registration,
    configuration,
    approvalRequirement: input.plugin.approvalRequirement,
  };
  const entries =
    "nativeAuthorityPath" in loaded.worker
      ? compileNativeInstalledPluginModelVariants(compilation)
      : [compileNativeInstalledPluginReleaseEntry(compilation)];
  const entry = entries[0]!;
  const document = parseInstalledPluginReleaseDocument({
    schemaVersion: INSTALLED_PLUGIN_RELEASE_SCHEMA,
    tenantId: loaded.configuration.scope.tenantId,
    defaultAgentVersionId: input.defaultAgentVersionId,
    entries,
  });
  let release: LoadedInstalledPluginRelease | null = null;
  try {
    release = await owner.packageRead(() =>
      loadInstalledPluginRelease({
        document,
        installRoot: loaded.worker.installRoot,
        environment: loaded.environment,
        signal,
        authorizeRead: async (request) => {
          if (
            request.purpose !== "read" ||
            !isDeepStrictEqual(request.scope, loaded.configuration.scope)
          )
            fail("scope_mismatch");
          return owner.authorizePackageRead(request.identity);
        },
      }),
    );
    try {
      await owner.packageRead(() =>
        verifyInstalledPluginReleaseInputs({
          release: release!,
          store: owner.store,
          signal,
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "installed_plugin_release_configuration_mismatch",
          "installed_plugin_release_package_missing",
          "installed_plugin_release_package_mismatch",
        ].includes(error.message)
      )
        throw new NativeCandidateBlocked("stateChanged");
      throw error;
    }
    const row = Object.freeze({
      facts: Object.freeze({ ...facts, configuration }),
      registration,
      entry,
      entries,
    });
    await owner.recheck(row);
    return row;
  } finally {
    await release?.close();
  }
}

async function recheckCandidates(
  owner: NativeCandidateMetadataOwner,
  prepared: Map<string, NativePreparedCandidate>,
  statuses: Map<string, NativeInstalledPluginPreparationStatus>,
): Promise<boolean> {
  await owner.current();
  let removed = false;
  for (const [pluginId, row] of prepared) {
    try {
      await owner.recheck(row);
    } catch (error) {
      if (!(error instanceof NativeCandidateBlocked)) throw error;
      prepared.delete(pluginId);
      statuses.set(pluginId, blockedStatus(pluginId, error));
      removed = true;
    }
  }
  await owner.current();
  for (const [pluginId, row] of prepared) {
    try {
      await owner.recheckFacts(row);
    } catch (error) {
      if (!(error instanceof NativeCandidateBlocked)) throw error;
      prepared.delete(pluginId);
      statuses.set(pluginId, blockedStatus(pluginId, error));
      removed = true;
    }
  }
  return removed;
}

function blockedStatus(
  pluginId: string,
  error: NativeCandidateBlocked,
): NativeInstalledPluginPreparationStatus {
  return Object.freeze({
    pluginId,
    state: "blocked",
    reasonCode: error.reasonCode,
  });
}
function preparedStatus(
  row: NativePreparedCandidate,
): NativeInstalledPluginPreparationStatus {
  const { entry } = row;
  return Object.freeze({
    pluginId: entry.packageIdentity.pluginId,
    state: "prepared",
    packageIdentity: entry.packageIdentity,
    configuration: Object.freeze({
      revision: entry.configuration.revision,
      contentDigest: entry.configuration.contentDigest,
    }),
    approvalRequirement: entry.approvalRequirement,
    target: entry.target,
  });
}
