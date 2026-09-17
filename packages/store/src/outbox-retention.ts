import {
  RunStoreError,
  type OutboxRetentionPolicy,
  type OutboxRetentionResult,
  type OutboxRetentionOptions,
} from "@crewon/application";

export const DEFERRED_OUTBOX_RETENTION: OutboxRetentionResult = Object.freeze({
  disposition: "deferred",
  deletedMessages: 0,
});

export class OutboxRetentionInterrupted extends Error {
  constructor() {
    super("outbox_retention_interrupted");
  }
}

export function outboxRetentionBudget(options?: OutboxRetentionOptions) {
  const duration = options?.maxDurationMs ?? 1_000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 5_000)
    throw new RunStoreError("outbox_retention_options_invalid");
  const deadline = performance.now() + duration;
  const available = () =>
    !options?.signal?.aborted && performance.now() < deadline;
  return {
    available,
    check: () => {
      if (!available()) throw new OutboxRetentionInterrupted();
      return Math.max(1, Math.ceil(deadline - performance.now()));
    },
  };
}

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
