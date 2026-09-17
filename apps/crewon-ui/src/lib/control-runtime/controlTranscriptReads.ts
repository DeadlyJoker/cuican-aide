type Read<T> = {
  cursor: string | null;
  mode: string;
  controller: AbortController;
  promise: Promise<T>;
};

/** One replaceable read per Thread; retain only three small browsing positions. */
export class ControlTranscriptReads<T> {
  readonly #positions = new Map<string, string | null>();
  readonly #reads = new Map<string, Read<T>>();
  #closed = false;

  run(input: {
    threadId: string;
    cursor?: string | null;
    mode: string;
    signal?: AbortSignal;
    read(cursor: string | null, signal: AbortSignal): Promise<T>;
  }): Promise<T> {
    if (this.#closed)
      return Promise.reject(new Error("control_thread_runtime_closed"));
    if (input.signal?.aborted) return Promise.reject(input.signal.reason);
    const cursor =
      input.cursor === undefined
        ? (this.#positions.get(input.threadId) ?? null)
        : input.cursor;
    const prior = this.#reads.get(input.threadId);
    // A Run/Plan can advance without changing the Thread revision. A refresh
    // must supersede an older read even when its browsing cursor is identical.
    prior?.controller.abort(new Error("control_thread_projection_superseded"));
    this.#positions.delete(input.threadId);
    this.#positions.set(input.threadId, cursor);
    while (this.#positions.size > 3)
      this.#positions.delete(this.#positions.keys().next().value!);
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("control_transcript_read_timeout")),
      30_000,
    );
    const read: Read<T> = {
      cursor,
      mode: input.mode,
      controller,
      promise: Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return waitForControlTranscriptRead(
            input.read(cursor, controller.signal),
            controller.signal,
          );
        })
        .finally(() => {
          clearTimeout(timer);
          controller.abort();
          input.signal?.removeEventListener("abort", abort);
          if (this.#reads.get(input.threadId) === read)
            this.#reads.delete(input.threadId);
        }),
    };
    this.#reads.set(input.threadId, read);
    return read.promise;
  }

  reset(threadId: string): void {
    this.#positions.delete(threadId);
    this.#reads
      .get(threadId)
      ?.controller.abort(new Error("control_thread_projection_superseded"));
  }

  close(): void {
    this.#closed = true;
    for (const read of this.#reads.values()) read.controller.abort();
    this.#positions.clear();
    this.#reads.clear();
  }
}

export function waitForControlTranscriptRead<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
