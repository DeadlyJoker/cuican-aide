import { randomBytes } from "node:crypto";
import {
  ApplicationError,
  PluginUiApplicationService,
  type ApplicationClock,
  type ContentDigester,
  type PluginUiPackageContext,
  type PluginUiPackagePort,
} from "@crewon/application";
import { LocalPluginUiPackageReader } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import {
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import {
  createDesktopPluginConfigurationRuntime,
  type DesktopPluginConfigurationRuntime,
} from "./desktop-plugin-configuration-runtime.ts";
import {
  createDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import type {
  PluginInstallationControlService,
  PluginSourceControlService,
  PluginUiControlService,
} from "./plugin-control-route.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

export type DesktopPluginRuntime = Readonly<{
  installation: PluginInstallationControlService;
  sources: PluginSourceControlService;
  ui: PluginUiControlService;
  configuration: DesktopPluginConfigurationRuntime;
  close(): Promise<void>;
}>;

/** Explicit native opt-in. No execution, task, pricing or model authority is created here. */
export async function createDesktopPluginRuntime(
  input: Readonly<{ configuration: DesktopPluginConfiguration }>,
  dependencies: Readonly<{
    store: SqliteRunStore;
    identity: StandaloneIdentity;
    clock: ApplicationClock;
    digester: ContentDigester;
  }>,
): Promise<DesktopPluginRuntime> {
  if (!(dependencies.store instanceof SqliteRunStore))
    throw new Error("desktop_plugin_sqlite_store_required");
  if (!(dependencies.identity instanceof StandaloneIdentity))
    throw new Error("desktop_plugin_identity_required");
  const configuration = parseDesktopPluginConfiguration(input.configuration);
  const registry = await createDesktopPluginSourceRegistry(configuration);
  const authority = new DesktopPluginAuthority(configuration);
  const ledger = dependencies.store.pluginInstallationStore();
  let installation: DesktopPluginInstallationRuntime | null = null;
  let configurationRuntime: DesktopPluginConfigurationRuntime | null = null;
  try {
    await ledger.migrate();
    installation = await createDesktopPluginInstallationRuntime(
      { configuration, registry, authority },
      {
        store: dependencies.store,
        clock: dependencies.clock,
        digester: dependencies.digester,
      },
    );
    configurationRuntime = await createDesktopPluginConfigurationRuntime(
      { configuration, registry, authority, installation },
      dependencies,
    );
    let closed = false;
    let closing: Promise<void> | null = null;
    const physical = new Set<Promise<unknown>>();
    const available = () => {
      if (closed)
        throw new ApplicationError("conflict", "desktop_plugin_runtime_closed");
    };
    const reader = (context: PluginUiPackageContext) => {
      available();
      authority.assertScope(context.actor, context.scope);
      return new LocalPluginUiPackageReader({
        profile: context.scope,
        installRoot: configuration.installRoot,
        authorizePublication: async ({ package: pkg, descriptor }) => {
          available();
          authority.assertScope(context.actor, context.scope);
          if (
            registry.authorizeCandidate({
              descriptor,
              packageDigest: pkg.packageDigest,
            }) !== "allow"
          )
            throw new ApplicationError(
              "authorization",
              "plugin_ui_publication_denied",
            );
          const publication = configuration.publications.find(
            (item) =>
              item.pluginId === descriptor.pluginId &&
              item.publisherId === descriptor.publisherId &&
              item.packageDigest === pkg.packageDigest,
          );
          if (!publication)
            throw new ApplicationError(
              "authorization",
              "plugin_ui_publication_denied",
            );
          return publication.publicAssets;
        },
      });
    };
    const packages: PluginUiPackagePort = {
      verify: (context) => reader(context).verify(context),
      readAsset: (context) => reader(context).readAsset(context),
    };
    const application = new PluginUiApplicationService({
      store: ledger,
      clock: dependencies.clock,
      packages,
      profiles: { resolve: (actor) => authority.profile(actor) },
      authorization: authority.ui,
      ids: { nextId: () => randomBytes(32).toString("base64url") },
      actions: {
        invoke: async () => {
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        },
      },
    });
    const call = <T>(work: () => Promise<T>): Promise<T> => {
      available();
      const result = Promise.resolve()
        .then(() => {
          available();
          return work();
        })
        .then((value) => {
          available();
          return value;
        });
      physical.add(result);
      void result.finally(() => physical.delete(result)).catch(() => {});
      return result;
    };
    const ui: PluginUiControlService = Object.freeze({
      catalog: (...args) => call(() => application.catalog(...args)),
      openMount: (...args) => call(() => application.openMount(...args)),
      validateMount: (...args) =>
        call(() => application.validateMount(...args)),
      readAsset: (...args) => call(() => application.readAsset(...args)),
      closeMount: (...args) => call(() => application.closeMount(...args)),
      invoke: (...args) => call(() => application.invoke(...args)),
    });
    const ownedInstallation = installation;
    const ownedConfiguration = configurationRuntime;
    return Object.freeze({
      installation: ownedInstallation.service,
      sources: ownedInstallation.service,
      ui,
      configuration: ownedConfiguration,
      close: () => {
        if (closing !== null) return closing;
        closed = true;
        authority.withdraw();
        return (closing = closeAll([
          () => Promise.allSettled([...physical]),
          () => ownedConfiguration.close(),
          () => ownedInstallation.close(),
        ]));
      },
    });
  } catch (error) {
    authority.withdraw();
    try {
      await closeAll([
        () => configurationRuntime?.close(),
        () => installation?.close(),
      ]);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "desktop_plugin_runtime_startup_cleanup_failed",
      );
    }
    throw error;
  }
}

async function closeAll(
  actions: readonly (() => Promise<unknown> | undefined)[],
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
    throw new AggregateError(failures, "desktop_plugin_runtime_cleanup_failed");
}
