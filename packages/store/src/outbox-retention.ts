import {
  RunStoreError,
  type OutboxRetentionPolicy,
  type OutboxRetentionResult,
} from "@crewon/application";

export const DEFERRED_OUTBOX_RETENTION: OutboxRetentionResult = Object.freeze({
  disposition: "deferred",
  deletedMessages: 0,
});

export function validatedOutboxRetentionPolicy(
  policy: OutboxRetentionPolicy,
): OutboxRetentionPolicy {
  const { retentionMs, minimumIntervalMs, maxBatchSize } = policy;
  for (const [value, maximum] of [
    [retentionMs, 365 * 86_400_000],
    [minimumIntervalMs, 86_400_000],
    [maxBatchSize, 500],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new RunStoreError("outbox_retention_policy_invalid");
  }
  return { retentionMs, minimumIntervalMs, maxBatchSize };
}
