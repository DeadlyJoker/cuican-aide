import { appendFileSync } from "node:fs";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import {
  TeamTaskScheduler,
  TeamTaskSchedulerPump,
} from "@crewon/application/team-task-scheduler";

const databasePath = process.env.CREWON_TEAM_PROCESS_DATABASE!;
const backend = process.env.CREWON_TEAM_PROCESS_BACKEND ?? "sqlite";
const connectionString = process.env.CREWON_TEAM_PROCESS_CONNECTION ?? "";
const schema = process.env.CREWON_TEAM_PROCESS_SCHEMA ?? "";
const tenantId = process.env.CREWON_TEAM_PROCESS_TENANT!;
const spaceId = process.env.CREWON_TEAM_PROCESS_SPACE!;
const ownerId = process.env.CREWON_TEAM_PROCESS_OWNER!;
const markerPath = process.env.CREWON_TEAM_PROCESS_MARKER!;
const leaseDurationMs = Number(process.env.CREWON_TEAM_PROCESS_LEASE_MS);

const store =
  backend === "postgres"
    ? await PostgresDomainStore.open({ connectionString, schema })
    : new SqliteRunStore(databasePath);
const journal = await store.experimentalTeamTaskJournalStore();
await journal.migrate();
const scheduler = new TeamTaskScheduler({
  store: journal,
  scope: { tenantId, spaceId },
  ownerId,
  concurrency: 1,
  listLimit: 1,
  leaseDurationMs,
  cancellationPollIntervalMs: null,
  createLeaseId: ({ sequence }) => `${ownerId}-lease-${sequence}`,
  execute: async (fence) => {
    appendFileSync(markerPath, `${ownerId}:${fence.epoch}:${fence.leaseId}\n`, {
      mode: 0o600,
    });
    process.stdout.write("claimed\n");
    await new Promise<void>(() => {});
  },
});
const pump = new TeamTaskSchedulerPump({
  scheduler,
  scanIntervalMs: null,
});
pump.start();
setInterval(() => {}, 1_000);
await new Promise<void>(() => {});
