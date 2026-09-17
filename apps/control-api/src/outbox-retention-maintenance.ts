import type {
  OutboxRetentionPolicy,
  OutboxRetentionResult,
  OutboxRetentionStore,
} from "@crewon/application";
import { BoundedMaintenancePass } from "./bounded-maintenance-pass.ts";

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
  readonly #pass: BoundedMaintenancePass;
  #timer: NodeJS.Timeout | null = null;
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
    this.#pass = new BoundedMaintenancePass({
      resource: store ?? this,
      maxDurationMs: 1_000,
      execute: (signal) => this.#prune(signal),
      onTimeout: () => {
        this.#lastFailureCode = "outbox_retention_timeout";
      },
      onFailure: (error) => {
        this.#lastFailureCode =
          error instanceof Error && /^[a-z0-9_]{1,128}$/.test(error.message)
            ? error.message
            : "outbox_retention_failed";
      },
    });
  }

  start(): void {
    if (
      this.#pass.closed ||
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

  wake(): Promise<void> {
    if (
      this.#pass.closed ||
      this.#store === undefined ||
      this.#policy === null ||
      this.#foregroundBusy()
    )
      return Promise.resolve();
    return this.#pass.run();
  }

  status() {
    return {
      inFlight: this.#pass.inFlight,
      lastResult: this.#lastResult === null ? null : { ...this.#lastResult },
      lastFailureCode: this.#lastFailureCode,
      resources: this.#pass.snapshot(),
    };
  }

  close(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    return this.#pass.close();
  }

  async #prune(signal: AbortSignal): Promise<void> {
    this.#lastResult = await this.#store!.pruneDeliveredOutbox(this.#policy!, {
      signal,
      maxDurationMs: 1_000,
    });
    this.#lastFailureCode = null;
  }
}
