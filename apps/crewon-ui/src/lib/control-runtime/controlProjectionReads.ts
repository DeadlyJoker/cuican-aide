export type ControlProjectionRead = Readonly<{
  assertCurrent(): void;
  defer(callback: () => void): void;
}>;

type Owner = {
  reading: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
};

/** Ownership ends after the read and its deferred stream starts finish. */
export class ControlProjectionReads {
  readonly #owners = new Map<string, Owner>();
  #closed = false;

  get activeThreadCount(): number {
    return this.#owners.size;
  }

  async run<T>(
    threadId: string,
    read: (owner: ControlProjectionRead) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) throw new Error("control_thread_projection_superseded");
    const previous = this.#owners.get(threadId);
    const owner: Owner = { reading: true, timers: new Set() };
    this.#owners.set(threadId, owner);
    if (previous) this.#cancelTimers(previous);
    const assertCurrent = () => {
      if (this.#closed || this.#owners.get(threadId) !== owner) {
        throw new Error("control_thread_projection_superseded");
      }
    };
    const releaseIfFinished = () => {
      if (
        !owner.reading &&
        owner.timers.size === 0 &&
        this.#owners.get(threadId) === owner
      ) {
        this.#owners.delete(threadId);
      }
    };
    let completed = false;
    try {
      const result = await read({
        assertCurrent,
        defer: (callback) => {
          assertCurrent();
          const timer = setTimeout(() => {
            owner.timers.delete(timer);
            try {
              if (!this.#closed && this.#owners.get(threadId) === owner)
                callback();
            } finally {
              releaseIfFinished();
            }
          }, 0);
          owner.timers.add(timer);
        },
      });
      assertCurrent();
      completed = true;
      return result;
    } finally {
      owner.reading = false;
      if (!completed) this.#cancelTimers(owner);
      releaseIfFinished();
    }
  }

  close(): void {
    this.#closed = true;
    for (const owner of this.#owners.values()) this.#cancelTimers(owner);
    this.#owners.clear();
  }

  #cancelTimers(owner: Owner): void {
    for (const timer of owner.timers) clearTimeout(timer);
    owner.timers.clear();
  }
}
