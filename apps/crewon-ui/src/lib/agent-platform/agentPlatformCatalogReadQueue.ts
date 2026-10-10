type QueuedRead = { start: () => void };

/** Background catalogs share a small HTTP budget with foreground conversations. */
export class AgentPlatformCatalogReadQueue {
  readonly #maximumActive: number;
  readonly #deadlineMs: number;
  readonly #maximumQueued: number;
  readonly #queued: QueuedRead[] = [];
  #active = 0;

  constructor(
    options: {
      maximumActive?: number;
      deadlineMs?: number;
      maximumQueued?: number;
    } = {},
  ) {
    this.#maximumActive = options.maximumActive ?? 2;
    this.#deadlineMs = options.deadlineMs ?? 10_000;
    this.#maximumQueued = options.maximumQueued ?? 32;
    if (
      [this.#maximumActive, this.#deadlineMs, this.#maximumQueued].some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      )
    ) {
      throw new Error("agent_platform_catalog_read_budget_invalid");
    }
  }

  read<T>(input: {
    signal: AbortSignal;
    read: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    if (input.signal.aborted) return Promise.reject(input.signal.reason);
    if (this.#queued.length >= this.#maximumQueued) {
      return Promise.reject(
        new Error("agent_platform_catalog_read_queue_full"),
      );
    }
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let started = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        controller.abort(input.signal.reason);
        reject(input.signal.reason);
        if (!started) {
          const index = this.#queued.indexOf(job);
          if (index >= 0) this.#queued.splice(index, 1);
          input.signal.removeEventListener("abort", abort);
        }
      };
      const job: QueuedRead = {
        start: () => {
          started = true;
          this.#active++;
          timer = setTimeout(() => {
            const error = new Error("agent_platform_catalog_read_timeout");
            controller.abort(error);
            reject(error);
          }, this.#deadlineMs);
          void Promise.resolve()
            .then(() => {
              controller.signal.throwIfAborted();
              return input.read(controller.signal);
            })
            .then(resolve, reject)
            .finally(() => {
              clearTimeout(timer);
              input.signal.removeEventListener("abort", abort);
              this.#active--;
              this.#drain();
            });
        },
      };
      input.signal.addEventListener("abort", abort, { once: true });
      this.#queued.push(job);
      if (input.signal.aborted) abort();
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#maximumActive) {
      const job = this.#queued.shift();
      if (!job) return;
      job.start();
    }
  }
}

export const agentPlatformCatalogReads = new AgentPlatformCatalogReadQueue();
