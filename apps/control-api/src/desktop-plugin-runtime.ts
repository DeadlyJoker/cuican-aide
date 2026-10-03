import { randomBytes } from "node:crypto";
import {
  ApplicationError,
  PluginUiApplicationService,
  type ApplicationClock,
  type ContentDigester,
  type PluginUiPackageContext,
  type PluginUiPackagePort,
  type PluginUiActionPort,
} from "@crewon/application";
import {
  LocalPluginUiPackageReader,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
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
import { DesktopInstalledPluginActivationOwner } from "./desktop-installed-plugin-activation-owner.ts";
import type { DesktopInstalledPluginActivationConfig } from "./desktop-installed-plugin-activation-environment.ts";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import {
  createCreativeProjectPluginUiRuntime,
  type CreativeProjectPluginUiRuntime,
} from "./creative-project-plugin-ui-composition.ts";
import {
  createDesktopProjectHistoryPluginRuntime,
  desktopProjectUiPublications,
  type DesktopProjectHistoryPluginRuntime,
} from "./desktop-project-history-plugin-runtime.ts";
import { combineSelectionCommittedMetadata } from "./project-generation-selection-plugin-ui-owner.ts";

export type DesktopPluginRuntime = Readonly<{
  installation: PluginInstallationControlService;
  sources: PluginSourceControlService;
  ui: PluginUiControlService;
  configuration: DesktopPluginConfigurationRuntime;
  close(): Promise<void>;
}>;

/** Native metadata and explicitly approved cold history; no task, funding or model permission. */
export async function createDesktopPluginRuntime(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    activation?: DesktopInstalledPluginActivationConfig;
  }>,
  dependencies: Readonly<{
    store: SqliteRunStore;
    identity: StandaloneIdentity;
    clock: ApplicationClock;
    digester: ContentDigester;
    creativeProjects?: PreparedCreativeProjects;
  }>,
): Promise<DesktopPluginRuntime> {
  if (!(dependencies.store instanceof SqliteRunStore))
    throw new Error("desktop_plugin_sqlite_store_required");
  if (!(dependencies.identity instanceof StandaloneIdentity))
    throw new Error("desktop_plugin_identity_required");
  const configuration = parseDesktopPluginConfiguration(input.configuration);
  if (dependencies.creativeProjects?.pluginGenerations !== undefined)
    throw new Error("desktop_project_generation_execution_authority_required");
  if (dependencies.creativeProjects?.pluginQueries !== undefined)
    throw new Error("desktop_project_query_execution_authority_required");
  const registry = await createDesktopPluginSourceRegistry(configuration);
  const projectConfiguration = dependencies.creativeProjects?.pluginUi;
  const actionPublications = desktopProjectUiPublications(
    dependencies.creativeProjects,
    configuration.publications,
  );
  const authority = new DesktopPluginAuthority(
    configuration,
    actionPublications,
  );
  const ledger = dependencies.store.pluginInstallationStore();
  let installation: DesktopPluginInstallationRuntime | null = null;
  let configurationRuntime: DesktopPluginConfigurationRuntime | null = null;
  let activation: DesktopInstalledPluginActivationOwner | null = null;
  let projectUi: CreativeProjectPluginUiRuntime | undefined;
  let history: DesktopProjectHistoryPluginRuntime | undefined;
  const hostUiServices: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (input) =>
      (history?.hostUiServices ?? projectUi?.hostUiServices)?.isAvailable(
        input,
      ) ?? false,
  });
  try {
    await ledger.migrate();
    if (projectConfiguration !== undefined) {
      projectUi = createCreativeProjectPluginUiRuntime({
        projects: dependencies.creativeProjects!.service,
        configuration: projectConfiguration,
        authorization: {
          authorize: async (context) => {
            authority.assertScope(context.actor, context.scope);
            if (installation === null)
              throw new ApplicationError(
                "conflict",
                "plugin_ui_actions_unavailable",
              );
            installation.assertProfileOwnership(context.actor);
          },
        },
      });
    }
    installation = await createDesktopPluginInstallationRuntime(
      { configuration, registry, authority },
      {
        store: dependencies.store,
        clock: dependencies.clock,
        digester: dependencies.digester,
        hostUiServices,
      },
    );
    if (input.activation !== undefined) {
      activation = new DesktopInstalledPluginActivationOwner({
        configuration,
        activation: input.activation,
        registry,
        authority,
        installation,
        store: dependencies.store,
      });
      installation.bindActivation(activation);
    }
    configurationRuntime = await createDesktopPluginConfigurationRuntime(
      {
        configuration,
        registry,
        authority,
        installation,
        ...(activation === null ? {} : { activation }),
        ...(dependencies.creativeProjects?.generationReads === undefined
          ? {}
          : { historyReads: { kind: "project-generation-history" as const } }),
      },
      dependencies,
    );
    history = await createDesktopProjectHistoryPluginRuntime({
      projects: dependencies.creativeProjects,
      configuration,
      installed: configurationRuntime,
      store: dependencies.store,
      clock: dependencies.clock,
      digester: dependencies.digester,
      ...(projectUi === undefined
        ? {}
        : { fallback: projectUi.hostUiServices }),
    });
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
    const businessActions: PluginUiActionPort = {
      invoke: async (context) => {
        if (projectUi?.owner.supportsAction(context.action))
          return projectUi.owner.actions.invoke(context);
        if (history?.selectionRuntime?.owner.supportsAction(context.action))
          return history.selectionRuntime.owner.actions.invoke(context);
        throw new ApplicationError("conflict", "plugin_ui_actions_unavailable");
      },
    };
    const application = new PluginUiApplicationService({
      store: ledger,
      clock: dependencies.clock,
      packages,
      profiles: { resolve: (actor) => authority.profile(actor) },
      authorization: authority.ui,
      ids: { nextId: () => randomBytes(32).toString("base64url") },
      actions:
        history?.readRuntime?.owner.actions(businessActions) ?? businessActions,
      ...(history?.selectionRuntime === undefined && projectUi === undefined
        ? {}
        : {
            committedMetadata:
              history?.selectionRuntime === undefined
                ? projectUi!.owner.committedMetadata
                : combineSelectionCommittedMetadata(
                    history.selectionRuntime.owner.committedMetadata,
                    projectUi?.owner.committedMetadata,
                  ),
          }),
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
      invoke: (...args) => {
        if (projectUi === undefined && history?.selectionRuntime === undefined)
          return call(() => application.invoke(...args));
        available();
        // Only Application's opaque committed metadata path can bypass the late current fence.
        const result = application.invoke(...args);
        physical.add(result);
        void result.finally(() => physical.delete(result)).catch(() => {});
        return result;
      },
      ...(history?.readRuntime === undefined &&
      history?.selectionRuntime === undefined
        ? {}
        : {
            invokeAuthenticatedRequest: ((request, actor, command, signal) => {
              available();
              const invoke = () => ui.invoke(actor, command);
              if (
                command.action === "crewon.project-generation-reads" ||
                command.action.startsWith("crewon.project-generation-reads.")
              ) {
                if (history?.readRuntime === undefined)
                  throw new ApplicationError(
                    "conflict",
                    "plugin_ui_actions_unavailable",
                  );
                return history.readRuntime.invokeAuthenticatedRequest(
                  request,
                  actor,
                  command,
                  signal,
                  invoke,
                );
              }
              if (
                command.action === "crewon.project-generation-selections" ||
                command.action.startsWith(
                  "crewon.project-generation-selections.",
                )
              ) {
                if (history?.selectionRuntime === undefined)
                  throw new ApplicationError(
                    "conflict",
                    "plugin_ui_actions_unavailable",
                  );
                return history.selectionRuntime.invokeAuthenticatedRequest(
                  request,
                  actor,
                  command,
                  signal,
                  invoke,
                );
              }
              return invoke();
            }) satisfies NonNullable<
              PluginUiControlService["invokeAuthenticatedRequest"]
            >,
          }),
    });
    const ownedInstallation = installation;
    const ownedConfiguration = configurationRuntime;
    const ownedActivation = activation;
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
          () => projectUi?.close(),
          () => history?.close(),
          () => ownedActivation?.close(),
          () => ownedConfiguration.close(),
          () => ownedInstallation.close(),
        ]));
      },
    });
  } catch (error) {
    authority.withdraw();
    try {
      await closeAll([
        () => projectUi?.close(),
        () => history?.close(),
        () => configurationRuntime?.close(),
        () => activation?.close(),
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
