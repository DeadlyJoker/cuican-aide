export interface OutboxWakeupPort {
  /** Best-effort non-rejecting wake-up; durable scanning remains authoritative. */
  wake(): Promise<void>;
}

const observed = new WeakSet<Promise<void>>();

/** HTTP state is already durable; a wakeup failure is retried by queue scanning. */
export function wakeOutbox(outbox: OutboxWakeupPort): void {
  try {
    const pending = outbox.wake();
    if (observed.has(pending)) return;
    observed.add(pending);
    // Dispatchers coalesce triggers onto one pending operation. Attaching one
    // catch per HTTP request would retain every callback until that I/O settles.
    void pending.catch(() => {});
  } catch {
    // A synchronous adapter failure cannot undo the committed HTTP operation.
  }
}
