import {
  watchSqliteAvailability,
  type SqliteAvailabilityHintPort,
  type SqliteAvailabilityWatchFactory,
} from "@crewon/store";

export type OutboxAvailabilityHintPort = SqliteAvailabilityHintPort;
export type SqliteOutboxWatchFactory = SqliteAvailabilityWatchFactory;

/** File changes are hints only; delivery still claims the durable Outbox. */
export function watchSqliteOutboxAvailability(
  input: Readonly<{
    databasePath: string;
    outbox: OutboxAvailabilityHintPort;
    watchFactory?: SqliteOutboxWatchFactory;
  }>,
) {
  return watchSqliteAvailability({
    databasePath: input.databasePath,
    receiver: input.outbox,
    watchFactory: input.watchFactory,
  });
}
