import type { RunLifecycleEvent } from "@crewon/domain";

export class RunEventHub {
  readonly #subscriptions = new Map<string, Set<RunEventSubscription>>();
  readonly #maxPendingEvents: number;
  #closed = false;

  constructor(maxPendingEvents = 64) {
    if (!Number.isSafeInteger(maxPendingEvents) || maxPendingEvents < 1) {
      throw new Error("max_pending_events_invalid");
    }
    this.#maxPendingEvents = maxPendingEvents;
  }

  subscribe(runId: string): RunEventSubscription {
    if (this.#closed) {
      throw new Error("run_event_hub_closed");
    }
    const subscription = new RunEventSubscription(this.#maxPendingEvents, () =>
      this.#remove(runId, subscription),
    );
    const subscriptions = this.#subscriptions.get(runId) ?? new Set();
    subscriptions.add(subscription);
    this.#subscriptions.set(runId, subscriptions);
    return subscription;
  }

  publish(events: readonly RunLifecycleEvent[]): void {
    if (this.#closed) {
      return;
    }
    for (const event of events) {
      for (const subscription of this.#subscriptions.get(
        event.identity.runId,
      ) ?? []) {
        subscription.push(event);
      }
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const subscriptions of this.#subscriptions.values()) {
      for (const subscription of subscriptions) {
        subscription.close();
      }
    }
    this.#subscriptions.clear();
  }

  #remove(runId: string, subscription: RunEventSubscription): void {
    const subscriptions = this.#subscriptions.get(runId);
    subscriptions?.delete(subscription);
    if (subscriptions?.size === 0) {
      this.#subscriptions.delete(runId);
    }
  }
}

export class RunEventSubscription
  implements AsyncIterable<RunLifecycleEvent>, AsyncIterator<RunLifecycleEvent>
{
  readonly #queue: RunLifecycleEvent[] = [];
  readonly #waiters: Array<
    (result: IteratorResult<RunLifecycleEvent>) => void
  > = [];
  readonly #maxPendingEvents: number;
  readonly #onClose: () => void;
  #closed = false;

  constructor(maxPendingEvents: number, onClose: () => void) {
    this.#maxPendingEvents = maxPendingEvents;
    this.#onClose = onClose;
  }

  [Symbol.asyncIterator](): AsyncIterator<RunLifecycleEvent> {
    return this;
  }

  next(): Promise<IteratorResult<RunLifecycleEvent>> {
    const event = this.#queue.shift();
    if (event !== undefined) {
      return Promise.resolve({ done: false, value: event });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  return(): Promise<IteratorResult<RunLifecycleEvent>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(event: RunLifecycleEvent): void {
    if (this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: structuredClone(event) });
      return;
    }
    if (this.#queue.length >= this.#maxPendingEvents) {
      this.close();
      return;
    }
    this.#queue.push(structuredClone(event));
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#queue.length = 0;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
    this.#onClose();
  }
}
