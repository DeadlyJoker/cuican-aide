type Readers = { count: number; controller: AbortController };

/** Keep shared history while a Thread read still needs it; never own live Runs. */
export class ControlToolHistoryReaders {
  readonly #threads = new Map<string, Readers>();
  #closed = false;

  async run<T>(
    threadId: string,
    read: (historySignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) throw new Error("control_thread_runtime_closed");
    let readers = this.#threads.get(threadId);
    if (!readers) {
      readers = { count: 0, controller: new AbortController() };
      this.#threads.set(threadId, readers);
    }
    // Acquire synchronously, before a replacement cancels the previous read.
    readers.count++;
    try {
      return await read(readers.controller.signal);
    } finally {
      readers.count--;
      if (readers.count === 0) {
        if (this.#threads.get(threadId) === readers)
          this.#threads.delete(threadId);
        readers.controller.abort();
      }
    }
  }

  close(): void {
    this.#closed = true;
    for (const readers of this.#threads.values()) readers.controller.abort();
    this.#threads.clear();
  }
}
