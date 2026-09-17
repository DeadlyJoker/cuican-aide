import type { RunState } from "@crewon/domain";
import { RuntimeAuthorityError } from "./runtime-authority-query.ts";
import type { LeaseConfirmation } from "./runtime-worker-queries.ts";

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
  #closed = false;

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
    if (this.#closed || this.#cancelTimer !== null) return;
    this.#cancelTimer = this.#scheduler.every(this.#intervalMs, () =>
      this.#tick(),
    );
  }

  failure(): unknown {
    return this.#failure;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    await this.#inFlight;
  }

  async #tick(): Promise<void> {
    if (
      this.#closed ||
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
      if (this.#closed) return;
      if (run.cancelRequested) {
        this.#controller.abort("durable_cancel_requested");
      }
    } catch (error) {
      if (this.#closed) return;
      this.#failure = error;
      this.#controller.abort("cancellation_watch_failed");
    }
  }
}

export class LeaseHeartbeat {
  readonly #intervalMs: number;
  readonly #renew: () => Promise<void>;
  readonly #controller: AbortController;
  readonly #confirmation: LeaseConfirmation;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<void> | null = null;
  #failure: unknown = null;
  #closed = false;
  #cancelDeadline: (() => void) | null = null;
  #unsubscribe: (() => void) | null = null;
  #started = false;

  constructor(
    intervalMs: number,
    renew: () => Promise<void>,
    controller: AbortController,
    confirmation: LeaseConfirmation,
  ) {
    this.#intervalMs = intervalMs;
    this.#renew = renew;
    this.#controller = controller;
    this.#confirmation = confirmation;
  }

  start(): void {
    if (this.#closed || this.#started) {
      return;
    }
    this.#started = true;
    if (this.#controller.signal.aborted) return;
    this.#unsubscribe = this.#confirmation.subscribe(() => this.#armDeadline());
    this.#armDeadline();
    if (this.#failure !== null || this.#controller.signal.aborted) return;
    this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
    this.#timer.unref?.();
  }

  failure(): unknown {
    return this.#failure;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stop();
    await this.#inFlight;
  }

  #stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#cancelDeadline?.();
    this.#cancelDeadline = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #armDeadline(): void {
    this.#cancelDeadline?.();
    this.#cancelDeadline = null;
    if (
      this.#closed ||
      this.#failure !== null ||
      this.#controller.signal.aborted
    )
      return;
    const remaining = this.#confirmation.remainingMs();
    if (remaining <= 0) {
      this.#fail(new RuntimeAuthorityError("lease_confirmation_timeout"));
      return;
    }
    this.#cancelDeadline = this.#confirmation.after(remaining, () =>
      this.#armDeadline(),
    );
  }

  #fail(error: unknown): void {
    if (this.#closed || this.#failure !== null) return;
    this.#failure = error;
    this.#stop();
    this.#confirmation.invalidate();
    this.#controller.abort("runtime_lease_unconfirmed");
  }

  #tick(): void {
    if (
      this.#closed ||
      this.#inFlight !== null ||
      this.#failure !== null ||
      this.#controller.signal.aborted
    ) {
      return;
    }
    if (this.#confirmation.remainingMs() <= 0) {
      this.#fail(new RuntimeAuthorityError("lease_confirmation_timeout"));
      return;
    }
    const renewal = this.#renew().catch((error: unknown) => {
      this.#fail(error);
    });
    this.#inFlight = renewal;
    void renewal.finally(() => {
      if (this.#inFlight === renewal) {
        this.#inFlight = null;
      }
    });
  }
}
