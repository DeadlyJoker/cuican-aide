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
import { composeProjectGenerationReadService } from "./project-generation-read-composition.ts";
import { composeProjectGenerationSelectionService } from "./project-generation-selection-composition.ts";
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
    | Pick<
        PreparedCreativeProjects,
        "pluginUi" | "generationReadUi" | "selectionUi"
      >
    | undefined,
  approved: DesktopPluginConfiguration["publications"],
) {
  const grants = [
    projects?.pluginUi,
    projects?.generationReadUi,
    projects?.selectionUi,
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
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): Promise<DesktopProjectHistoryPluginRuntime | undefined> {
  const projects = input.projects;
  if (projects?.generationReads === undefined) return undefined;
  if (
    projects.generationReadStore === undefined ||
    input.installed.historyAuthorization === undefined
  )
    throw new Error("desktop_project_history_authority_required");
  const reads = composeProjectGenerationReadService({
    projects,
    extensions: projects.generationReadStore,
    tasks: input.installed.extensionReads,
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
        taskReads: input.installed.extensionReads,
        requests: input.installed.requests,
        publications: input.configuration.publications,
        ...(hostUiServices === undefined ? {} : { hostUiServices }),
      });
      hostUiServices = readRuntime.hostUiServices;
    }
    const selections = composeProjectGenerationSelectionService({
      projects,
      generationReads: reads,
      extensions: projects.generationReadStore,
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
        taskReads: input.installed.extensionReads,
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
