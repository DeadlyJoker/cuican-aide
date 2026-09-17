const MAX_ACTIVE_PASSES = 2;
const CLOSE_GRACE_MS = 250;
const IDLE = Promise.resolve();
let activePasses = 0;
const activeResources = new WeakSet<object>();

type PassOptions = Readonly<{
  resource: object;
  maxDurationMs: number;
  execute: (signal: AbortSignal) => Promise<void>;
  onFailure: (error: unknown) => void;
  onTimeout: () => void;
}>;

/** Same-process maintenance admission; caller deadlines do not release pending work. */
export class BoundedMaintenancePass {
  readonly #options: PassOptions;
  #active = false;
  #observing = false;
  #closed = false;
  #deferred = false;
  #deadline = 0;
  #abort: AbortController | null = null;
  #timer: NodeJS.Timeout | null = null;
  #wait: Promise<void> | null = null;
  #resolve: (() => void) | null = null;
  #closing: Promise<void> | null = null;

  constructor(options: PassOptions) {
    if (
      !Number.isSafeInteger(options.maxDurationMs) ||
      options.maxDurationMs < 1 ||
      options.maxDurationMs > 10_000
    )
      throw new Error("maintenance_duration_invalid");
    this.#options = options;
  }

  get closed() {
    return this.#closed;
  }
  get inFlight() {
    return this.#active;
  }

  // Deliberately not async: 20,000 coalesced ticks must not attach 20,000
  // promise-adoption continuations to an adapter that never finishes.
  run(): Promise<void> {
    if (this.#closed) return IDLE;
    if (this.#active) return this.#wait!;
    if (
      activePasses >= MAX_ACTIVE_PASSES ||
      activeResources.has(this.#options.resource)
    ) {
      this.#deferred = true;
      return IDLE;
    }
    this.#deferred = false;
    this.#active = true;
    this.#observing = true;
    activePasses++;
    activeResources.add(this.#options.resource);
    const abort = new AbortController();
    this.#abort = abort;
    const wait = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
    this.#wait = wait;
    this.#deadline = performance.now() + this.#options.maxDurationMs;
    this.#timer = setTimeout(
      () => this.#timeout(),
      this.#options.maxDurationMs,
    );
    try {
      void this.#options.execute(abort.signal).then(
        () => this.#finish(),
        (error) => {
          this.#options.onFailure(error);
          this.#finish();
        },
      );
    } catch (error) {
      this.#options.onFailure(error);
      this.#finish();
    }
    return wait;
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#abort?.abort("maintenance_closed");
    if (this.#observing) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = setTimeout(
        () => this.#timeout(),
        Math.max(
          0,
          Math.min(CLOSE_GRACE_MS, this.#deadline - performance.now()),
        ),
      );
    }
    this.#closing = this.#wait ?? IDLE;
    return this.#closing;
  }

  snapshot() {
    return {
      activePasses,
      maximumPasses: MAX_ACTIVE_PASSES,
      ownPassInFlight: this.#active,
      observing: this.#observing,
      admissionDeferred: this.#deferred,
    };
  }

  #timeout(): void {
    if (!this.#observing) return;
    this.#timer = null;
    this.#observing = false;
    this.#abort?.abort("maintenance_deadline_exceeded");
    this.#options.onTimeout();
    this.#resolve?.();
    this.#resolve = null;
    // Keep the settled wait object, adapter and admission until actual settlement.
  }

  #finish(): void {
    if (!this.#active) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#active = false;
    this.#observing = false;
    this.#abort = null;
    activePasses--;
    activeResources.delete(this.#options.resource);
    this.#resolve?.();
    this.#resolve = null;
    this.#wait = null;
  }
}
