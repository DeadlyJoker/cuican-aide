import type { ProjectMediaInputStageControlOwner } from "./project-media-input-stage-control-owner.ts";
import { isProjectMediaInputUiNamespaceAction } from "@crewon/contracts/project-media-inputs-ui";
import { composeDesktopProjectMediaInputUi } from "./desktop-project-media-input-ui-composition.ts";
import { isProjectConversationUiNamespaceAction } from "@crewon/contracts/project-conversation-association";
import type { ProjectAssetStageControlOwner } from "./project-asset-stage-control-owner.ts";
import { isProjectAssetStagesNamespaceAction } from "@crewon/contracts/project-asset-stages";
import { isProjectAssetRecoveryNamespaceAction } from "@crewon/contracts/project-asset-recovery";
import { randomBytes } from "node:crypto";
import {
  ApplicationError,
  PluginUiApplicationService,
  type ApplicationClock,
  type ContentDigester,
  type PluginUiPackageContext,
  type PluginUiPackagePort,
} from "@crewon/application";
import {
  LocalPluginUiPackageReader,
  createDeferredPluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  assertDesktopPluginConfigurationFileCurrent,
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
import { type ProjectTextPluginUiRuntime } from "./project-text-plugin-ui-composition.ts";
import { createDesktopProjectTextPluginRuntime } from "./desktop-project-text-plugin-runtime.ts";
import { createDesktopProjectAssetPluginRuntime } from "./desktop-project-asset-plugin-runtime.ts";
import type { ProjectAssetPluginUiRuntime } from "./project-asset-plugin-ui-composition.ts";
import { isProjectAssetUiNamespaceAction } from "@crewon/contracts/project-assets";
import { composeDesktopProjectPluginUiDispatch } from "./desktop-project-plugin-ui-dispatch.ts";
import type { PluginUiRecoveryConfiguration } from "./plugin-ui-recovery-composition.ts";
import {
  assertDesktopPluginUiRecoveryConfiguration,
  prepareDesktopPluginUiRecovery,
  type DesktopPluginUiRecoveryRuntime,
} from "./desktop-plugin-ui-recovery.ts";
import type { DesktopInstalledPluginTaskConfig } from "./desktop-installed-plugin-task-environment.ts";
import {
  assertDesktopInstalledPluginTaskComposition,
  createDesktopInstalledPluginTaskRuntime,
  type DesktopInstalledPluginTaskRuntime,
} from "./desktop-installed-plugin-task-runtime.ts";
import type { InstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { pluginSecurityUiRequest } from "./plugin-security-validation.ts";
import { createDesktopProjectConversationRuntime } from "./desktop-project-conversation-runtime.ts";
import type { ThreadApplicationService } from "@crewon/application";
import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import type { RunLifecycleEvent } from "@crewon/domain";
import type { DesktopProjectMaterialStorage } from "@crewon/media-runtime/desktop-project-material-archive";
import type { InstalledProjectMediaGenerationRuntime } from "./installed-project-media-generation-runtime.ts";

export type DesktopPluginRuntime = Readonly<{
  installation: PluginInstallationControlService;
  sources: PluginSourceControlService;
  ui: PluginUiControlService;
  configuration: DesktopPluginConfigurationRuntime;
  tasks?: InstalledPluginTaskRuntimeCore;
  projectMediaGenerations?: InstalledProjectMediaGenerationRuntime;
  bindProjectConversations?(
    threads: ThreadApplicationService,
  ): ProjectConversationControlOwner | undefined;
  projectMediaInputStages?(): ProjectMediaInputStageControlOwner | undefined;
  projectAssetStages?(): ProjectAssetStageControlOwner | undefined;
  startProjectTextPlans?(): void;
  consumeProjectTextPlanRunEvents?(
    events: readonly RunLifecycleEvent[],
  ): Promise<void>;
  close(): Promise<void>;
}>;

/** Native metadata/history and independent task opt-in; this factory never funds accounts. */
import {
  assertDesktopNativePluginControlComposition,
  assertDesktopNativePluginControlConfigCurrent,
  type DesktopNativePluginControlConfig,
} from "./desktop-native-plugin-control-environment.ts";
import {
  assertDesktopNativePluginTaskComposition,
  createDesktopNativePluginTaskRuntime,
  type DesktopNativePluginTaskRuntime,
} from "./desktop-native-plugin-task-runtime.ts";

export async function createDesktopPluginRuntime(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    activation?: DesktopInstalledPluginActivationConfig;
    tasks?: DesktopInstalledPluginTaskConfig;
    nativeControl?: DesktopNativePluginControlConfig;
    uiRecovery?: PluginUiRecoveryConfiguration;
  }>,
  dependencies: Readonly<{
    store: SqliteRunStore;
    identity: StandaloneIdentity;
    clock: ApplicationClock;
    digester: ContentDigester;
    creativeProjects?: PreparedCreativeProjects;
    projectMaterialStorage?: DesktopProjectMaterialStorage;
    fetch?: typeof globalThis.fetch;
  }>,
): Promise<DesktopPluginRuntime> {
  if (!(dependencies.store instanceof SqliteRunStore))
    throw new Error("desktop_plugin_sqlite_store_required");
  if (!(dependencies.identity instanceof StandaloneIdentity))
    throw new Error("desktop_plugin_identity_required");
  const configuration = parseDesktopPluginConfiguration(input.configuration);
  const mediaInputsDeclared =
    configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3" &&
    configuration.projects.mediaInputs !== undefined;
  const projectExecution =
    mediaInputsDeclared ||
    dependencies.creativeProjects?.pluginGenerations !== undefined ||
    dependencies.creativeProjects?.pluginQueries !== undefined ||
    dependencies.creativeProjects?.historicalQueries !== undefined;
  if (projectExecution) {
    assertDesktopPluginConfigurationFileCurrent(input.configuration);
    if (configuration.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
      throw new Error("desktop_project_execution_authority_required");
    for (const field of [
      "pluginUi",
      "pluginGenerations",
      "pluginQueries",
      "historicalQueries",
      "generationReads",
      "generationReadUi",
      "selectionUi",
      "textPlans",
    ] as const) {
      const actual = dependencies.creativeProjects?.[field];
      if (
        extensionCanonicalJson(
          actual === undefined
            ? null
            : field === "pluginGenerations" || field === "pluginQueries"
              ? {
                  publications:
                    dependencies.creativeProjects![field]!.publications,
                }
              : actual,
        ) !== extensionCanonicalJson(configuration.projects[field] ?? null)
      )
        throw new Error("desktop_project_execution_authority_required");
    }
    if (
      extensionCanonicalJson(input.uiRecovery ?? null) !==
      extensionCanonicalJson(configuration.projects.uiRecovery ?? null)
    )
      throw new Error("desktop_project_execution_authority_required");
  }
  const tasks = input.tasks;
  const nativeControl = input.nativeControl;
  if (mediaInputsDeclared && nativeControl === undefined)
    throw new Error("desktop_native_project_media_input_authority_required");
  if (nativeControl !== undefined) {
    if (tasks !== undefined || input.activation !== undefined)
      throw new Error("desktop_native_plugin_authority_conflict");
    assertDesktopNativePluginControlComposition({
      configuration: input.configuration,
      nativeControl,
    });
    assertDesktopNativePluginTaskComposition({
      configuration: input.configuration,
      nativeControl,
      creativeProjects: dependencies.creativeProjects,
    });
  }
  const activationConfiguration = nativeControl ?? input.activation;
  if (
    tasks === undefined &&
    nativeControl === undefined &&
    dependencies.creativeProjects?.pluginGenerations !== undefined
  )
    throw new Error("desktop_project_generation_execution_authority_required");
  if (
    tasks === undefined &&
    nativeControl === undefined &&
    dependencies.creativeProjects?.pluginQueries !== undefined
  )
    throw new Error("desktop_project_query_execution_authority_required");
  if (tasks !== undefined)
    assertDesktopInstalledPluginTaskComposition({
      configuration: input.configuration,
      tasks,
      activation: input.activation,
      creativeProjects: dependencies.creativeProjects,
      digester: dependencies.digester,
    });
  const recoveryConfiguration = assertDesktopPluginUiRecoveryConfiguration({
    configuration: input.uiRecovery,
    publications: configuration.publications,
    metadataUi: dependencies.creativeProjects?.pluginUi,
    selectionUi: dependencies.creativeProjects?.selectionUi,
    ...(dependencies.creativeProjects?.pluginGenerations === undefined
      ? {}
      : {
          pluginGenerations: {
            publications:
              dependencies.creativeProjects.pluginGenerations.publications,
          },
        }),
    ...(dependencies.creativeProjects?.pluginQueries === undefined
      ? {}
      : {
          pluginQueries: {
            publications:
              dependencies.creativeProjects.pluginQueries.publications,
          },
        }),
  });
  const registry = await createDesktopPluginSourceRegistry(configuration);
  const projectConfiguration = dependencies.creativeProjects?.pluginUi;
  const actionPublications = desktopProjectUiPublications(
    dependencies.creativeProjects,
    configuration.publications,
  );
  const authority = new DesktopPluginAuthority(
    input.configuration,
    actionPublications,
  );
  const ledger = dependencies.store.pluginInstallationStore();
  let installation: DesktopPluginInstallationRuntime | null = null;
  let configurationRuntime: DesktopPluginConfigurationRuntime | null = null;
  let activation: DesktopInstalledPluginActivationOwner | null = null;
  let projectUi: CreativeProjectPluginUiRuntime | undefined;
  let textUi: ProjectTextPluginUiRuntime | undefined;
  let assetUi: ProjectAssetPluginUiRuntime | undefined;
  let history: DesktopProjectHistoryPluginRuntime | undefined;
  let recovery: DesktopPluginUiRecoveryRuntime | undefined;
  let mediaInputUi: ReturnType<typeof composeDesktopProjectMediaInputUi>;
  let conversations: ReturnType<typeof createDesktopProjectConversationRuntime>;
  let taskRuntime:
    | DesktopInstalledPluginTaskRuntime
    | DesktopNativePluginTaskRuntime
    | undefined;
  const deferredServices =
    tasks === undefined && nativeControl === undefined
      ? undefined
      : createDeferredPluginUiHostServiceAvailability();
  const hostUiServices: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (input) =>
      (
        conversations?.hostUiServices ??
        recovery?.hostUiServices ??
        mediaInputUi?.hostUiServices ??
        (projectExecution ? history?.hostUiServices : undefined) ??
        taskRuntime?.core.historicalQueries?.hostUiServices ??
        taskRuntime?.core.projectQueries?.hostUiServices ??
        taskRuntime?.core.projectGenerations?.hostUiServices ??
        history?.hostUiServices ??
        assetUi?.hostUiServices ??
        textUi?.hostUiServices ??
        projectUi?.hostUiServices
      )?.isAvailable(input) ?? false,
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
    textUi = createDesktopProjectTextPluginRuntime({
      projects: dependencies.creativeProjects,
      authority,
      installation: () => installation,
      ...(projectUi === undefined
        ? {}
        : { hostUiServices: projectUi.hostUiServices }),
    });
    assetUi = createDesktopProjectAssetPluginRuntime({
      projects: dependencies.creativeProjects,
      authority,
      installation: () => installation,
      hostUiServices: textUi?.hostUiServices ?? projectUi?.hostUiServices,
    });
    installation = await createDesktopPluginInstallationRuntime(
      { configuration, registry, authority },
      {
        store: dependencies.store,
        clock: dependencies.clock,
        digester: dependencies.digester,
        hostUiServices: deferredServices?.port ?? hostUiServices,
      },
    );
    if (activationConfiguration !== undefined) {
      activation = new DesktopInstalledPluginActivationOwner(
        {
          configuration,
          activation: activationConfiguration,
          registry,
          authority,
          installation,
          store: dependencies.store,
        },
        {
          fetch: dependencies.fetch,
          hostUiServices: deferredServices?.port ?? hostUiServices,
        },
      );
      installation.bindActivation(activation);
    }
    configurationRuntime = await createDesktopPluginConfigurationRuntime(
      {
        configuration: input.configuration,
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
    if (projectExecution)
      await prepareTasks(
        assetUi?.hostUiServices ??
          textUi?.hostUiServices ??
          projectUi?.hostUiServices,
      );
    history = await createDesktopProjectHistoryPluginRuntime({
      projects: dependencies.creativeProjects,
      configuration,
      installed: configurationRuntime,
      store: dependencies.store,
      clock: dependencies.clock,
      digester: dependencies.digester,
      ...(projectExecution && taskRuntime !== undefined
        ? { tasks: taskRuntime.core }
        : {}),
      ...((taskRuntime?.core.historicalQueries?.hostUiServices ??
        taskRuntime?.core.projectQueries?.hostUiServices ??
        taskRuntime?.core.projectGenerations?.hostUiServices ??
        assetUi?.hostUiServices ??
        textUi?.hostUiServices ??
        projectUi?.hostUiServices) === undefined
        ? {}
        : {
            fallback:
              taskRuntime?.core.historicalQueries?.hostUiServices ??
              taskRuntime?.core.projectQueries?.hostUiServices ??
              taskRuntime?.core.projectGenerations?.hostUiServices ??
              assetUi?.hostUiServices ??
              textUi?.hostUiServices ??
              projectUi!.hostUiServices,
          }),
    });
    if (!projectExecution)
      await prepareTasks(
        history?.hostUiServices ??
          assetUi?.hostUiServices ??
          textUi?.hostUiServices ??
          projectUi?.hostUiServices,
      );
    const originalBusinessHostUiServices =
      (projectExecution ? history?.hostUiServices : undefined) ??
      taskRuntime?.core.historicalQueries?.hostUiServices ??
      taskRuntime?.core.projectQueries?.hostUiServices ??
      taskRuntime?.core.projectGenerations?.hostUiServices ??
      history?.hostUiServices ??
      assetUi?.hostUiServices ??
      textUi?.hostUiServices ??
      projectUi?.hostUiServices;
    mediaInputUi = composeDesktopProjectMediaInputUi({
      configuration,
      core: taskRuntime?.core,
      fallback: originalBusinessHostUiServices,
    });
    const businessHostUiServices =
      mediaInputUi?.hostUiServices ?? originalBusinessHostUiServices;
    recovery = await prepareDesktopPluginUiRecovery({
      configuration: recoveryConfiguration,
      publications: configuration.publications,
      metadataUi: dependencies.creativeProjects?.pluginUi,
      selectionUi: dependencies.creativeProjects?.selectionUi,
      ...(dependencies.creativeProjects?.pluginGenerations === undefined
        ? {}
        : {
            pluginGenerations: {
              publications:
                dependencies.creativeProjects.pluginGenerations.publications,
            },
          }),
      ...(dependencies.creativeProjects?.pluginQueries === undefined
        ? {}
        : {
            pluginQueries: {
              publications:
                dependencies.creativeProjects.pluginQueries.publications,
            },
          }),
      ...(taskRuntime === undefined ? {} : { tasks: taskRuntime.core }),
      store: dependencies.store,
      requests: configurationRuntime.requests,
      selection: history?.selectionRuntime?.owner,
      clock: dependencies.clock,
      digester: dependencies.digester,
      ...(businessHostUiServices === undefined
        ? {}
        : { fallback: businessHostUiServices }),
      onDiagnostic: () => {
        process.emitWarning("plugin_ui_recovery_persistence_failed");
      },
    });
    conversations = createDesktopProjectConversationRuntime({
      projects: dependencies.creativeProjects,
      store: dependencies.store,
      configuration,
      authority,
      installation,
      installed: configurationRuntime,
      registry,
      nativeControl,
      tasks: () => taskRuntime,
      clock: dependencies.clock,
      digester: dependencies.digester,
      ...((recovery?.hostUiServices ?? businessHostUiServices)
        ? { fallback: recovery?.hostUiServices ?? businessHostUiServices }
        : {}),
    });
    deferredServices?.bind(
      conversations?.hostUiServices ??
        recovery?.hostUiServices ??
        businessHostUiServices ??
        hostUiServices,
    );
    let closed = false;
    let closing: Promise<void> | null = null;
    const physical = new Set<Promise<unknown>>();
    const available = () => {
      if (closed)
        throw new ApplicationError("conflict", "desktop_plugin_runtime_closed");
      if (projectExecution)
        assertDesktopPluginConfigurationFileCurrent(input.configuration);
      if (nativeControl !== undefined)
        assertDesktopNativePluginControlConfigCurrent(nativeControl);
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
    const dispatch = composeDesktopProjectPluginUiDispatch({
      mediaInputs: mediaInputUi?.owner,
      conversations: () => conversations?.owner(),
      assetStages: () => conversations?.assetStages(),
      plans: () => conversations?.textPlans(),
      projects: projectUi,
      texts: textUi,
      assets: assetUi,
      history,
      tasks: taskRuntime?.core,
    });
    const application = new PluginUiApplicationService({
      store: ledger,
      clock: dependencies.clock,
      packages,
      profiles: { resolve: (actor) => authority.profile(actor) },
      authorization: {
        authorize: (provided) => {
          const request = pluginSecurityUiRequest(provided);
          const taskPackage =
            (nativeControl === undefined
              ? tasks?.publication.uiPublications
              : configuration.publications
            )?.some(
              (grant) =>
                grant.pluginId === request.resource.pluginId &&
                grant.packageDigest === request.resource.packageDigest,
            ) === true;
          return taskPackage && taskRuntime !== undefined
            ? taskRuntime.authority.uiAuthorization.authorize(request)
            : authority.ui.authorize(request);
        },
      },
      ids: { nextId: () => randomBytes(32).toString("base64url") },
      actions:
        history?.readRuntime?.owner.actions(dispatch.actions) ??
        dispatch.actions,
      ...(recovery === undefined ? {} : { recovery: recovery.service }),
      ...(taskRuntime === undefined
        ? {}
        : { committedTasks: taskRuntime.core.owner.committedTasks }),
      ...(dispatch.committedMetadata === undefined
        ? {}
        : { committedMetadata: dispatch.committedMetadata }),
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
      renewMount: (...args) => call(() => application.renewMount(...args)),
      readAsset: (...args) => call(() => application.readAsset(...args)),
      closeMount: (...args) => call(() => application.closeMount(...args)),
      ...(recovery === undefined
        ? {}
        : {
            getRecovery: (
              ...args: Parameters<PluginUiApplicationService["getRecovery"]>
            ) => call(() => application.getRecovery(...args)),
            stageRecovery: (
              ...args: Parameters<PluginUiApplicationService["stageRecovery"]>
            ) => call(() => application.stageRecovery(...args)),
            recoveryAuthenticatedRequest: recovery.run,
          }),
      invoke: (...args) => {
        if (
          projectUi === undefined &&
          conversations === undefined &&
          textUi === undefined &&
          assetUi === undefined &&
          history?.selectionRuntime === undefined &&
          taskRuntime === undefined
        )
          return call(() => application.invoke(...args));
        available();
        // Only Application's genuine committed outcomes can bypass the late current fence.
        const result = application.invoke(...args);
        physical.add(result);
        void result.finally(() => physical.delete(result)).catch(() => {});
        return result;
      },
      ...(textUi === undefined &&
      assetUi === undefined &&
      conversations === undefined &&
      history?.readRuntime === undefined &&
      history?.selectionRuntime === undefined &&
      recovery === undefined &&
      taskRuntime === undefined
        ? {}
        : {
            invokeAuthenticatedRequest: ((request, actor, command, signal) => {
              available();
              const invoke = () => ui.invoke(actor, command);
              const dispatch = (requestSignal: AbortSignal | undefined) => {
                if (isProjectMediaInputUiNamespaceAction(command.action)) {
                  if (mediaInputUi === undefined || taskRuntime === undefined)
                    throw new ApplicationError(
                      "conflict",
                      "project_media_input_ui_unavailable",
                    );
                  return taskRuntime.core.requests.run(
                    {
                      request,
                      actor,
                      signal: requestSignal,
                      preparation: "configuration",
                    },
                    invoke,
                  );
                }
                if (
                  isProjectAssetUiNamespaceAction(command.action) ||
                  isProjectAssetRecoveryNamespaceAction(command.action)
                )
                  return invoke();
                if (isProjectAssetStagesNamespaceAction(command.action)) {
                  const owner = conversations?.assetStages();
                  if (owner === undefined)
                    throw new ApplicationError(
                      "conflict",
                      "project_asset_stage_unavailable",
                    );
                  return owner.runAuthenticatedRequest(
                    request,
                    actor,
                    command.action,
                    requestSignal,
                    invoke,
                  );
                }
                if (
                  command.action === "crewon.project-text-plans" ||
                  command.action.startsWith("crewon.project-text-plans.")
                ) {
                  const plans = conversations?.textPlans();
                  if (plans === undefined)
                    throw new ApplicationError(
                      "conflict",
                      "project_text_plan_unavailable",
                    );
                  return plans.invokeAuthenticatedRequest(
                    request,
                    actor,
                    command,
                    requestSignal,
                    invoke,
                  );
                }
                if (isProjectConversationUiNamespaceAction(command.action)) {
                  const owner = conversations?.owner();
                  if (owner === undefined)
                    throw new ApplicationError(
                      "conflict",
                      "plugin_ui_actions_unavailable",
                    );
                  return owner.runAuthenticatedRequest(
                    request,
                    actor,
                    command.action,
                    requestSignal,
                    invoke,
                  );
                }
                if (
                  command.action === "crewon.project-texts" ||
                  command.action.startsWith("crewon.project-texts.") ||
                  command.action === "crewon.project-text-recovery" ||
                  command.action.startsWith("crewon.project-text-recovery.")
                )
                  return invoke();
                if (projectUi?.owner.supportsAction(command.action))
                  return invoke();
                if (
                  command.action === "crewon.project-generations" ||
                  command.action.startsWith("crewon.project-generations.") ||
                  command.action === "crewon.project-generation-contexts" ||
                  command.action.startsWith(
                    "crewon.project-generation-contexts.",
                  ) ||
                  command.action === "crewon.project-generation-queries" ||
                  command.action.startsWith(
                    "crewon.project-generation-queries.",
                  )
                ) {
                  if (taskRuntime === undefined)
                    throw new ApplicationError(
                      "conflict",
                      "plugin_ui_actions_unavailable",
                    );
                  return taskRuntime.core.requests.run(
                    { request, actor, signal: requestSignal },
                    invoke,
                  );
                }
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
                    requestSignal,
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
                    requestSignal,
                    invoke,
                  );
                }
                if (taskRuntime !== undefined)
                  return taskRuntime.core.requests.run(
                    { request, actor, signal: requestSignal },
                    invoke,
                  );
                return invoke();
              };
              // Recovery owns the enclosing lifetime. The business request must remain
              // innermost so its prepared execution state is not shadowed by metadata.
              return recovery === undefined
                ? dispatch(signal)
                : recovery.run(request, actor, signal, () =>
                    dispatch(configurationRuntime!.requests.currentSignal()),
                  );
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
      ...(taskRuntime === undefined ? {} : { tasks: taskRuntime.core }),
      ...(taskRuntime !== undefined && "mediaGenerations" in taskRuntime
        ? { projectMediaGenerations: taskRuntime.mediaGenerations }
        : {}),
      bindProjectConversations: (threads) =>
        conversations?.bindThreads(threads),
      projectAssetStages: () => conversations?.assetStages(),
      projectMediaInputStages: () => conversations?.mediaInputStages(),
      startProjectTextPlans: () => conversations?.textPlans()?.start(),
      consumeProjectTextPlanRunEvents: (events) =>
        conversations?.textPlans()?.consumeRunEvents(events) ??
        Promise.resolve(),
      close: () => {
        if (closing !== null) return closing;
        closed = true;
        deferredServices?.close();
        authority.withdraw();
        return (closing = closeAll([
          () => conversations?.close(),
          () => taskRuntime?.close(),
          () => Promise.allSettled([...physical]),
          () => recovery?.close(),
          () => projectUi?.close(),
          () => textUi?.close(),
          () => assetUi?.close(),
          () => mediaInputUi?.close(),
          () => history?.close(),
          () => ownedActivation?.close(),
          () => ownedConfiguration.close(),
          () => ownedInstallation.close(),
        ]));
      },
    });
  } catch (error) {
    deferredServices?.close();
    authority.withdraw();
    try {
      await closeAll([
        () => conversations?.close(),
        () => taskRuntime?.close(),
        () => recovery?.close(),
        () => projectUi?.close(),
        () => textUi?.close(),
        () => assetUi?.close(),
        () => mediaInputUi?.close(),
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
  async function prepareTasks(
    metadataHostUiServices: PluginUiHostServiceAvailabilityPort | undefined,
  ) {
    if (tasks === undefined && nativeControl === undefined) return;
    if (
      taskRuntime !== undefined ||
      activation === null ||
      activationConfiguration === undefined ||
      configurationRuntime === null ||
      installation === null
    )
      throw new ApplicationError(
        "authorization",
        "desktop_plugin_task_authority_unavailable",
      );
    if (nativeControl !== undefined) {
      taskRuntime = await createDesktopNativePluginTaskRuntime(
        {
          configuration: input.configuration,
          nativeControl,
          activationOwner: activation,
          installed: configurationRuntime,
          registry,
          authority,
          installation,
          store: dependencies.store,
        },
        {
          clock: dependencies.clock,
          digester: dependencies.digester,
          creativeProjects: dependencies.creativeProjects,
          ...(dependencies.projectMaterialStorage === undefined
            ? {}
            : { projectMaterialStorage: dependencies.projectMaterialStorage }),
          ...(metadataHostUiServices === undefined
            ? {}
            : { metadataHostUiServices }),
        },
      );
      return;
    }
    if (
      tasks === undefined ||
      activationConfiguration !== input.activation ||
      input.activation === undefined
    )
      throw new Error("desktop_plugin_task_authority_unavailable");
    taskRuntime = await createDesktopInstalledPluginTaskRuntime(
      {
        configuration: input.configuration,
        tasks,
        activation: input.activation,
        activationOwner: activation,
        installed: configurationRuntime,
        registry,
        authority,
        installation,
        store: dependencies.store,
      },
      {
        clock: dependencies.clock,
        digester: dependencies.digester,
        creativeProjects: dependencies.creativeProjects,
        fetch: dependencies.fetch,
        ...(metadataHostUiServices === undefined
          ? {}
          : { metadataHostUiServices }),
      },
    );
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
