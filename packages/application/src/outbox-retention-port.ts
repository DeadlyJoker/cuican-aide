/** Internal maintenance; canonical events and command receipts remain authoritative. */
export type OutboxRetentionPolicy = Readonly<{
  retentionMs: number;
  minimumIntervalMs: number;
  maxBatchSize: number;
}>;

export type OutboxRetentionResult = Readonly<{
  disposition: "pruned" | "deferred";
  deletedMessages: number;
}>;

/** Cancellation fences subsequent maintenance steps; pending I/O must still settle. */
export type OutboxRetentionOptions = Readonly<{
  signal?: AbortSignal;
  maxDurationMs?: number;
}>;

export interface OutboxRetentionStore {
  /** Atomically retain message ID uniqueness and remove only aged delivered rows. */
  pruneDeliveredOutbox(
    policy: OutboxRetentionPolicy,
    options?: OutboxRetentionOptions,
  ): Promise<OutboxRetentionResult>;
}
