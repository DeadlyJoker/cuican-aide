import type { ContentDigester } from "@crewon/application";
import { TeamTaskAdmissionApplicationService } from "@crewon/application/team-task-admission";
import { ThreadApplicationService } from "@crewon/application";
import { SqliteRunStore } from "@crewon/store/sqlite-run-store";
import {
  createStandaloneControlApi,
  type StandaloneControlApiConfig,
  type StandaloneControlApiRuntime,
} from "./standalone-composition.ts";
import {
  createStandaloneTeamTaskScheduler,
  type StandaloneTeamTaskSchedulerConfig,
  type StandaloneTeamTaskSchedulerRuntime,
} from "./standalone-team-task-scheduler.ts";
import { createDesktopWorkspaceAdmission } from "./desktop-workspace-admission.ts";
import {
  NodeSha256ContentDigester,
  StandaloneAuthorization,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";

export type StandaloneTeamTaskControlApiConfig = StandaloneControlApiConfig &
  Readonly<{
    teamTaskScheduler?: Omit<
      StandaloneTeamTaskSchedulerConfig,
      "databasePath" | "actor" | "operations" | "digester"
    >;
  }>;

export type StandaloneTeamTaskControlApiRuntime = StandaloneControlApiRuntime &
  Readonly<{
    teamTaskScheduler: StandaloneTeamTaskSchedulerRuntime;
  }>;

/**
 * Explicit standalone composition for the first durable Team HTTP path.
 * Synchronous Control creation and Production composition remain unchanged.
 */
export async function createStandaloneTeamTaskControlApi(
  config: StandaloneTeamTaskControlApiConfig,
): Promise<StandaloneTeamTaskControlApiRuntime> {
  const admissionStore = new SqliteRunStore(config.databasePath);
  let scheduler: StandaloneTeamTaskSchedulerRuntime | undefined;
  let runtime: StandaloneControlApiRuntime | undefined;
  try {
    const journal = await admissionStore.experimentalTeamTaskJournalStore();
    await journal.migrate();
    const authorization = new StandaloneAuthorization(config.actor);
    const clock = new SystemApplicationClock();
    const ids = new UuidV7ApplicationIdGenerator();
    const digester: ContentDigester = new NodeSha256ContentDigester();
    const threads = new ThreadApplicationService({
      store: admissionStore,
      authorization,
      clock,
      ids,
      digester,
      workspaceAdmission: createDesktopWorkspaceAdmission(
        config.desktopWorkspaceRegistryPath,
        config.actor,
      ),
    });
    const admission = new TeamTaskAdmissionApplicationService({
      threads,
      journal,
    });
    let runtimeScheduler: StandaloneTeamTaskSchedulerRuntime | undefined;
    runtime = createStandaloneControlApi({
      ...config,
      teamTaskAdmission: admission,
      teamTaskAdmissionWakeup: () => runtimeScheduler?.pump.notify(),
      teamTaskAdmissionClose: async () => {
        await runtimeScheduler?.close();
        await admissionStore.close();
      },
    });
    if (runtime.teamOperations === undefined)
      throw new Error("team_task_operations_unavailable");
    scheduler = await createStandaloneTeamTaskScheduler({
      databasePath: config.databasePath,
      actor: config.actor,
      operations: runtime.teamOperations,
      digester,
      ...(config.teamTaskScheduler ?? {}),
    });
    runtimeScheduler = scheduler;
    return { ...runtime, teamTaskScheduler: scheduler };
  } catch (error) {
    await scheduler?.close();
    await runtime?.app.close();
    await admissionStore.close();
    throw error;
  }
}
