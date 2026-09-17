import {
  ArtifactStoreError,
  type ArtifactRetentionCandidate,
  type ArtifactRetentionGuard,
} from "@crewon/application";

// This process-wide bound includes detached reads from closed/reopened stores. No wait queue.
const MAX_PROCESS_QUERIES = 4;
let processQueries = 0;
type Outcome = { value: boolean } | { error: unknown };
type PendingRead = {
  controller: AbortController;
  observe: ((outcome: Outcome) => void) | null;
};

/** Separate the lifetime of a read from the lifetime of its observer/SQLite authority. */
export class ArtifactRetentionQuery {
  #pending: PendingRead | null = null;
  #closed = false;

  get available(): boolean {
    return (
      !this.#closed &&
      this.#pending === null &&
      processQueries < MAX_PROCESS_QUERIES
    );
  }

  resourceSnapshot() {
    return {
      authorityQueries: this.#pending === null ? 0 : 1,
      processAuthorityQueries: processQueries,
      maxProcessAuthorityQueries: MAX_PROCESS_QUERIES,
      closed: this.#closed,
    };
  }

  check(input: {
    candidate: ArtifactRetentionCandidate;
    guard: ArtifactRetentionGuard;
    signal: AbortSignal;
    maxDurationMs: number;
  }): Promise<boolean> {
    input.signal.throwIfAborted();
    if (
      !Number.isFinite(input.maxDurationMs) ||
      input.maxDurationMs <= 0 ||
      input.maxDurationMs > 5000
    )
      return Promise.reject(
        new ArtifactStoreError("artifact_retention_guard_timeout"),
      );
    if (!this.available)
      return Promise.reject(
        new ArtifactStoreError("artifact_retention_guard_busy"),
      );
    const pending: PendingRead = {
      controller: new AbortController(),
      observe: null,
    };
    this.#pending = pending;
    processQueries++;
    const observed = new Promise<boolean>((resolve, reject) => {
      const onAbort = () => {
        pending.observe?.({ error: input.signal.reason });
        pending.controller.abort("artifact_retention_guard_aborted");
      };
      const timer = setTimeout(
        () => {
          pending.observe?.({
            error: new ArtifactStoreError("artifact_retention_guard_timeout"),
          });
          pending.controller.abort("artifact_retention_guard_timeout");
        },
        Math.max(1, Math.ceil(input.maxDurationMs)),
      );
      timer.unref();
      pending.observe = (outcome) => {
        pending.observe = null;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.value === true);
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
    });
    dispatchRead(input, pending, this.#finish.bind(this));
    return observed;
  }

  #finish(outcome: Outcome): void {
    // Only physical completion releases admission; observer timeout/close cannot release it.
    const pending = this.#pending!;
    this.#pending = null;
    processQueries--;
    pending.observe?.(outcome);
  }

  close(): void {
    this.#closed = true;
    const pending = this.#pending;
    pending?.observe?.({
      error: new ArtifactStoreError("artifact_retention_guard_closed"),
    });
    pending?.controller.abort("artifact_retention_guard_closed");
  }
}

// Keep completion handlers outside the dispatch closure: after invocation they need neither
// the candidate nor its guard. Detaching the observer releases the maintenance continuation.
function dispatchRead(
  input: {
    candidate: ArtifactRetentionCandidate;
    guard: ArtifactRetentionGuard;
    maxDurationMs: number;
  },
  pending: PendingRead,
  finish: (outcome: Outcome) => void,
): void {
  const work = Promise.resolve().then(() => {
    pending.controller.signal.throwIfAborted();
    return input.guard.canRetireArtifact(input.candidate, {
      signal: pending.controller.signal,
      maxDurationMs: input.maxDurationMs,
    });
  });
  observeCompletion(work, finish);
}

function observeCompletion(
  work: Promise<boolean>,
  finish: (outcome: Outcome) => void,
): void {
  void work.then(
    (value) => finish({ value }),
    (error: unknown) => finish({ error }),
  );
}
