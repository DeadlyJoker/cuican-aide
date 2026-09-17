import { Server } from "node:net";

// Subprocess-only fault injection: close the real listener first, then withhold
// its completion callback until the parent explicitly permits settlement.
const originalClose = Server.prototype.close;
Server.prototype.close = function (callback) {
  if (callback === undefined) return originalClose.call(this);
  process.stdout.write("fixture close called\n");
  return originalClose.call(this, (error) => {
    process.stdout.write("fixture close pending\n");
    process.once("SIGUSR2", () => {
      process.stdout.write("fixture close released\n");
      callback(
        process.env.CREWON_SHUTDOWN_FIXTURE_OUTCOME === "reject" &&
          process.env.CREWON_SHUTDOWN_FIXTURE_SERVICE !== "control-api"
          ? new Error("fixture-private-close-failure")
          : error,
      );
    });
  });
};

if (
  process.env.CREWON_SHUTDOWN_FIXTURE_SERVICE === "control-api" &&
  process.env.CREWON_SHUTDOWN_FIXTURE_OUTCOME === "reject"
) {
  // Fastify intentionally ignores the net.Server.close callback error. Fail an
  // actual Store onClose hook after closing its database instead.
  const { SqliteRunStore } = await import("@crewon/store");
  const closeStore = SqliteRunStore.prototype.close;
  SqliteRunStore.prototype.close = async function () {
    await closeStore.call(this);
    throw new Error("fixture-private-close-failure");
  };
}
