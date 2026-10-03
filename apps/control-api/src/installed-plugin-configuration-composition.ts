import {
  ApplicationError,
  ExtensionConfigurationApplicationService,
  ExtensionReadApplicationService,
  type ApplicationClock,
  type AuthorizationPort,
  type ContentDigester,
  type PluginInstallationHostProfilePort,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginProfileScope,
} from "@crewon/domain";
import { PostgresDomainStore } from "@crewon/store";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import { InstalledPluginTaskHttpAuthority } from "./installed-plugin-credit-quote-authority.ts";
import {
  bindInstalledPluginRequestOwner,
  InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import { InstalledPluginConfigurationMetadata } from "./installed-plugin-configuration-metadata.ts";
import {
  assertInstalledPluginConfigurationConfig,
  type InstalledPluginConfigurationConfig,
} from "./installed-plugin-configuration-environment.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

export type InstalledPluginConfigurationRuntime = Readonly<{
  requests: InstalledPluginRequestOwner;
  extensions: ExtensionConfigurationApplicationService;
  extensionReads: ExtensionReadApplicationService;
  close(): Promise<void>;
}>;

/** Metadata bootstrap owns no execution, task, quotation, credit, or Node service. */
export async function createInstalledPluginConfigurationRuntime(
  configuration: InstalledPluginConfigurationConfig,
  dependencies: Readonly<{
    store: PostgresDomainStore;
    identity: ProductionControlApiIdentity;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    digester: ContentDigester;
    fetch?: typeof globalThis.fetch;
  }>,
): Promise<InstalledPluginConfigurationRuntime> {
  assertInstalledPluginConfigurationConfig(configuration);
  if (
    !(dependencies.store instanceof PostgresDomainStore) ||
    !(dependencies.identity instanceof ProductionControlApiIdentity)
  )
    throw new Error("installed_plugin_configuration_composition_invalid");
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: configuration.timeoutMs,
    fetch: dependencies.fetch,
  });
  let requests: InstalledPluginRequestOwner | undefined;
  let metadata: InstalledPluginConfigurationMetadata | undefined;
  const current = () => {
    if (requests === undefined) denied();
    return requests;
  };
  try {
    const ledger = dependencies.store.pluginInstallationStore();
    await ledger.migrate();
    const extensions = dependencies.store.extensionStore();
    await extensions.migrate();
    const profiles: PluginInstallationHostProfilePort = Object.freeze({
      resolve: async (
        value: Parameters<PluginInstallationHostProfilePort["resolve"]>[0],
      ) => {
        const actor = pluginSecurityActor(value);
        if (!same(actor, current().currentActor())) denied();
        const scope = parsePluginProfileScope(
          await http.post(
            configuration.profileAuthority,
            { actor },
            current().currentSignal(),
          ),
        );
        if (
          scope.tenantId !== actor.tenantId ||
          scope.spaceId !== actor.spaceId
        )
          denied();
        return scope;
      },
    });
    metadata = new InstalledPluginConfigurationMetadata({
      installRoot: configuration.installRoot,
      installations: ledger,
      maximumPackages: configuration.maximumPackages,
      authorizeRead: async ({ actor, scope, candidate }, signal) => {
        if (!same(pluginSecurityActor(actor), current().currentActor()))
          denied();
        await current().assertCurrent();
        const result = pluginSecurityRecord(
          await http.post(
            configuration.packageAuthority,
            {
              schemaVersion: "crewon.plugin-execution-package.v1",
              identity: {
                pluginId: candidate.descriptor.pluginId,
                publisherId: candidate.descriptor.publisherId,
                version: candidate.descriptor.version,
                packageDigest: candidate.packageDigest,
              },
              scope,
              purpose: "read",
            },
            AbortSignal.any([signal, current().currentSignal()]),
          ),
          ["outcome"],
        );
        await current().assertCurrent();
        if (result.outcome !== "allow" && result.outcome !== "deny") denied();
        return result.outcome;
      },
    });
    requests = new InstalledPluginRequestOwner({
      identity: dependencies.identity,
      profiles,
      metadata,
    });
    const authorize = dependencies.authorization.authorize.bind(
      dependencies.authorization,
    );
    const authorization: AuthorizationPort = Object.freeze({
      authorize: async (
        value: Parameters<AuthorizationPort["authorize"]>[0],
      ) => {
        if (!same(pluginSecurityActor(value.actor), current().currentActor()))
          denied();
        await current().assertCurrent();
        const result = await authorize(value);
        await current().assertCurrent();
        return result;
      },
    });
    const configurationService = bindInstalledPluginRequestOwner(
      new ExtensionConfigurationApplicationService({
        store: extensions,
        catalog: requests.catalog,
        host: requests.host,
        authorization,
        clock: dependencies.clock,
        digester: dependencies.digester,
      }),
      requests,
      { preparation: "configuration" },
    );
    const reads = bindInstalledPluginRequestOwner(
      new ExtensionReadApplicationService({
        runs: dependencies.store,
        agentVersions: dependencies.store,
        extensions,
        operations: dependencies.store.externalOperationStore(),
        catalog: requests.catalog,
        host: requests.host,
        authorization,
        digester: dependencies.digester,
      }),
      requests,
      { preparation: "configuration" },
    );
    const actualRequests = requests,
      actualMetadata = metadata;
    let closing: Promise<void> | null = null;
    return Object.freeze({
      requests: actualRequests,
      extensions: configurationService,
      extensionReads: reads,
      close: () =>
        (closing ??= closeAll([
          () => actualRequests.close(),
          () => actualMetadata.close(),
          () => http.close(),
        ])),
    });
  } catch (error) {
    try {
      await closeAll([
        () => requests?.close(),
        () => metadata?.close(),
        () => http.close(),
      ]);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "installed_plugin_configuration_startup_cleanup_failed",
      );
    }
    throw error;
  }
}
async function closeAll(
  actions: readonly (() => Promise<void> | undefined)[],
): Promise<void> {
  const results = await Promise.allSettled(
    actions.map((action) => {
      try {
        return Promise.resolve(action());
      } catch (error) {
        return Promise.reject(error);
      }
    }),
  );
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (failures.length)
    throw new AggregateError(
      failures,
      "installed_plugin_configuration_cleanup_failed",
    );
}
function same(left: unknown, right: unknown) {
  return extensionCanonicalJson(left) === extensionCanonicalJson(right);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "installed_plugin_configuration_authority_denied",
  );
}
