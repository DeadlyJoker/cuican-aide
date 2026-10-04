import {
  ApplicationError,
  ExtensionConfigurationApplicationService,
  ExtensionReadApplicationService,
  type ApplicationClock,
  type ActorContext,
  type AuthorizationPort,
  type ContentDigester,
  type PluginInstallationHostProfilePort,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import {
  assertDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import {
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import {
  assertDesktopPluginSourceRegistry,
  type DesktopPluginSourceRegistry,
} from "./desktop-plugin-source-registry.ts";
import { InstalledPluginConfigurationMetadata } from "./installed-plugin-configuration-metadata.ts";
import {
  bindInstalledPluginRequestOwner,
  InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { DesktopInstalledPluginActivationOwner } from "./desktop-installed-plugin-activation-owner.ts";
import { createDesktopPluginHistoryAuthorization } from "./desktop-plugin-history-authorization.ts";

export type DesktopPluginConfigurationRuntime = Readonly<{
  requests: InstalledPluginRequestOwner;
  extensions: ExtensionConfigurationApplicationService;
  extensionReads: ExtensionReadApplicationService;
  historyAuthorization?: AuthorizationPort;
  close(): Promise<void>;
}>;

type RuntimeBinding = Readonly<{
  configuration: DesktopPluginConfiguration;
  registry: DesktopPluginSourceRegistry;
  authority: DesktopPluginAuthority;
  installation: DesktopPluginInstallationRuntime;
  activation: DesktopInstalledPluginActivationOwner | undefined;
  store: SqliteRunStore;
}>;
const runtimes = new WeakMap<
  object,
  RuntimeBinding & Readonly<{ assertActive(): void }>
>();

/** An execution borrower must share the actual Native request/peer owner, not a copied runtime DTO. */
export function assertDesktopPluginConfigurationRuntime(
  value: unknown,
  binding: RuntimeBinding,
): asserts value is DesktopPluginConfigurationRuntime {
  const issued =
    value !== null && typeof value === "object"
      ? runtimes.get(value)
      : undefined;
  if (
    issued === undefined ||
    issued.registry !== binding.registry ||
    issued.authority !== binding.authority ||
    issued.installation !== binding.installation ||
    issued.activation !== binding.activation ||
    issued.store !== binding.store ||
    !same(
      issued.configuration,
      parseDesktopPluginConfiguration(binding.configuration),
    )
  )
    denied();
  issued.assertActive();
  binding.authority.assertScope(
    issued.configuration.actor,
    issued.configuration.scope,
  );
  binding.installation.assertProfileOwnership(issued.configuration.actor);
  issued.assertActive();
}

/** Native-owned SQLite configuration metadata, without execution or personal funding authority. */
export async function createDesktopPluginConfigurationRuntime(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    registry: DesktopPluginSourceRegistry;
    authority: DesktopPluginAuthority;
    installation: DesktopPluginInstallationRuntime;
    activation?: DesktopInstalledPluginActivationOwner;
    historyReads?: Readonly<{ kind: "project-generation-history" }>;
  }>,
  dependencies: Readonly<{
    store: SqliteRunStore;
    identity: StandaloneIdentity;
    clock: ApplicationClock;
    digester: ContentDigester;
  }>,
): Promise<DesktopPluginConfigurationRuntime> {
  const configuration = parseDesktopPluginConfiguration(input.configuration);
  const history =
    input.historyReads === undefined
      ? undefined
      : pluginSecurityRecord(input.historyReads, ["kind"]);
  if (history !== undefined && history.kind !== "project-generation-history")
    throw new Error("desktop_plugin_history_configuration_invalid");
  assertDesktopPluginSourceRegistry(input.registry, configuration);
  if (
    !(dependencies.store instanceof SqliteRunStore) ||
    !(dependencies.identity instanceof StandaloneIdentity) ||
    !(input.authority instanceof DesktopPluginAuthority) ||
    typeof dependencies.clock?.now !== "function" ||
    typeof dependencies.digester?.sha256 !== "function"
  )
    throw new Error("desktop_plugin_configuration_dependencies_invalid");
  const { authority, registry } = input;
  const activation = input.activation;
  const clock = Object.freeze({
    now: dependencies.clock.now.bind(dependencies.clock),
  });
  const digester = Object.freeze({
    sha256: dependencies.digester.sha256.bind(dependencies.digester),
  });
  const identity = dependencies.identity;
  authority.assertScope(configuration.actor, configuration.scope);
  assertDesktopPluginInstallationRuntime(input.installation, {
    configuration,
    registry,
    authority,
    store: dependencies.store,
  });
  const installation = input.installation;
  if (activation !== undefined) {
    if (!(activation instanceof DesktopInstalledPluginActivationOwner))
      denied();
    activation.assertBinding({
      configuration,
      registry,
      authority,
      installation,
      store: dependencies.store,
    });
  }
  const assertOwner = (actor: ActorContext) => {
    authority.assertScope(actor, configuration.scope);
    installation.assertProfileOwnership(actor);
    authority.assertScope(actor, configuration.scope);
    activation?.assertBinding({
      configuration,
      registry,
      authority,
      installation,
      store: dependencies.store,
    });
  };
  assertOwner(configuration.actor);
  let requests: InstalledPluginRequestOwner | undefined;
  let metadata: InstalledPluginConfigurationMetadata | undefined;
  const current = () => {
    if (requests === undefined) denied();
    return requests;
  };
  try {
    const ledger = dependencies.store.pluginInstallationStore();
    const extensions = dependencies.store.extensionStore();
    await extensions.migrate();
    assertOwner(configuration.actor);
    const profiles: PluginInstallationHostProfilePort = Object.freeze({
      resolve: async (
        value: Parameters<PluginInstallationHostProfilePort["resolve"]>[0],
      ) => {
        const actor = pluginSecurityActor(value);
        if (!same(actor, current().currentActor())) denied();
        const signal = current().currentSignal();
        signal.throwIfAborted();
        assertOwner(actor);
        const scope = await authority.profile(actor);
        signal.throwIfAborted();
        authority.assertScope(actor, scope);
        assertOwner(actor);
        return scope;
      },
    });
    metadata = new InstalledPluginConfigurationMetadata({
      installRoot: configuration.installRoot,
      installations: ledger,
      maximumPackages: 32,
      authorizeRead: async ({ actor, scope, candidate }, signal) => {
        if (!same(pluginSecurityActor(actor), current().currentActor()))
          denied();
        signal.throwIfAborted();
        await current().assertCurrent();
        authority.assertScope(actor, scope);
        const decision = registry.authorizeCandidate(candidate);
        await current().assertCurrent();
        signal.throwIfAborted();
        authority.assertScope(actor, scope);
        return decision;
      },
    });
    requests = new InstalledPluginRequestOwner({
      identity: {
        resolveCurrentActor: async (request, signal) => {
          signal.throwIfAborted();
          const actor = pluginSecurityActor(
            await identity.resolveActor(request),
          );
          signal.throwIfAborted();
          assertOwner(actor);
          return actor;
        },
      },
      profiles,
      metadata,
      ...(activation === undefined ? {} : { peer: activation.peer }),
    });
    const historyAuthorization =
      history === undefined
        ? undefined
        : createDesktopPluginHistoryAuthorization({
            configuration,
            authority,
            installation,
            requests,
            store: dependencies.store,
            digester,
          });
    const authorization: AuthorizationPort = Object.freeze({
      authorize: async (
        value: Parameters<AuthorizationPort["authorize"]>[0],
      ) => {
        const actor = pluginSecurityActor(value.actor);
        if (!same(actor, current().currentActor())) denied();
        await current().assertCurrent();
        assertOwner(actor);
        const resource = value.resource;
        if (
          value.action === "extension:activate" &&
          activation !== undefined &&
          resource.kind === "extension" &&
          resource.tenantId === configuration.scope.tenantId &&
          resource.spaceId === configuration.scope.spaceId
        ) {
          const decision = await activation.authorizeActivate(
            actor,
            resource.pluginId,
            current().currentSignal(),
          );
          await current().assertCurrent();
          assertOwner(actor);
          return decision;
        }
        if (
          (value.action !== "extension:read" &&
            value.action !== "extension:configure") ||
          resource.kind !== "extension" ||
          resource.tenantId !== configuration.scope.tenantId ||
          resource.spaceId !== configuration.scope.spaceId ||
          !configuration.sources.some(
            (source) => source.pluginId === resource.pluginId,
          )
        )
          return {
            outcome: "deny" as const,
            reasonCode: "desktop_plugin_configuration_authority_denied",
          };
        await current().assertCurrent();
        assertOwner(actor);
        return { outcome: "allow" as const };
      },
    });
    const configurationService = bindInstalledPluginRequestOwner(
      new ExtensionConfigurationApplicationService({
        store: extensions,
        catalog: requests.catalog,
        host: requests.host,
        authorization,
        clock,
        digester,
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
        authorization:
          historyAuthorization === undefined
            ? authorization
            : {
                authorize: (value) =>
                  value.action === "extension:query" ||
                  value.action === "run:read"
                    ? historyAuthorization.authorize(value)
                    : authorization.authorize(value),
              },
        digester,
      }),
      requests,
      { preparation: "configuration" },
    );
    const actualRequests = requests,
      actualMetadata = metadata;
    let closing: Promise<void> | null = null;
    let closed = false;
    const assertActive = () => {
      if (closed) denied();
    };
    const runtime = Object.freeze({
      requests: actualRequests,
      extensions: configurationService,
      extensionReads: reads,
      ...(historyAuthorization === undefined ? {} : { historyAuthorization }),
      close: () => {
        closed = true;
        return (closing ??= closeAll([
          () => actualRequests.close(),
          () => actualMetadata.close(),
        ]));
      },
    });
    runtimes.set(
      runtime,
      Object.freeze({
        configuration,
        registry,
        authority,
        installation,
        activation,
        store: dependencies.store,
        assertActive,
      }),
    );
    return runtime;
  } catch (error) {
    try {
      await closeAll([() => requests?.close(), () => metadata?.close()]);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "desktop_plugin_configuration_startup_cleanup_failed",
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
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      "desktop_plugin_configuration_cleanup_failed",
    );
}

function same(left: unknown, right: unknown) {
  return extensionCanonicalJson(left) === extensionCanonicalJson(right);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_plugin_configuration_authority_denied",
  );
}
