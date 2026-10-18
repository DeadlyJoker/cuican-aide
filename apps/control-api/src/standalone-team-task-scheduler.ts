import type { ActorContext, ContentDigester } from "@crewon/application";
import {
  createTeamTaskExecutor,
  type TeamTaskExecutionHost,
} from "@crewon/application/team-task-execution";
import {
  TeamTaskScheduler,
  TeamTaskSchedulerPump,
  type TeamTaskSchedulerInput,
} from "@crewon/application/team-task-scheduler";
import type { ControlTeamRuntimeClient } from "@crewon/application/team-turn";
import { SqliteRunStore } from "@crewon/store/sqlite-run-store";

export type StandaloneTeamTaskSchedulerConfig = Readonly<{
  databasePath: string;
  actor: ActorContext;
  operations: ControlTeamRuntimeClient;
  digester: ContentDigester;
  ownerId?: string;
  concurrency?: number;
  listLimit?: number;
  leaseDurationMs?: number;
  cancellationPollIntervalMs?: number | null;
  scanIntervalMs?: number | null;
  onError?: TeamTaskSchedulerInput["onError"];
}>;

export type StandaloneTeamTaskSchedulerRuntime = Readonly<{
  pump: TeamTaskSchedulerPump;
  close(): Promise<void>;
}>;

/** Async standalone-only scheduler composition; the existing Control root stays synchronous. */
export async function createStandaloneTeamTaskScheduler(
  config: StandaloneTeamTaskSchedulerConfig,
): Promise<StandaloneTeamTaskSchedulerRuntime> {
  const store = new SqliteRunStore(config.databasePath);
  try {
    const journal = await store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    const scheduler = new TeamTaskScheduler({
      store: journal,
      scope: { tenantId: config.actor.tenantId, spaceId: config.actor.spaceId },
      ownerId: config.ownerId ?? "team-task:standalone",
      concurrency: config.concurrency ?? 1,
      listLimit: config.listLimit ?? Math.max(1, config.concurrency ?? 1),
      leaseDurationMs: config.leaseDurationMs ?? 30_000,
      cancellationPollIntervalMs:
        config.cancellationPollIntervalMs === undefined
          ? 250
          : config.cancellationPollIntervalMs,
      createLeaseId: ({ sequence }) => `team-task:lease:${sequence}`,
      execute: createTeamTaskExecutor({
        store: journal,
        host: {
          actor: config.actor,
          operations: config.operations,
          digester: config.digester,
        } satisfies TeamTaskExecutionHost,
      }),
      ...(config.onError === undefined ? {} : { onError: config.onError }),
    });
    const pump = new TeamTaskSchedulerPump({
      scheduler,
      scanIntervalMs: config.scanIntervalMs ?? null,
    });
    pump.start();
    return {
      pump,
      async close() {
        await pump.close();
        await store.close();
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
