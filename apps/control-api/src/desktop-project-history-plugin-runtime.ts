import type {
  ApplicationClock,
  ContentDigester,
  ProjectConceptSelectionApplicationService,
  ProjectGenerationReadApplicationService,
} from "@crewon/application";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type { SqliteRunStore } from "@crewon/store";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopPluginConfigurationRuntime } from "./desktop-plugin-configuration-runtime.ts";
import { assertCreativeProjectPluginPublications } from "./creative-project-plugin-ui-composition.ts";
import {
  composeProjectGenerationReadService,
  prepareProjectGenerationReadStore,
} from "./project-generation-read-composition.ts";
import {
  assertInstalledPluginTaskRuntimeCoreBinding,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";
import { composeProjectGenerationSelectionService } from "./project-generation-selection-composition.ts";
import type {
  ProjectFoundationCompositionConfig,
  PreparedProjectFoundation,
} from "./project-foundation-composition.ts";
import {
  createProjectGenerationReadPluginRuntime,
  createProjectGenerationSelectionPluginRuntime,
  type ProjectGenerationReadPluginRuntime,
  type ProjectGenerationSelectionPluginRuntime,
} from "./project-history-plugin-runtime.ts";

export type DesktopProjectHistoryPluginRuntime = Readonly<{
  reads: ProjectGenerationReadApplicationService;
  selections?: ProjectConceptSelectionApplicationService;
  readRuntime?: ProjectGenerationReadPluginRuntime;
  selectionRuntime?: ProjectGenerationSelectionPluginRuntime;
  hostUiServices?: PluginUiHostServiceAvailabilityPort;
  close(): Promise<void>;
}>;

/** Business source grants are independent; duplicate grants for the same module are collapsed only after validation. */
export function desktopProjectUiPublications(
  projects:
    | (Pick<
        PreparedCreativeProjects,
        | "pluginUi"
        | "textUi"
        | "assetUi"
        | "assetRecovery"
        | "textRecovery"
        | "conversations"
        | "textPlans"
        | "generationReadUi"
        | "selectionUi"
      > &
        Readonly<{
          foundation?:
            | ProjectFoundationCompositionConfig
            | Pick<PreparedProjectFoundation, "pluginUi" | "uploadUi">;
        }>)
    | undefined,
  approved: DesktopPluginConfiguration["publications"],
) {
  const grants = [
    projects?.pluginUi,
    projects?.textUi,
    projects?.assetUi,
    projects?.assetRecovery,
    projects?.textRecovery,
    projects?.conversations,
    projects?.textPlans,
    projects?.generationReadUi,
    projects?.selectionUi,
    projects?.foundation?.pluginUi,
    projects?.foundation === undefined
      ? undefined
      : "uploadUi" in projects.foundation
        ? projects.foundation.uploadUi
        : "uploads" in projects.foundation
          ? projects.foundation.uploads.pluginUi
          : undefined,
  ];
  for (const grant of grants)
    assertCreativeProjectPluginPublications(grant, approved);
  const unique = new Map<
    string,
    NonNullable<PreparedCreativeProjects["pluginUi"]>["publications"][number]
  >();
  for (const grant of grants)
    for (const publication of grant?.publications ?? [])
      unique.set(JSON.stringify(publication), publication);
  return unique.size === 0 ? undefined : Object.freeze([...unique.values()]);
}

/** Already committed SQL history, original bound reader, and pure image selection; no task or billing runtime. */
export async function createDesktopProjectHistoryPluginRuntime(
  input: Readonly<{
    projects: PreparedCreativeProjects | undefined;
    configuration: DesktopPluginConfiguration;
    installed: DesktopPluginConfigurationRuntime;
    store: SqliteRunStore;
    clock: ApplicationClock;
    digester: ContentDigester;
    tasks?: InstalledPluginTaskRuntimeCore;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): Promise<DesktopProjectHistoryPluginRuntime | undefined> {
  const projects = input.projects;
  if (projects?.generationReads === undefined) return undefined;
  if (input.installed.historyAuthorization === undefined)
    throw new Error("desktop_project_history_authority_required");
  if (input.tasks !== undefined)
    assertInstalledPluginTaskRuntimeCoreBinding(input.tasks, {
      store: input.store,
      requests: input.installed.requests,
    });
  if (projects.generationReadStore === undefined && input.tasks === undefined)
    throw new Error("desktop_project_history_authority_required");
  // The real task core has already migrated paid records. This separately issued
  // adapter only enables reads; an absent core retains the original history gate.
  const extensions =
    projects.generationReadStore ??
    (await prepareProjectGenerationReadStore(input.store));
  const taskReads =
    input.tasks?.extensionReads ?? input.installed.extensionReads;
  const reads = composeProjectGenerationReadService({
    projects,
    extensions,
    tasks: taskReads,
    digester: input.digester,
  });
  if (reads === undefined)
    throw new Error("desktop_project_history_reader_required");
  let readRuntime: ProjectGenerationReadPluginRuntime | undefined;
  let selectionRuntime: ProjectGenerationSelectionPluginRuntime | undefined;
  try {
    let hostUiServices = input.fallback;
    if (projects.generationReadUi !== undefined) {
      readRuntime = createProjectGenerationReadPluginRuntime({
        configuration: projects.generationReadUi,
        reads,
        taskReads,
        requests: input.installed.requests,
        publications: input.configuration.publications,
        ...(hostUiServices === undefined ? {} : { hostUiServices }),
      });
      hostUiServices = readRuntime.hostUiServices;
    }
    const selections = composeProjectGenerationSelectionService({
      projects,
      generationReads: reads,
      extensions,
      operations: input.store.externalOperationStore(),
      authorization: input.installed.historyAuthorization,
      clock: input.clock,
      digester: input.digester,
    });
    if (projects.selectionUi !== undefined) {
      if (selections === undefined)
        throw new Error("desktop_project_selection_service_required");
      selectionRuntime = createProjectGenerationSelectionPluginRuntime({
        configuration: projects.selectionUi,
        selections,
        taskReads,
        requests: input.installed.requests,
        publications: input.configuration.publications,
        ...(hostUiServices === undefined ? {} : { hostUiServices }),
      });
      hostUiServices = selectionRuntime.hostUiServices;
    }
    let closing: Promise<void> | undefined;
    return Object.freeze({
      reads,
      ...(selections === undefined ? {} : { selections }),
      ...(readRuntime === undefined ? {} : { readRuntime }),
      ...(selectionRuntime === undefined ? {} : { selectionRuntime }),
      ...(hostUiServices === undefined ? {} : { hostUiServices }),
      close: () => (closing ??= close()),
    });
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "desktop_project_history_startup_cleanup_failed",
      );
    }
    throw error;
  }
  async function close() {
    const results = await Promise.allSettled([
      selectionRuntime?.close(),
      readRuntime?.close(),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(
        failures,
        "desktop_project_history_cleanup_failed",
      );
  }
}
