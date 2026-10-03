import {
  ApplicationError,
  ExtensionConfigurationApplicationService,
  ExtensionReadApplicationService,
  ExtensionTaskApplicationService,
  type AuthorizationPort,
  type ActorContext,
  type ApplicationClock,
  type ApplicationIdGenerator,
  type ContentDigester,
  type DomainStore,
  type ExtensionCatalogPort,
  type ExtensionStore,
  type ExternalOperationStore,
  type ExternalOperationQueryStore,
  type PluginQueryHostPort,
} from "@crewon/application";
import type { DesktopPluginConfigurationRuntime } from "./desktop-plugin-configuration-runtime.ts";
import { bindInstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { ExtensionHostRouter } from "./extension-host-router.ts";

type ConfigurationDependencies = ConstructorParameters<
  typeof ExtensionConfigurationApplicationService
>[0];
export type DesktopPluginNamespaceMembership = (
  actor: ActorContext,
  pluginId: string,
) => Promise<boolean>;

/** Optional service composition keeps the default path synchronous and free of plugin I/O. */
export function composeStandaloneExtensionServices(
  input: Readonly<{
    store: DomainStore;
    legacy?: Readonly<{
      client: ExtensionHostRouter;
      catalog: ExtensionCatalogPort;
      extensions: ExtensionStore;
      operations: ExternalOperationStore & ExternalOperationQueryStore;
    }>;
    native?: Readonly<{
      installed: DesktopPluginConfigurationRuntime;
      approvedPluginIds: readonly string[];
      ownsNamespace: DesktopPluginNamespaceMembership;
    }>;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    digester: ContentDigester;
    ids: ApplicationIdGenerator;
    pluginQueryHost?: PluginQueryHostPort;
  }>,
) {
  const { legacy, native, store, authorization, clock, digester, ids } = input;
  if (legacy === undefined) {
    return {
      extensions: native?.installed.extensions,
      extensionReads: native?.installed.extensionReads,
      extensionTasks: undefined,
    };
  }
  const configuration: ConfigurationDependencies = {
    store: legacy.extensions,
    catalog: legacy.catalog,
    host: legacy.client,
    authorization,
    clock,
    digester,
  };
  const reads: ReadDependencies = {
    runs: store,
    agentVersions: store,
    extensions: legacy.extensions,
    operations: legacy.operations,
    catalog: legacy.catalog,
    host: legacy.client,
    authorization,
    digester,
  };
  const services =
    native === undefined
      ? {
          extensions: new ExtensionConfigurationApplicationService(
            configuration,
          ),
          extensionReads: new ExtensionReadApplicationService(reads),
        }
      : composeDesktopPluginExtensionServices({
          ...native,
          legacyConfiguration: configuration,
          legacyReads: reads,
        });
  return {
    ...services,
    extensionTasks: new ExtensionTaskApplicationService({
      store,
      extensions: legacy.extensions,
      operations: legacy.operations,
      catalog: legacy.catalog,
      host: legacy.client,
      queryHost: legacy.client.queryHost,
      ...(input.pluginQueryHost === undefined
        ? {}
        : { pluginQueryHost: input.pluginQueryHost }),
      authorization:
        native === undefined
          ? authorization
          : desktopLegacyTaskAuthorization(authorization, native.ownsNamespace),
      clock,
      ids,
      digester,
    }),
  };
}
type ReadDependencies = ConstructorParameters<
  typeof ExtensionReadApplicationService
>[0];

/** Even historical v0 query peers cannot execute a newly reserved installed namespace. */
export function desktopLegacyTaskAuthorization(
  authorization: AuthorizationPort,
  ownsNamespace: DesktopPluginNamespaceMembership,
): AuthorizationPort {
  const authorize = authorization.authorize.bind(authorization);
  return Object.freeze({
    authorize: async (input: Parameters<AuthorizationPort["authorize"]>[0]) => {
      if (
        input.resource.kind === "extension" &&
        (await ownsNamespace(input.actor, input.resource.pluginId))
      ) {
        return {
          outcome: "deny" as const,
          reasonCode: "desktop_plugin_execution_authority_unavailable",
        };
      }
      return authorize(input);
    },
  });
}

/** Approved installed namespaces never fall through to the old worker catalog. */
export function composeDesktopPluginExtensionServices(
  input: Readonly<{
    installed: DesktopPluginConfigurationRuntime;
    approvedPluginIds: readonly string[];
    ownsNamespace: DesktopPluginNamespaceMembership;
    legacyConfiguration: ConfigurationDependencies;
    legacyReads: ReadDependencies;
  }>,
) {
  const namespaces = new Set(input.approvedPluginIds);
  for (const entry of input.legacyReads.catalog.list()) {
    if (namespaces.has(entry.manifest.pluginId)) {
      throw new Error("desktop_plugin_extension_namespace_conflict");
    }
  }
  return Object.freeze({
    extensions: bindInstalledPluginRequestOwner(
      new DesktopConfigurationServices(
        input.legacyConfiguration,
        input.installed.extensions,
        input.ownsNamespace,
      ),
      input.installed.requests,
      { preparation: "configuration" },
    ),
    extensionReads: bindInstalledPluginRequestOwner(
      new DesktopReadServices(
        input.legacyReads,
        input.installed.extensionReads,
        input.ownsNamespace,
      ),
      input.installed.requests,
      { preparation: "configuration" },
    ),
  });
}

class DesktopConfigurationServices extends ExtensionConfigurationApplicationService {
  readonly #installed: ExtensionConfigurationApplicationService;
  readonly #ownsNamespace: DesktopPluginNamespaceMembership;
  constructor(
    dependencies: ConfigurationDependencies,
    installed: ExtensionConfigurationApplicationService,
    ownsNamespace: DesktopPluginNamespaceMembership,
  ) {
    super(dependencies);
    this.#installed = installed;
    this.#ownsNamespace = ownsNamespace;
  }
  override async getConfiguration(
    ...args: Parameters<
      ExtensionConfigurationApplicationService["getConfiguration"]
    >
  ) {
    return (await this.#ownsNamespace(args[0], args[1].pluginId))
      ? this.#installed.getConfiguration(...args)
      : super.getConfiguration(...args);
  }
  override async getActivation(
    ...args: Parameters<
      ExtensionConfigurationApplicationService["getActivation"]
    >
  ) {
    return (await this.#ownsNamespace(args[0], args[1]))
      ? this.#installed.getActivation(...args)
      : super.getActivation(...args);
  }
  override async saveConfiguration(
    ...args: Parameters<
      ExtensionConfigurationApplicationService["saveConfiguration"]
    >
  ) {
    return (await this.#ownsNamespace(args[0], args[1].pluginId))
      ? this.#installed.saveConfiguration(...args)
      : super.saveConfiguration(...args);
  }
  override async setActivation(
    ...args: Parameters<
      ExtensionConfigurationApplicationService["setActivation"]
    >
  ) {
    return (await this.#ownsNamespace(args[0], args[1].pluginId))
      ? this.#installed.setActivation(...args)
      : super.setActivation(...args);
  }
}

class DesktopReadServices extends ExtensionReadApplicationService {
  readonly #installed: ExtensionReadApplicationService;
  readonly #ownsNamespace: DesktopPluginNamespaceMembership;
  constructor(
    dependencies: ReadDependencies,
    installed: ExtensionReadApplicationService,
    ownsNamespace: DesktopPluginNamespaceMembership,
  ) {
    super(dependencies);
    this.#installed = installed;
    this.#ownsNamespace = ownsNamespace;
  }
  override async getCatalog(
    ...args: Parameters<ExtensionReadApplicationService["getCatalog"]>
  ) {
    const legacy = await super.getCatalog(...args);
    const installed = await this.#installed.getCatalog(...args);
    const extensions = [...legacy.extensions, ...installed.extensions];
    if (extensions.length > 32) {
      throw new ApplicationError("internal", "extension_catalog_invalid");
    }
    return { extensions };
  }
  override async getRuntime(
    ...args: Parameters<ExtensionReadApplicationService["getRuntime"]>
  ) {
    return (await this.#ownsNamespace(args[0], args[1].pluginId))
      ? this.#installed.getRuntime(...args)
      : super.getRuntime(...args);
  }
  override async getTask(
    ...args: Parameters<ExtensionReadApplicationService["getTask"]>
  ) {
    return (await this.#ownsNamespace(args[0], args[1].pluginId))
      ? this.#installed.getTask(...args)
      : super.getTask(...args);
  }
}
