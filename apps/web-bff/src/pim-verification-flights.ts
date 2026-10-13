type Flight<T> = {
  startedAt: number;
  controller: AbortController;
  readers: number;
  result: Promise<T>;
};

/** Coalesces only an in-progress live verification; never prolongs its freshness. */
export class PimVerificationFlights<T> {
  readonly #pending = new Map<string, Flight<T>>();
  read(input: {
    key: string;
    signal: AbortSignal;
    now: number;
    verify(signal: AbortSignal): Promise<T>;
  }): Promise<{ value: T; startedAt: number }> {
    input.signal.throwIfAborted();
    let flight = this.#pending.get(input.key);
    if (flight?.controller.signal.aborted) {
      this.#pending.delete(input.key);
      flight = undefined;
    }
    if (!flight) {
      if (this.#pending.size >= 1000)
        throw new Error("pim_verification_capacity");
      const controller = new AbortController();
      flight = {
        startedAt: input.now,
        controller,
        readers: 0,
        result: Promise.resolve().then(() => input.verify(controller.signal)),
      };
      const owned = flight;
      this.#pending.set(input.key, owned);
      const clear = () => {
        if (this.#pending.get(input.key) === owned)
          this.#pending.delete(input.key);
      };
      void owned.result.then(clear, clear);
    }
    const owned = flight;
    owned.readers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const close = () => {
        if (settled) return false;
        settled = true;
        input.signal.removeEventListener("abort", abort);
        owned.readers--;
        return true;
      };
      const abort = () => {
        if (!close()) return;
        if (owned.readers === 0) owned.controller.abort();
        reject(input.signal.reason);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      void owned.result.then(
        (value) => {
          if (close()) resolve({ value, startedAt: owned.startedAt });
        },
        (error) => {
          if (close()) reject(error);
        },
      );
      if (input.signal.aborted) abort();
    });
  }
}
