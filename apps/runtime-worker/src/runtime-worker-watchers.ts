import type { RunState } from "@crewon/domain";

export interface RuntimeWorkerScheduler {
  every(intervalMs: number, callback: () => Promise<void>): () => void;
}

export const systemRuntimeWorkerScheduler: RuntimeWorkerScheduler = {
  every: (intervalMs, callback) => {
    const timer = setInterval(() => void callback(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

export class CancellationWatcher {
  readonly #intervalMs: number;
  readonly #loadRun: () => Promise<RunState>;
  readonly #controller: AbortController;
  readonly #scheduler: RuntimeWorkerScheduler;
  #cancelTimer: (() => void) | null = null;
  #inFlight: Promise<void> | null = null;
  #failure: unknown = null;
  #cancellationRequested = false;

  constructor(
    intervalMs: number,
    loadRun: () => Promise<RunState>,
    controller: AbortController,
    scheduler: RuntimeWorkerScheduler,
  ) {
    this.#intervalMs = intervalMs;
    this.#loadRun = loadRun;
    this.#controller = controller;
    this.#scheduler = scheduler;
  }

  start(): void {
    this.#cancelTimer = this.#scheduler.every(this.#intervalMs, () =>
      this.#tick(),
    );
  }

  failure(): unknown {
    return this.#failure;
  }

  cancellationRequested(): boolean {
    return this.#cancellationRequested;
  }

  async close(): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    await this.#inFlight;
  }

  async #tick(): Promise<void> {
    if (
      this.#inFlight !== null ||
      this.#failure !== null ||
      this.#controller.signal.aborted
    ) {
      return;
    }
    const pending = this.#check();
    this.#inFlight = pending;
    try {
      await pending;
    } finally {
      if (this.#inFlight === pending) {
        this.#inFlight = null;
      }
    }
  }

  async #check(): Promise<void> {
    try {
      const run = await this.#loadRun();
      if (run.cancelRequested) {
        this.#cancellationRequested = true;
        this.#controller.abort("durable_cancel_requested");
      }
    } catch (error) {
      this.#failure = error;
      this.#controller.abort("cancellation_watch_failed");
    }
  }
}

export class LeaseHeartbeat {
  readonly #intervalMs: number;
  readonly #renew: () => Promise<void>;
  readonly #controller: AbortController;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<void> | null = null;
  #failure: unknown = null;

  constructor(
    intervalMs: number,
    renew: () => Promise<void>,
    controller: AbortController,
  ) {
    this.#intervalMs = intervalMs;
    this.#renew = renew;
    this.#controller = controller;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }
    this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
    this.#timer.unref?.();
  }

  failure(): unknown {
    return this.#failure;
  }

  async close(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight;
  }

  #tick(): void {
    if (this.#inFlight !== null || this.#failure !== null) {
      return;
    }
    const renewal = this.#renew().catch((error: unknown) => {
      this.#failure = error;
      this.#controller.abort(error);
    });
    this.#inFlight = renewal;
    void renewal.finally(() => {
      if (this.#inFlight === renewal) {
        this.#inFlight = null;
      }
    });
  }
}
