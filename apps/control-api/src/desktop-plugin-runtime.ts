import { createDesktopPluginUiPackagePort } from "./desktop-plugin-ui-package-port.ts";
import { createDesktopProjectFoundationPluginRuntime } from "./desktop-project-foundation-plugin-runtime.ts";
import { pluginSecurityUiRequest } from "./plugin-security-validation.ts";
import {
  createDesktopPluginUiControlRuntime,
  closeDesktopPluginRuntimeOwners as closeAll,
} from "./desktop-plugin-ui-runtime.ts";
import { createDesktopProjectAssetV2PluginRuntime } from "./desktop-project-asset-v2-plugin-runtime.ts";
import { composeDesktopProjectMediaResultUi } from "./desktop-project-media-result-ui-composition.ts";
import type { InstalledProjectMediaResultRuntime } from "./installed-project-media-result-runtime.ts";
import { composeDesktopProjectMediaGenerationUi } from "./desktop-project-media-generation-ui-composition.ts";
import type { ProjectMediaInputStageControlOwner } from "./project-media-input-stage-control-owner.ts";
import { composeDesktopProjectMediaInputUi } from "./desktop-project-media-input-ui-composition.ts";
import type { ProjectAssetStageControlOwner } from "./project-asset-stage-control-owner.ts";
import { randomBytes } from "node:crypto";
import {
  ApplicationError,
  PluginUiApplicationService,
  type ApplicationClock,
  type ContentDigester,
} from "@crewon/application";
import {
  createDeferredPluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { extensionCanonicalJson } from "@crewon/domain";
import { assertDesktopProjectPublications } from "./desktop-project-publication-check.ts";
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
import { DesktopPluginTaskServiceBinding } from "./desktop-plugin-task-service-binding.ts";
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
import { createDesktopProjectConversationRuntime } from "./desktop-project-conversation-runtime.ts";
import type { ThreadApplicationService } from "@crewon/application";
import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import type { RunLifecycleEvent } from "@crewon/domain";
import type { DesktopProjectMaterialStorage } from "@crewon/media-runtime/desktop-project-material-archive";
import type { InstalledProjectMediaGenerationRuntime } from "./installed-project-media-generation-runtime.ts";

export type DesktopPluginRuntime = Readonly<{
  /** Trusted in-process deployment wiring only; not exposed by HTTP or UI props. */
  taskHostServices?: DesktopPluginTaskServiceBinding["catalog"]["registrations"];
  installation: PluginInstallationControlService;
  compositionState: DesktopPluginInstallationRuntime["compositionState"];
  compositionStatus: DesktopPluginInstallationRuntime["compositionStatus"];
  sources: PluginSourceControlService;
  ui: PluginUiControlService;
  configuration: DesktopPluginConfigurationRuntime;
  tasks?: InstalledPluginTaskRuntimeCore;
  projectMediaGenerations?: InstalledProjectMediaGenerationRuntime;
  projectMediaResults?: InstalledProjectMediaResultRuntime;
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
    assertDesktopProjectPublications(
      configuration.projects,
      dependencies.creativeProjects,
    );
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
  let foundationUi: ReturnType<
    typeof createDesktopProjectFoundationPluginRuntime
  >;
  let assetUi: ProjectAssetPluginUiRuntime | undefined;
  let assetV2Ui: Awaited<
    ReturnType<typeof createDesktopProjectAssetV2PluginRuntime>
  >;
  let history: DesktopProjectHistoryPluginRuntime | undefined;
  let recovery: DesktopPluginUiRecoveryRuntime | undefined;
  let mediaGenerationUi: ReturnType<
    typeof composeDesktopProjectMediaGenerationUi
  >;
  let mediaResultUi: ReturnType<typeof composeDesktopProjectMediaResultUi>;
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
  const taskBinding =
    tasks === undefined && nativeControl === undefined
      ? undefined
      : new DesktopPluginTaskServiceBinding({
          configuration,
          registry,
          authority,
          store: dependencies.store,
        });
  const hostUiServices: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (input) =>
      (
        conversations?.hostUiServices ??
        recovery?.hostUiServices ??
        assetV2Ui?.hostUiServices ??
        mediaResultUi?.hostUiServices ??
        mediaGenerationUi?.hostUiServices ??
        mediaInputUi?.hostUiServices ??
        (projectExecution ? history?.hostUiServices : undefined) ??
        taskRuntime?.core.historicalQueries?.hostUiServices ??
        taskRuntime?.core.projectQueries?.hostUiServices ??
        taskRuntime?.core.projectGenerations?.hostUiServices ??
        history?.hostUiServices ??
        foundationUi?.hostUiServices ??
        assetUi?.hostUiServices ??
        textUi?.hostUiServices ??
        projectUi?.hostUiServices
      )?.isAvailable(input) ?? false,
  });
  try {
    await ledger.migrate();
    await ledger.compositionStore().migrate();
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
    foundationUi = createDesktopProjectFoundationPluginRuntime({
      configuration: input.configuration,
      projects: dependencies.creativeProjects,
      authority,
      installation: () => installation,
      fallback:
        assetUi?.hostUiServices ??
        textUi?.hostUiServices ??
        projectUi?.hostUiServices,
    });
    installation = await createDesktopPluginInstallationRuntime(
      { configuration, registry, authority },
      {
        store: dependencies.store,
        clock: dependencies.clock,
        digester: dependencies.digester,
        hostUiServices: deferredServices?.port ?? hostUiServices,
        taskBinding,
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
        foundationUi?.hostUiServices ??
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
        foundationUi?.hostUiServices ??
        assetUi?.hostUiServices ??
        textUi?.hostUiServices ??
        projectUi?.hostUiServices) === undefined
        ? {}
        : {
            fallback:
              taskRuntime?.core.historicalQueries?.hostUiServices ??
              taskRuntime?.core.projectQueries?.hostUiServices ??
              taskRuntime?.core.projectGenerations?.hostUiServices ??
              foundationUi?.hostUiServices ??
              assetUi?.hostUiServices ??
              textUi?.hostUiServices ??
              projectUi!.hostUiServices,
          }),
    });
    if (!projectExecution)
      await prepareTasks(
        history?.hostUiServices ??
          foundationUi?.hostUiServices ??
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
      foundationUi?.hostUiServices ??
      assetUi?.hostUiServices ??
      textUi?.hostUiServices ??
      projectUi?.hostUiServices;
    mediaInputUi = composeDesktopProjectMediaInputUi({
      configuration,
      core: taskRuntime?.core,
      fallback: originalBusinessHostUiServices,
    });
    mediaGenerationUi = composeDesktopProjectMediaGenerationUi({
      configuration,
      runtime:
        taskRuntime !== undefined && "mediaGenerations" in taskRuntime
          ? taskRuntime.mediaGenerations
          : undefined,
      fallback: mediaInputUi?.hostUiServices ?? originalBusinessHostUiServices,
      committedTasks: taskRuntime?.core.owner.committedTasks,
      recovery: () => recovery?.service,
    });
    mediaResultUi = composeDesktopProjectMediaResultUi({
      configuration,
      runtime:
        taskRuntime !== undefined && "mediaResults" in taskRuntime
          ? taskRuntime.mediaResults
          : undefined,
      fallback:
        mediaGenerationUi?.hostUiServices ??
        mediaInputUi?.hostUiServices ??
        originalBusinessHostUiServices,
    });
    assetV2Ui = await createDesktopProjectAssetV2PluginRuntime({
      configuration,
      projects: dependencies.creativeProjects,
      authority,
      installation,
      store: dependencies.store,
      clock: dependencies.clock,
      results:
        taskRuntime !== undefined && "mediaResults" in taskRuntime
          ? taskRuntime.mediaResults
          : undefined,
      fallback:
        mediaResultUi?.hostUiServices ??
        mediaGenerationUi?.hostUiServices ??
        mediaInputUi?.hostUiServices ??
        originalBusinessHostUiServices,
    });
    const businessHostUiServices =
      assetV2Ui?.hostUiServices ??
      mediaResultUi?.hostUiServices ??
      mediaGenerationUi?.hostUiServices ??
      mediaInputUi?.hostUiServices ??
      originalBusinessHostUiServices;
    recovery = await prepareDesktopPluginUiRecovery({
      mediaGenerations: mediaGenerationUi?.owner,
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
    if (taskBinding !== undefined) {
      const restore = installation.restoreTaskInstancesForStartup();
      taskBinding.bindStartup(restore);
      physical.add(restore);
      void restore.then(
        () => physical.delete(restore),
        () => physical.delete(restore),
      );
    }
    const available = () => {
      if (closed)
        throw new ApplicationError("conflict", "desktop_plugin_runtime_closed");
      if (projectExecution)
        assertDesktopPluginConfigurationFileCurrent(input.configuration);
      if (nativeControl !== undefined)
        assertDesktopNativePluginControlConfigCurrent(nativeControl);
    };
    const packages = createDesktopPluginUiPackagePort({
      configuration,
      registry,
      authority,
      available,
    });
    const dispatch = composeDesktopProjectPluginUiDispatch({
      foundations: foundationUi?.foundations,
      sourceUploads: foundationUi?.uploads,
      mediaResults: mediaResultUi?.owner,
      mediaInputs: mediaInputUi?.owner,
      mediaGenerations: mediaGenerationUi?.owner,
      conversations: () => conversations?.owner(),
      assetStages: () => conversations?.assetStages(),
      plans: () => conversations?.textPlans(),
      projects: projectUi,
      texts: textUi,
      assets: assetUi,
      assetsV2: assetV2Ui,
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
      ...(foundationUi?.uploads === undefined
        ? {}
        : { sourceUploads: foundationUi.uploads.owner }),
      ...(recovery === undefined ? {} : { recovery: recovery.service }),
      ...(taskRuntime === undefined
        ? {}
        : {
            committedTasks:
              mediaGenerationUi?.committedTasks ??
              taskRuntime.core.owner.committedTasks,
          }),
      ...(dispatch.committedMetadata === undefined
        ? {}
        : { committedMetadata: dispatch.committedMetadata }),
    });
    const ui = createDesktopPluginUiControlRuntime({
      application,
      available,
      physical,
      projectUi,
      textUi,
      assetUi,
      history,
      configurationRuntime,
      recovery,
      taskRuntime,
      mediaGenerationUi,
      mediaResultUi,
      mediaInputUi,
      conversations,
      foundationUi,
    });
    const ownedInstallation = installation;
    const ownedConfiguration = configurationRuntime;
    const ownedActivation = activation;
    return Object.freeze({
      installation: ownedInstallation.service,
      compositionState: ownedInstallation.compositionState,
      compositionStatus: ownedInstallation.compositionStatus,
      sources: ownedInstallation.service,
      ...(taskBinding === undefined || taskRuntime === undefined
        ? {}
        : { taskHostServices: taskBinding.catalog.registrations }),
      ui,
      configuration: ownedConfiguration,
      ...(taskRuntime === undefined ? {} : { tasks: taskRuntime.core }),
      ...(taskRuntime !== undefined && "mediaGenerations" in taskRuntime
        ? { projectMediaGenerations: taskRuntime.mediaGenerations }
        : {}),
      ...(taskRuntime !== undefined && "mediaResults" in taskRuntime
        ? { projectMediaResults: taskRuntime.mediaResults }
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
        taskBinding?.close();
        authority.withdraw();
        return (closing = closeAll([
          () => conversations?.close(),
          () => taskRuntime?.close(),
          () => Promise.allSettled([...physical]),
          () => recovery?.close(),
          () => foundationUi?.close(),
          () => projectUi?.close(),
          () => textUi?.close(),
          () => assetV2Ui?.close(),
          () => assetUi?.close(),
          () => mediaResultUi?.close(),
          () => mediaInputUi?.close(),
          () => mediaGenerationUi?.close(),
          () => history?.close(),
          () => ownedActivation?.close(),
          () => ownedConfiguration.close(),
          () => ownedInstallation.close(),
        ]));
      },
    });
  } catch (error) {
    deferredServices?.close();
    taskBinding?.close();
    authority.withdraw();
    try {
      await closeAll([
        () => conversations?.close(),
        () => taskRuntime?.close(),
        () => recovery?.close(),
        () => foundationUi?.close(),
        () => projectUi?.close(),
        () => textUi?.close(),
        () => assetV2Ui?.close(),
        () => assetUi?.close(),
        () => mediaResultUi?.close(),
        () => mediaInputUi?.close(),
        () => mediaGenerationUi?.close(),
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
          sharedBinding: taskBinding,
          creativeProjects: dependencies.creativeProjects,
          ...(dependencies.projectMaterialStorage === undefined
            ? {}
            : { projectMaterialStorage: dependencies.projectMaterialStorage }),
          ...(metadataHostUiServices === undefined
            ? {}
            : { metadataHostUiServices }),
        },
      );
      taskBinding?.bindCore(taskRuntime.core);
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
        sharedBinding: taskBinding,
        creativeProjects: dependencies.creativeProjects,
        fetch: dependencies.fetch,
        ...(metadataHostUiServices === undefined
          ? {}
          : { metadataHostUiServices }),
      },
    );
    taskBinding?.bindCore(taskRuntime.core);
  }
}
