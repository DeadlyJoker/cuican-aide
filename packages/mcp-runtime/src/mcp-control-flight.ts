import { McpRuntimeError } from "./mcp-runtime-error.ts";

type Waiter = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  onAbort(): void;
};
type Flight = {
  controller: AbortController;
  waiters: Map<AbortSignal, Waiter>;
};

/** One catalog operation, with bounded, independently cancelable callers. */
export class McpControlFlight {
  #active: Flight | null = null;
  #closed = false;

  get pending(): boolean {
    return this.#active !== null;
  }

  run(
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.#closed)
      return Promise.reject(new McpRuntimeError("mcp_catalog_closed"));
    if (signal.aborted) return Promise.reject(signal.reason);
    const prior = this.#active;
    if (prior?.controller.signal.aborted)
      return Promise.reject(new McpRuntimeError("mcp_catalog_update_stopping"));
    const duplicate = prior?.waiters.get(signal);
    if (duplicate !== undefined) return duplicate.promise;
    if ((prior?.waiters.size ?? 0) >= 32)
      return Promise.reject(
        new McpRuntimeError("mcp_catalog_waiter_limit_exceeded"),
      );
    const flight = prior ?? {
      controller: new AbortController(),
      waiters: new Map<AbortSignal, Waiter>(),
    };
    this.#active = flight;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      flight.waiters.delete(signal);
      reject(signal.reason);
      if (flight.waiters.size === 0)
        flight.controller.abort(
          new McpRuntimeError("mcp_catalog_update_aborted"),
        );
    };
    flight.waiters.set(signal, { promise, resolve, reject, onAbort });
    signal.addEventListener("abort", onAbort, { once: true });
    if (prior === null) {
      void Promise.resolve()
        .then(() => {
          flight.controller.signal.throwIfAborted();
          return action(flight.controller.signal);
        })
        .then(
          () => this.#finish(flight, { ok: true }),
          (error: unknown) => this.#finish(flight, { ok: false, error }),
        );
    }
    return promise;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const flight = this.#active;
    if (flight === null) return;
    const error = new McpRuntimeError("mcp_catalog_closed");
    flight.controller.abort(error);
    this.#settleWaiters(flight, { ok: false, error });
  }

  #finish(
    flight: Flight,
    result: { ok: true } | { ok: false; error: unknown },
  ): void {
    if (this.#active === flight) this.#active = null;
    // A failed group operation must also cancel sibling requests still in flight.
    if (!result.ok) flight.controller.abort(result.error);
    this.#settleWaiters(flight, result);
  }

  #settleWaiters(
    flight: Flight,
    result: { ok: true } | { ok: false; error: unknown },
  ): void {
    for (const [signal, waiter] of flight.waiters) {
      signal.removeEventListener("abort", waiter.onAbort);
      if (result.ok) waiter.resolve();
      else waiter.reject(result.error);
    }
    flight.waiters.clear();
  }
}
