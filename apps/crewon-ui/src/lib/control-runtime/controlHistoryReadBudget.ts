type Kind = "history" | "settlement";
type Job = {
  kind: Kind;
  bytes: number;
  controller: AbortController;
  parentSignal: AbortSignal;
  started: boolean;
  settled: boolean;
  start(): void;
  cancel(): void;
};

/** Shared by all Control runtimes in this renderer, with room for final backfill. */
export class ControlHistoryReadBudget {
  readonly #queued: Job[] = [];
  #queuedBytes = 0;
  #active = 0;
  #activeHistory = 0;
  readonly #parents = new Map<AbortSignal, { jobs: Set<Job>; abort(): void }>();

  get usage() {
    return {
      active: this.#active,
      activeHistory: this.#activeHistory,
      queued: this.#queued.length,
      queuedBytes: this.#queuedBytes,
    };
  }

  run<T>(input: {
    kind: Kind;
    runId: string;
    signal: AbortSignal;
    timeoutMs: number;
    read(signal: AbortSignal): Promise<T>;
  }): Promise<T> {
    if (input.signal.aborted) return Promise.reject(input.signal.reason);
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.runId.length > 512
    )
      return Promise.reject(new Error("control_tool_history_budget_invalid"));
    // Counts the queued descriptor, not external objects owned by the caller.
    const bytes = 256 + input.runId.length * 2;
    const historicalQueue = this.#queued.filter(
      (job) => job.kind === "history",
    );
    const historicalBytes = historicalQueue.reduce(
      (total, job) => total + job.bytes,
      0,
    );
    if (
      !this.#canStart(input.kind) &&
      (this.#queued.length >= 32 ||
        this.#queuedBytes + bytes > 32 * 1024 ||
        (input.kind === "history" &&
          (historicalQueue.length >= 24 ||
            historicalBytes + bytes > 24 * 1024)))
    )
      return Promise.reject(new Error("control_tool_history_capacity"));
    const controller = new AbortController();
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const cleanup = () => {
      clearTimeout(timer);
      this.#detachParent(job);
      controller.signal.removeEventListener("abort", job.cancel);
    };
    const job: Job = {
      kind: input.kind,
      bytes,
      controller,
      parentSignal: input.signal,
      started: false,
      settled: false,
      cancel: () => {
        if (job.settled) return;
        job.settled = true;
        cleanup();
        if (!job.started) this.#removeQueued(job);
        reject(controller.signal.reason);
        this.#drain();
      },
      start: () => {
        job.started = true;
        this.#active++;
        if (job.kind === "history") this.#activeHistory++;
        const physicalRead = Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return input.read(controller.signal);
        });
        void physicalRead
          .then(
            (value) => {
              if (!job.settled) {
                job.settled = true;
                resolve(value);
              }
            },
            (error: unknown) => {
              if (!job.settled) {
                job.settled = true;
                reject(error);
              }
            },
          )
          .finally(() => {
            cleanup();
            controller.abort();
            // A timed-out but uncooperative transport still occupies its slot.
            // Releasing it at logical timeout would permit unbounded live reads.
            this.#active--;
            if (job.kind === "history") this.#activeHistory--;
            this.#drain();
          });
      },
    };
    const timer = setTimeout(
      () => controller.abort(new Error("control_tool_history_timeout")),
      input.timeoutMs,
    );
    this.#attachParent(job);
    controller.signal.addEventListener("abort", job.cancel, { once: true });
    if (this.#canStart(job.kind)) job.start();
    else {
      this.#queued.push(job);
      this.#queuedBytes += bytes;
    }
    return result;
  }

  #attachParent(job: Job): void {
    const signal = job.parentSignal;
    let parent = this.#parents.get(signal);
    if (!parent) {
      const jobs = new Set<Job>();
      parent = {
        jobs,
        abort: () => {
          for (const item of [...jobs]) item.controller.abort(signal.reason);
        },
      };
      this.#parents.set(signal, parent);
      signal.addEventListener("abort", parent.abort, { once: true });
    }
    parent.jobs.add(job);
  }

  #detachParent(job: Job): void {
    const parent = this.#parents.get(job.parentSignal);
    if (!parent) return;
    parent.jobs.delete(job);
    if (parent.jobs.size !== 0) return;
    job.parentSignal.removeEventListener("abort", parent.abort);
    this.#parents.delete(job.parentSignal);
  }

  #canStart(kind: Kind): boolean {
    return (
      this.#active < 6 && (kind === "settlement" || this.#activeHistory < 4)
    );
  }

  #removeQueued(job: Job): void {
    const index = this.#queued.indexOf(job);
    if (index < 0) return;
    this.#queued.splice(index, 1);
    this.#queuedBytes -= job.bytes;
  }

  #drain(): void {
    while (this.#active < 6) {
      let index = this.#queued.findIndex((job) => job.kind === "settlement");
      if (index < 0 && this.#activeHistory < 4)
        index = this.#queued.findIndex((job) => job.kind === "history");
      const job = this.#queued[index];
      if (!job) return;
      this.#removeQueued(job);
      if (job.parentSignal.aborted)
        job.controller.abort(job.parentSignal.reason);
      else if (!job.controller.signal.aborted) job.start();
    }
  }
}

export const controlHistoryReadBudget = new ControlHistoryReadBudget();
