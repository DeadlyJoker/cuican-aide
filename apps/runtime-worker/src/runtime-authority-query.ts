import { ApplicationError } from "@crewon/application";

type AuthorityFailure =
  | "lease_confirmation_timeout"
  | "lease_confirmation_failed"
  | "execution_progress_query_timeout"
  | "cancellation_confirmation_timeout"
  | "execution_progress_query_failed"
  | "cancellation_confirmation_failed"
  | "runtime_watch_query_pending"
  | "runtime_store_access_timeout"
  | "runtime_store_access_failed"
  | "runtime_store_access_capacity"
  | "runtime_preflight_timeout"
  | "runtime_preflight_failed"
  | "runtime_preflight_pending"
  | "runtime_preflight_capacity"
  | "runtime_worker_closing";

/** The host gives up execution authority; this does not declare the Run canceled. */
export class RuntimeAuthorityError extends ApplicationError {
  constructor(code: AuthorityFailure) {
    super("conflict", code);
    this.name = "RuntimeAuthorityError";
    this.stack = this.message;
  }
}

export type AuthorityInstant = Readonly<{ wall: number; steady: number }>;
export interface AuthorityTime {
  now(): AuthorityInstant;
  after(delayMs: number, callback: () => void): () => void;
}
export const systemAuthorityTime: AuthorityTime = {
  now: () => ({ wall: Date.now(), steady: performance.now() }),
  after: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
export function authorityElapsed(
  time: AuthorityTime,
  started: AuthorityInstant,
): number {
  const now = time.now();
  // Wall time covers sleep on clocks that pause their monotonic counter;
  // monotonic time prevents a backwards wall-clock change extending authority.
  return Math.max(0, now.wall - started.wall, now.steady - started.steady);
}

type Flight<T> = {
  key: string;
  logical: Promise<T>;
  fail: (error: RuntimeAuthorityError) => void;
  settled: boolean;
};

/** One physical query, even after its logical caller has timed out or closed. */
export class RuntimeAuthorityQuery<T> {
  readonly #time: AuthorityTime;
  readonly #timeoutMs: number;
  readonly #timeoutCode:
    | "lease_confirmation_timeout"
    | "execution_progress_query_timeout"
    | "runtime_store_access_timeout"
    | "runtime_preflight_timeout"
    | "cancellation_confirmation_timeout";
  readonly #failureCode:
    | "lease_confirmation_failed"
    | "execution_progress_query_failed"
    | "runtime_store_access_failed"
    | "runtime_preflight_failed"
    | "cancellation_confirmation_failed";
  readonly #onFailure: (error: RuntimeAuthorityError) => void;
  #physical: Flight<T> | null = null;

  constructor(input: {
    time: AuthorityTime;
    timeoutMs: number;
    timeoutCode:
      | "lease_confirmation_timeout"
      | "execution_progress_query_timeout"
      | "runtime_store_access_timeout"
      | "runtime_preflight_timeout"
      | "cancellation_confirmation_timeout";
    failureCode:
      | "lease_confirmation_failed"
      | "execution_progress_query_failed"
      | "runtime_store_access_failed"
      | "runtime_preflight_failed"
      | "cancellation_confirmation_failed";
    onFailure(error: RuntimeAuthorityError): void;
  }) {
    this.#time = input.time;
    this.#timeoutMs = input.timeoutMs;
    this.#timeoutCode = input.timeoutCode;
    this.#failureCode = input.failureCode;
    this.#onFailure = input.onFailure;
  }

  get pending(): boolean {
    return this.#physical !== null;
  }

  run(input: {
    key: string;
    operation(): Promise<T>;
    confirmed(value: T, started: AuthorityInstant): void;
  }): Promise<T> {
    const existing = this.#physical;
    if (existing !== null) {
      if (existing.key === input.key && !existing.settled)
        return existing.logical;
      throw new RuntimeAuthorityError("runtime_watch_query_pending");
    }
    const started = this.#time.now();
    let resolve!: (value: T) => void,
      reject!: (error: RuntimeAuthorityError) => void;
    const logical = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const flight: Flight<T> = {
      key: input.key,
      logical,
      settled: false,
      fail: () => {},
    };
    this.#physical = flight;
    const fail = (error: RuntimeAuthorityError) => {
      if (flight.settled) return;
      flight.settled = true;
      cancelDeadline();
      this.#onFailure(error);
      reject(error);
    };
    flight.fail = fail;
    const cancelDeadline = this.#time.after(this.#timeoutMs, () =>
      fail(new RuntimeAuthorityError(this.#timeoutCode)),
    );
    const complete = (value: T) => {
      if (this.#physical === flight) this.#physical = null;
      if (flight.settled) return;
      if (authorityElapsed(this.#time, started) >= this.#timeoutMs) {
        fail(new RuntimeAuthorityError(this.#timeoutCode));
        return;
      }
      try {
        input.confirmed(value, started);
      } catch {
        fail(new RuntimeAuthorityError(this.#failureCode));
        return;
      }
      flight.settled = true;
      cancelDeadline();
      resolve(value);
    };
    const failed = () => {
      if (this.#physical === flight) this.#physical = null;
      fail(new RuntimeAuthorityError(this.#failureCode));
    };
    try {
      void input.operation().then(complete, failed);
    } catch {
      failed();
    }
    return logical;
  }

  invalidate(error: RuntimeAuthorityError): void {
    this.#physical?.fail(error);
  }
}
