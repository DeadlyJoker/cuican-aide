import type {
  OutboxRetentionPolicy,
  OutboxRetentionResult,
  OutboxRetentionStore,
} from "@crewon/application";

export const DEFAULT_OUTBOX_RETENTION: OutboxRetentionPolicy = Object.freeze({
  retentionMs: 86_400_000,
  minimumIntervalMs: 10_000,
  maxBatchSize: 100,
});

/** One bounded maintenance attempt per interval; foreground delivery wins. */
export class OutboxRetentionMaintenance {
  readonly #store: OutboxRetentionStore | undefined;
  readonly #policy: OutboxRetentionPolicy | null;
  readonly #foregroundBusy: () => boolean;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #closed = false;
  #lastResult: OutboxRetentionResult | null = null;
  #lastFailureCode: string | null = null;

  constructor(
    store: OutboxRetentionStore | undefined,
    policy: OutboxRetentionPolicy | null,
    foregroundBusy: () => boolean,
  ) {
    this.#store = store;
    this.#policy = policy === null ? null : { ...policy };
    this.#foregroundBusy = foregroundBusy;
    if (
      policy !== null &&
      (!Number.isSafeInteger(policy.retentionMs) ||
        policy.retentionMs < 1 ||
        policy.retentionMs > 365 * 86_400_000 ||
        !Number.isSafeInteger(policy.minimumIntervalMs) ||
        policy.minimumIntervalMs < 1 ||
        policy.minimumIntervalMs > 86_400_000 ||
        !Number.isSafeInteger(policy.maxBatchSize) ||
        policy.maxBatchSize < 1 ||
        policy.maxBatchSize > 500)
    )
      throw new Error("outbox_retention_policy_invalid");
  }

  start(): void {
    if (
      this.#closed ||
      this.#timer !== null ||
      this.#store === undefined ||
      this.#policy === null
    )
      return;
    this.#timer = setInterval(
      () => void this.wake(),
      this.#policy.minimumIntervalMs,
    );
    this.#timer.unref();
  }

  async wake(): Promise<void> {
    if (
      this.#closed ||
      this.#store === undefined ||
      this.#policy === null ||
      this.#foregroundBusy()
    )
      return;
    if (this.#running !== null) return this.#running;
    const running = this.#prune();
    this.#running = running;
    try {
      await running;
    } finally {
      if (this.#running === running) this.#running = null;
    }
  }

  status() {
    return {
      inFlight: this.#running !== null,
      lastResult: this.#lastResult === null ? null : { ...this.#lastResult },
      lastFailureCode: this.#lastFailureCode,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  async #prune(): Promise<void> {
    try {
      this.#lastResult = await this.#store!.pruneDeliveredOutbox(this.#policy!);
      this.#lastFailureCode = null;
    } catch (error) {
      this.#lastFailureCode =
        error instanceof Error && /^[a-z0-9_]{1,128}$/.test(error.message)
          ? error.message
          : "outbox_retention_failed";
    }
  }
}
