import { isDeepStrictEqual } from "node:util";
import {
  parseCompiledAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { ActorContext } from "@crewon/application";
import {
  extensionOpaqueId,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  type ExtensionConfiguration,
  type InstalledPluginPackage,
  type PluginSelection,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import {
  loadInstalledPluginBusinessRegistration,
  revalidateInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
  type InstalledPluginBusinessRegistration,
} from "./installed-plugin-business-registration.ts";
import {
  assertNativeInstalledPluginPreparation,
  loadNativeInstalledPluginPreparation,
  INSTALLED_PLUGIN_NATIVE_PREPARATION_SCHEMA,
  parseNativePreparationActor,
} from "./installed-plugin-native-preparation-config.ts";
import { nativePreparationFailure as fail } from "./installed-plugin-native-preparation-files.ts";
import { compileNativeInstalledPluginReleaseEntry } from "./installed-plugin-native-preparation-source.ts";
import {
  loadInstalledPluginRelease,
  verifyInstalledPluginReleaseInputs,
  type LoadedInstalledPluginRelease,
} from "./installed-plugin-release-loader.ts";
import {
  INSTALLED_PLUGIN_RELEASE_SCHEMA,
  installedPluginReleaseDigester,
  parseInstalledPluginReleaseDocument,
  type InstalledPluginReleaseDocument,
  type InstalledPluginReleaseIdentity,
} from "./installed-plugin-release-document.ts";
import {
  createInstalledPluginWorkerAuthority,
  type InstalledPluginWorkerAuthority,
} from "./installed-plugin-worker-authority.ts";
import { ioJson, ioRecord } from "./plugin-execution-io-network.ts";

export {
  INSTALLED_PLUGIN_NATIVE_PREPARATION_ENV,
  loadNativeInstalledPluginPreparation,
} from "./installed-plugin-native-preparation-config.ts";

type Facts = Readonly<{
  selection: PluginSelection;
  installed: InstalledPluginPackage;
  configuration: ExtensionConfiguration;
}>;
type Prepared = Readonly<{
  facts: Facts;
  registration: InstalledPluginBusinessRegistration;
}>;

/** Generates operator inputs from actual Native records. Publication remains the original release CLI's job. */
export async function prepareNativeInstalledPluginRelease(
  input: Readonly<{
    inputPath: string;
    environment: Readonly<Record<string, string | undefined>>;
    actor: ActorContext;
    bootstrapVersion: CompiledAgentVersion;
    defaultAgentVersionId: string;
    signal?: AbortSignal;
  }>,
): Promise<
  Readonly<{ documentPath: string; document: InstalledPluginReleaseDocument }>
> {
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
    INSTALLED_PLUGIN_NATIVE_PREPARATION_SCHEMA
  )
    fail("configuration_invalid");
  const defaultAgentVersionId = extensionOpaqueId(
    request.defaultAgentVersionId,
  );
  const bootstrapVersion = parseCompiledAgentVersion(
    JSON.stringify(ioJson(request.bootstrapVersion, 1024 * 1024)),
    installedPluginReleaseDigester,
  );
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal))
    fail("signal_invalid");
  const signal =
    (request.signal as AbortSignal | undefined) ?? new AbortController().signal;
  signal.throwIfAborted();
  const { configuration, files, environment } = loaded;
  let authority: InstalledPluginWorkerAuthority | null = null;
  let store: SqliteRunStore | null = null;
  let release: LoadedInstalledPluginRelease | null = null;
  let result: Readonly<{
    documentPath: string;
    document: InstalledPluginReleaseDocument;
  }> | null = null;
  let failed = false,
    failure: unknown;
  const prepared: Prepared[] = [];

  const current = async (): Promise<void> => {
    signal.throwIfAborted();
    assertNativeInstalledPluginPreparation(loaded);
    if (authority === null) fail("authority_unavailable");
    const currentActor = await authority.installedPluginExecution.resolveActor(
      {
        tenantId: configuration.actor.tenantId,
        spaceId: configuration.actor.spaceId,
        actorId: configuration.actor.actorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      currentActor === null ||
      !isDeepStrictEqual(
        parseNativePreparationActor(currentActor),
        configuration.actor,
      )
    )
      fail("actor_changed");
    const profile = await authority.resolveProfile(configuration.actor, signal);
    signal.throwIfAborted();
    if (
      profile === null ||
      !isDeepStrictEqual(parsePluginProfileScope(profile), configuration.scope)
    )
      fail("profile_changed");
    assertNativeInstalledPluginPreparation(loaded);
  };
  const authorizeRead = async (
    identity: InstalledPluginReleaseIdentity,
  ): Promise<"allow"> => {
    await current();
    if (
      !configuration.approvedPackages.some((approved) =>
        isDeepStrictEqual(approved, identity),
      )
    )
      fail("package_not_approved");
    const decision = await authority!.authorizeRead(
      { identity, scope: configuration.scope, purpose: "read" },
      signal,
    );
    signal.throwIfAborted();
    if (decision !== "allow") fail("package_forbidden");
    const permission =
      await authority!.installedPluginExecution.authorization.authorize({
        actor: configuration.actor,
        action: "extension:read",
        resource: {
          kind: "extension",
          tenantId: configuration.scope.tenantId,
          spaceId: configuration.scope.spaceId,
          pluginId: identity.pluginId,
        },
      });
    signal.throwIfAborted();
    if (permission.outcome !== "allow") fail("read_forbidden");
    await current();
    return "allow";
  };
  const facts = async (pluginId: string): Promise<Facts> => {
    if (store === null) fail("store_unavailable");
    const rawSelection = await store
      .pluginInstallationStore()
      .loadSelection({ scope: configuration.scope, pluginId });
    signal.throwIfAborted();
    if (rawSelection === null) fail("selection_unavailable");
    const selection = parsePluginSelection(rawSelection);
    if (
      selection.state === "uninstalled" ||
      selection.selectedPackageDigest === null ||
      selection.pluginId !== pluginId ||
      !isDeepStrictEqual(scopeOf(selection), configuration.scope)
    )
      fail("selection_unavailable");
    const rawInstalled = await store.pluginInstallationStore().loadPackage({
      scope: configuration.scope,
      packageDigest: selection.selectedPackageDigest,
    });
    signal.throwIfAborted();
    if (rawInstalled === null) fail("package_unavailable");
    const installed = parseInstalledPluginPackage(rawInstalled);
    if (
      !isDeepStrictEqual(scopeOf(installed), configuration.scope) ||
      installed.pluginId !== pluginId ||
      installed.publisherId !== selection.publisherId ||
      installed.packageDigest !== selection.selectedPackageDigest ||
      !configuration.approvedPackages.some((approved) =>
        isDeepStrictEqual(approved, identityOf(installed)),
      )
    )
      fail("package_not_approved");
    const saved = await store
      .extensionStore()
      .loadLatestExtensionConfiguration({
        tenantId: configuration.scope.tenantId,
        spaceId: configuration.scope.spaceId,
        pluginId,
      });
    signal.throwIfAborted();
    if (saved === null) fail("configuration_unavailable");
    return Object.freeze({ selection, installed, configuration: saved });
  };
  const recheck = async (): Promise<void> => {
    await current();
    for (const row of prepared) {
      if (
        !isDeepStrictEqual(await facts(row.facts.installed.pluginId), row.facts)
      )
        fail("state_changed");
      await revalidateInstalledPluginBusinessRegistration(
        row.registration,
        signal,
      );
      if (
        !isDeepStrictEqual(await facts(row.facts.installed.pluginId), row.facts)
      )
        fail("state_changed");
    }
    await current();
  };
  try {
    authority = createInstalledPluginWorkerAuthority(loaded.worker);
    await current();
    files.assertCurrent();
    store = new SqliteRunStore(loaded.databasePath);
    for (const plugin of configuration.plugins) {
      const state = await facts(plugin.pluginId),
        identity = identityOf(state.installed);
      await authorizeRead(identity);
      const registration = await loadInstalledPluginBusinessRegistration({
        installRoot: loaded.worker.installRoot,
        expectedPluginId: identity.pluginId,
        expectedPublisherId: identity.publisherId,
        expectedVersion: identity.version,
        expectedPackageDigest: identity.packageDigest,
        signal,
        authorizeRead: async (candidate) => {
          const candidateIdentity = {
            pluginId: candidate.descriptor.pluginId,
            publisherId: candidate.descriptor.publisherId,
            version: candidate.descriptor.version,
            packageDigest: candidate.packageDigest,
          };
          if (!isDeepStrictEqual(candidateIdentity, identity))
            fail("package_changed");
          return authorizeRead(candidateIdentity);
        },
      });
      const saved = validateInstalledPluginConfiguration(
        registration,
        state.configuration,
      );
      if (
        saved.tenantId !== configuration.scope.tenantId ||
        saved.spaceId !== configuration.scope.spaceId
      )
        fail("scope_mismatch");
      prepared.push(
        Object.freeze({
          facts: Object.freeze({ ...state, configuration: saved }),
          registration,
        }),
      );
    }
    const document = parseInstalledPluginReleaseDocument({
      schemaVersion: INSTALLED_PLUGIN_RELEASE_SCHEMA,
      tenantId: configuration.scope.tenantId,
      defaultAgentVersionId,
      entries: prepared.map((row, index) =>
        compileNativeInstalledPluginReleaseEntry({
          bootstrapVersion,
          defaultAgentVersionId,
          environment,
          scope: configuration.scope,
          registration: row.registration,
          configuration: row.facts.configuration,
          approvalRequirement:
            configuration.plugins[index]!.approvalRequirement,
        }),
      ),
    });
    release = await loadInstalledPluginRelease({
      document,
      installRoot: loaded.worker.installRoot,
      environment,
      signal,
      authorizeRead: async (request) => {
        if (
          request.purpose !== "read" ||
          !isDeepStrictEqual(request.scope, configuration.scope)
        )
          fail("scope_mismatch");
        return authorizeRead(request.identity);
      },
    });
    await verifyInstalledPluginReleaseInputs({ release, store, signal });
    await recheck();
    files.publish(loaded.documentPath, JSON.stringify(document));
    await recheck();
    result = Object.freeze({ documentPath: loaded.documentPath, document });
  } catch (error) {
    failed = true;
    failure = error;
  }
  // Join all actual metadata/authority work before closing the borrowed SQLite parent connection.
  const cleanupErrors: unknown[] = [];
  for (const owner of [release, authority, store]) {
    try {
      await owner?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    signal.throwIfAborted();
    files.assertCurrent();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed || cleanupErrors.length > 0) {
    try {
      files.discardOutput();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        [...(failed ? [failure] : []), ...cleanupErrors],
        "installed_plugin_native_preparation_failed",
      );
    throw failure;
  }
  if (result === null) fail("result_missing");
  return result;
}

function scopeOf(input: {
  tenantId: string;
  spaceId: string;
  profileId: string;
}) {
  return {
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    profileId: input.profileId,
  };
}
function identityOf(
  input: InstalledPluginPackage,
): InstalledPluginReleaseIdentity {
  return {
    pluginId: input.pluginId,
    publisherId: input.publisherId,
    version: input.version,
    packageDigest: input.packageDigest,
  };
}
