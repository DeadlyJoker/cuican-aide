import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type {
  PostgresRuntimeAgentVersionReleaseConfig,
  StandaloneRuntimeAgentVersionReleaseConfig,
} from "./agent-version-release-composition.ts";
import {
  compileRuntimeAgentVersionRelease,
  type RuntimeAgentVersionReleasePlan,
} from "./agent-version-release.ts";
import {
  prepareInstalledPluginBindingsManifest,
  type InstalledPluginBindingsManifestArtifact,
  type InstalledPluginGeneratedBindingsManifest,
} from "./plugins/installed-plugin-release-bindings-manifest.ts";
import {
  assertInstalledPluginReleaseCliInput,
  type InstalledPluginReleaseCliInput,
} from "./plugins/installed-plugin-release-cli-input.ts";
import { verifyInstalledPluginReleaseInputs } from "./plugins/installed-plugin-release-loader.ts";
import { captureInstalledPluginPublicationBindings } from "./plugins/installed-plugin-release-publication-input.ts";
import {
  createInstalledPluginReleasePublication,
  type InstalledPluginReleasePublication,
  type InstalledPluginReleasePublicationResult,
} from "./plugins/installed-plugin-release-publication.ts";

type OwnedInput = Readonly<{
  /** Transferred on invocation, including compilation, connection and preflight failures. */
  ownedInstalledPluginCliInput: InstalledPluginReleaseCliInput;
  generatedBindingsManifest?: InstalledPluginGeneratedBindingsManifest;
}>;
export type InstalledPluginRuntimeReleaseActivationResult = Readonly<{
  plan: RuntimeAgentVersionReleasePlan;
  activation: InstalledPluginReleasePublicationResult["activation"];
  verification: InstalledPluginReleasePublicationResult["verification"];
}>;

export function activateStandaloneInstalledPluginAgentVersionRelease(
  config: StandaloneRuntimeAgentVersionReleaseConfig & OwnedInput,
): Promise<InstalledPluginRuntimeReleaseActivationResult> {
  return activate(config, async () => new SqliteRunStore(config.databasePath));
}

export function activatePostgresInstalledPluginAgentVersionRelease(
  config: PostgresRuntimeAgentVersionReleaseConfig & OwnedInput,
): Promise<InstalledPluginRuntimeReleaseActivationResult> {
  return activate(config, () =>
    PostgresDomainStore.open({
      connectionString: config.connectionString,
      schema: config.schema,
      maxPoolSize: config.maxPoolSize,
      statementTimeoutMs: config.statementTimeoutMs,
    }),
  );
}

async function activate(
  config: (
    | StandaloneRuntimeAgentVersionReleaseConfig
    | PostgresRuntimeAgentVersionReleaseConfig
  ) &
    OwnedInput,
  openStore: () => Promise<SqliteRunStore | PostgresDomainStore>,
): Promise<InstalledPluginRuntimeReleaseActivationResult> {
  const owned = config.ownedInstalledPluginCliInput;
  assertInstalledPluginReleaseCliInput(owned);
  let store: SqliteRunStore | PostgresDomainStore | undefined;
  let publisher: InstalledPluginReleasePublication | undefined;
  let manifest: InstalledPluginBindingsManifestArtifact | undefined;
  let result: InstalledPluginRuntimeReleaseActivationResult | undefined;
  let failed = false,
    failure: unknown;
  try {
    const runtimePlan = compileRuntimeAgentVersionRelease(config);
    const generatedManifest =
      config.generatedBindingsManifest === undefined
        ? undefined
        : Object.freeze({
            path: config.generatedBindingsManifest.path,
            config: captureInstalledPluginPublicationBindings({
              config: config.generatedBindingsManifest.config,
              release: owned.release,
              runtimePlan,
            }),
          });
    store = await openStore();
    await store.extensionStore().migrate();
    await store.pluginInstallationStore().migrate();
    publisher = createInstalledPluginReleasePublication({
      release: owned.release,
      runtimePlan,
      store,
      authorization: config.authorization,
      clock: config.clock,
    });
    await verifyInstalledPluginReleaseInputs({ release: owned.release, store });
    if (generatedManifest !== undefined)
      manifest =
        await prepareInstalledPluginBindingsManifest(generatedManifest);
    const committed = await publisher.publish({
      actor: config.actor,
      activationId: config.activationId,
    });
    result = Object.freeze({
      plan: committed.plan.runtime,
      activation: committed.activation,
      verification: committed.verification,
    });
    try {
      const current = await store.loadActiveAgentVersionRelease({
        tenantId: config.actor.tenantId,
      });
      if (current?.bundle.releaseId !== result.plan.bundle.releaseId)
        throw new Error("installed_plugin_release_publication_not_current");
      if (result.verification.outcome === "verified") await manifest?.publish();
    } catch (cause) {
      result = unavailable(result, cause);
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  // Join the publication and its owned file work before retiring metadata/network authority or the database.
  const cleanupErrors: unknown[] = [];
  for (const owner of [
    publisher,
    manifest,
    owned.release,
    owned.authority,
    store,
  ]) {
    try {
      await owner?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failed) throw failure;
  if (result === undefined)
    throw new Error("installed_plugin_release_publication_result_missing");
  for (const error of cleanupErrors) result = unavailable(result, error);
  return result;
}

function unavailable(
  result: InstalledPluginRuntimeReleaseActivationResult,
  cause: unknown,
): InstalledPluginRuntimeReleaseActivationResult {
  return Object.freeze({
    ...result,
    verification: Object.freeze({
      outcome: "unavailable" as const,
      cause:
        result.verification.outcome === "unavailable"
          ? new AggregateError(
              [result.verification.cause, cause],
              "installed_plugin_release_verification_unavailable",
            )
          : cause,
    }),
  });
}
