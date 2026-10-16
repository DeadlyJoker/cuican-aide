import type { RuntimeWorkerOutcome } from "./runtime-worker.ts";

/** One dirty bit and one scheduled wake per lane; execution owns the durable lease. */
export class RuntimeWorkerPump {
  readonly #wake: () => Promise<RuntimeWorkerOutcome>;
  readonly #scanMs: number | null;
  #started = false;
  #closed = false;
  #dirty = false;
  #running = false;
  #scheduled: ReturnType<typeof setImmediate> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(input: {
    wake(): Promise<RuntimeWorkerOutcome>;
    scanIntervalMs: number | null;
  }) {
    this.#wake = input.wake;
    this.#scanMs = input.scanIntervalMs;
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.notifyAvailability();
    if (this.#scanMs !== null) {
      this.#timer = setInterval(() => this.notifyAvailability(), this.#scanMs);
      this.#timer.unref();
    }
  }

  notifyAvailability(): void {
    if (!this.#started || this.#closed) return;
    this.#dirty = true;
    this.#schedule();
  }

  #schedule(): void {
    if (
      this.#closed ||
      this.#running ||
      !this.#dirty ||
      this.#scheduled !== null
    )
      return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = null;
      if (this.#closed) return;
      this.#dirty = false;
      this.#running = true;
      void this.#wake()
        .then(
          (outcome) => {
            // Refill immediately after useful work; an empty claim returns to hints/scans.
            if (outcome.kind !== "idle" && outcome.kind !== "leaseLost")
              this.#dirty = true;
          },
          () => {
            /* The durable scan is the retry path after an unexpected failure. */
          },
        )
        .finally(() => {
          this.#running = false;
          this.#schedule();
        });
    });
  }

  close(): void {
    this.#closed = true;
    this.#dirty = false;
    if (this.#scheduled !== null) clearImmediate(this.#scheduled);
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#scheduled = null;
    this.#timer = null;
    // The separately owned Worker joins execution before shared resources close.
  }
}
