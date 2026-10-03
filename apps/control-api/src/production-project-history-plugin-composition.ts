import type {
  ApplicationClock,
  AuthorizationPort,
  ContentDigester,
  ProjectGenerationReadApplicationService,
  ProjectConceptSelectionApplicationService,
} from "@crewon/application";
import type { PostgresDomainStore } from "@crewon/store";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { InstalledPluginTaskRuntime } from "./installed-plugin-task-composition.ts";
import {
  createInstalledPluginConfigurationRuntime,
  type InstalledPluginConfigurationRuntime,
} from "./installed-plugin-configuration-composition.ts";
import type { InstalledPluginConfigurationConfig } from "./installed-plugin-configuration-environment.ts";
import type { ProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import type { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import {
  composeProjectGenerationReadService,
  prepareProjectGenerationReadStore,
} from "./project-generation-read-composition.ts";
import { composeProjectGenerationSelectionService } from "./project-generation-selection-composition.ts";
import {
  createProductionProjectGenerationReadPluginRuntime,
  type ProductionProjectGenerationReadPluginRuntime,
} from "./production-project-generation-read-plugin-runtime.ts";
import {
  createProductionProjectGenerationSelectionPluginRuntime,
  type ProductionProjectGenerationSelectionPluginRuntime,
} from "./production-project-generation-selection-plugin-runtime.ts";

/** Cold history protocols are assembled before installed UI recovery, with no paid runtime requirement. */
export async function composeProductionProjectHistoryPlugins(
  input: Readonly<{
    store: PostgresDomainStore;
    projects: PreparedCreativeProjects | undefined;
    ui: ProductionPluginUiConfiguration | undefined;
    taskRuntime: InstalledPluginTaskRuntime | undefined;
    configuration: InstalledPluginConfigurationConfig | undefined;
    identity: ProductionControlApiIdentity;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    digester: ContentDigester;
    hostUiServices: PluginUiHostServiceAvailabilityPort | undefined;
  }>,
): Promise<
  Readonly<{
    configurationRuntime?: InstalledPluginConfigurationRuntime;
    reads?: ProjectGenerationReadApplicationService;
    selections?: ProjectConceptSelectionApplicationService;
    readRuntime?: ProductionProjectGenerationReadPluginRuntime;
    selectionRuntime?: ProductionProjectGenerationSelectionPluginRuntime;
    hostUiServices: PluginUiHostServiceAvailabilityPort | undefined;
  }>
> {
  if (
    input.projects?.generationReadUi === undefined &&
    input.projects?.selectionUi === undefined
  )
    return { hostUiServices: input.hostUiServices };
  if (input.ui === undefined)
    throw new Error("project_generation_history_ui_configuration_required");
  let configurationRuntime: InstalledPluginConfigurationRuntime | undefined;
  let readRuntime: ProductionProjectGenerationReadPluginRuntime | undefined;
  let selectionRuntime:
    | ProductionProjectGenerationSelectionPluginRuntime
    | undefined;
  try {
    if (input.taskRuntime === undefined && input.configuration !== undefined)
      configurationRuntime = await createInstalledPluginConfigurationRuntime(
        input.configuration,
        {
          store: input.store,
          identity: input.identity,
          authorization: input.authorization,
          clock: input.clock,
          digester: input.digester,
        },
      );
    const taskReads =
      input.taskRuntime?.extensionReads ?? configurationRuntime?.extensionReads;
    const extensions =
      input.projects.generationReadStore ??
      (await prepareProjectGenerationReadStore(input.store));
    const reads = composeProjectGenerationReadService({
      projects: input.projects,
      extensions,
      tasks: taskReads,
      digester: input.digester,
    });
    if (reads === undefined || taskReads === undefined)
      throw new Error("project_generation_history_ui_reader_required");
    let hostUiServices = input.hostUiServices;
    if (input.projects.generationReadUi !== undefined) {
      readRuntime = createProductionProjectGenerationReadPluginRuntime({
        configuration: input.projects.generationReadUi,
        reads,
        taskReads,
        ui: input.ui,
        identity: input.identity,
        ...(hostUiServices === undefined ? {} : { hostUiServices }),
      });
      hostUiServices = readRuntime.hostUiServices;
    }
    const selections = composeProjectGenerationSelectionService({
      projects: input.projects,
      generationReads: reads,
      extensions,
      operations: input.store.externalOperationStore(),
      authorization: input.authorization,
      clock: input.clock,
      digester: input.digester,
    });
    if (input.projects.selectionUi !== undefined) {
      if (selections === undefined)
        throw new Error("project_generation_selection_ui_service_required");
      selectionRuntime =
        createProductionProjectGenerationSelectionPluginRuntime({
          configuration: input.projects.selectionUi,
          selections,
          taskReads,
          ui: input.ui,
          identity: input.identity,
          ...(hostUiServices === undefined ? {} : { hostUiServices }),
        });
      hostUiServices = selectionRuntime.hostUiServices;
    }
    return {
      configurationRuntime,
      reads,
      selections,
      readRuntime,
      selectionRuntime,
      hostUiServices,
    };
  } catch (error) {
    const closed = await Promise.allSettled([
      selectionRuntime?.close(),
      readRuntime?.close(),
      configurationRuntime?.close(),
    ]);
    const failures = closed.flatMap((r) =>
      r.status === "rejected" ? [r.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "project_generation_history_ui_startup_cleanup_failed",
      );
    throw error;
  }
}
