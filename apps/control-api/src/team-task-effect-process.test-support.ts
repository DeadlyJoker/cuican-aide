import { appendFileSync } from "node:fs";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";

const backend = process.env.CREWON_TEAM_PROCESS_BACKEND ?? "sqlite";
const databasePath = process.env.CREWON_TEAM_PROCESS_DATABASE ?? "";
const connectionString = process.env.CREWON_TEAM_PROCESS_CONNECTION ?? "";
const schema = process.env.CREWON_TEAM_PROCESS_SCHEMA ?? "";
const tenantId = process.env.CREWON_TEAM_PROCESS_TENANT!;
const spaceId = process.env.CREWON_TEAM_PROCESS_SPACE!;
const taskId = process.env.CREWON_TEAM_PROCESS_TASK!;
const ownerId = process.env.CREWON_TEAM_PROCESS_OWNER!;
const leaseDurationMs = Number(process.env.CREWON_TEAM_PROCESS_LEASE_MS);
const mode = process.env.CREWON_TEAM_PROCESS_MODE!;
const markerPath = process.env.CREWON_TEAM_PROCESS_MARKER!;
const effectKey = "command:process-unknown-effect";
const effectRequest = {
  method: "external.once",
  args: ["preserve-one-dispatch"],
};

const store =
  backend === "postgres"
    ? await PostgresDomainStore.open({ connectionString, schema })
    : new SqliteRunStore(databasePath);
const journal = await store.experimentalTeamTaskJournalStore();
await journal.migrate();
const fence = await journal.claim({
  tenantId,
  spaceId,
  taskId,
  ownerId,
  leaseId: `${ownerId}-lease`,
  durationMs: leaseDurationMs,
});
if (fence === null) throw new Error("effect_process_claim_failed");
const input = {
  key: effectKey,
  kind: "command" as const,
  request: effectRequest,
};

if (mode === "prepare") {
  const effect = await journal.prepare(fence, input, {
    renewForMs: leaseDurationMs,
  });
  if (effect.settled) throw new Error("effect_should_be_unsettled");
  appendFileSync(markerPath, `prepared:${fence.epoch}\n`, { mode: 0o600 });
  process.stdout.write("prepared\n");
  setInterval(() => {}, 1_000);
  await new Promise<void>(() => {});
}

if (mode === "recover") {
  const effect = await journal.prepare(fence, input, {
    renewForMs: leaseDurationMs,
  });
  appendFileSync(
    markerPath,
    `recovered:${String(effect.settled)}:${fence.epoch}\n`,
    { mode: 0o600 },
  );
  if (!effect.settled)
    await journal.settle(fence, effectKey, {
      providerReceiptId: "process-recovered-receipt",
    });
  await store.close();
  process.stdout.write("settled\n");
}
