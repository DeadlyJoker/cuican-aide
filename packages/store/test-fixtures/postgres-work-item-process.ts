import { PostgresQueueStore } from "../src/postgres-queue-store.ts";

const store = new PostgresQueueStore({
  connectionString: required("CREWON_TEST_POSTGRES_URL"),
  schema: required("CREWON_TEST_POSTGRES_SCHEMA"),
  maxPoolSize: 2,
  statementTimeoutMs: 5_000,
});
const ownerId = required("CREWON_TEST_WORKER_ID");
const leaseId = required("CREWON_TEST_LEASE_ID");
const mode = required("CREWON_TEST_WORKER_MODE");

try {
  const claim = await store.claimNextWorkItem({
    ownerId,
    leaseId,
    leaseDurationMs: 30_000,
  });
  if (claim === null) {
    process.stdout.write(`${JSON.stringify({ status: "idle" })}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({
        status: "claimed",
        workItemId: claim.workItem.workItemId,
        ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId,
        leaseEpoch: claim.lease.epoch,
      })}\n`,
    );
    if (mode === "hold") {
      await new Promise<void>(() => {});
    } else {
      try {
        await store.completeWorkItem({
          workItemId: claim.workItem.workItemId,
          ownerId: claim.lease.ownerId,
          leaseId: claim.lease.leaseId,
          leaseEpoch: claim.lease.epoch,
        });
        process.stdout.write(`${JSON.stringify({ status: "completed" })}\n`);
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({
            status: "fenced",
            code: error instanceof Error ? error.message : "unknown",
          })}\n`,
        );
        process.exitCode = 2;
      }
    }
  }
} finally {
  await store.close();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}
