import type { DomainStore } from "@crewon/application";
import {
  RuntimeAuthorityError,
  RuntimeAuthorityQuery,
  systemAuthorityTime,
  authorityElapsed,
  type AuthorityInstant,
  type AuthorityTime,
} from "./runtime-authority-query.ts";

// A sample permits 16 parallel Tool calls; leave room for watchers and accounting.
const MAX_WORKER_REQUESTS = 32;
const MAX_PROCESS_REQUESTS = 128;
let processRequests = 0;

/** Bounds outstanding Store operations, including writes whose commit acknowledgement is unknown. */
export class RuntimeStoreAccess {
  readonly #time: AuthorityTime;
  readonly #timeoutMs: number;
  readonly #onFailure: (error: RuntimeAuthorityError) => void;
  readonly #queries = new Set<RuntimeAuthorityQuery<unknown>>();
  readonly #decorated = new WeakMap<object, object>();
  #failure: RuntimeAuthorityError | null = null;
  #closed = false;
  #closing = false;
  #cancelCloseDeadline: (() => void) | null = null;
  #closeStarted: AuthorityInstant | null = null;
  #resolveClosed!: () => void;
  readonly #whenClosed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });

  constructor(input: {
    leaseDurationMs: number;
    time?: AuthorityTime;
    onFailure(error: RuntimeAuthorityError): void;
  }) {
    this.#time = input.time ?? systemAuthorityTime;
    this.#timeoutMs = Math.max(
      1,
      Math.min(10_000, Math.floor(input.leaseDurationMs / 3)),
    );
    this.#onFailure = input.onFailure;
  }

  /** A new wake cannot accumulate requests behind a physically blocked predecessor. */
  beginWake(): boolean {
    if (this.#closing || this.#closed || this.#queries.size !== 0) return false;
    this.#failure = null;
    return true;
  }

  get pending(): boolean {
    return this.#queries.size !== 0;
  }

  failure(): RuntimeAuthorityError | null {
    return this.#failure;
  }

  whenClosed(): Promise<void> {
    return this.#whenClosed;
  }

  snapshot() {
    return {
      pendingRequests: this.#queries.size,
      processRequests,
      maxWorkerRequests: MAX_WORKER_REQUESTS,
      maxProcessRequests: MAX_PROCESS_REQUESTS,
      timeoutMs: this.#timeoutMs,
      failureCode: this.#failure?.code ?? null,
      closed: this.#closed,
      closing: this.#closing,
    };
  }

  /** Allow bounded settlement when no database request is stuck at shutdown. */
  beginClose(): void {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    this.#closeStarted = this.#time.now();
    this.#cancelCloseDeadline = this.#time.after(this.#timeoutMs, () =>
      this.close(),
    );
    if (this.pending)
      this.#invalidate(new RuntimeAuthorityError("runtime_worker_closing"));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelCloseDeadline?.();
    this.#cancelCloseDeadline = null;
    this.#invalidate(new RuntimeAuthorityError("runtime_worker_closing"));
    this.#resolveClosed();
  }

  /** Only the asynchronous Store port and its two explicit nested ports are decorated. */
  store(store: DomainStore): DomainStore {
    return this.#port(store, "domain");
  }

  #port<T extends object>(target: T, kind: "domain" | "nested"): T {
    const existing = this.#decorated.get(target);
    if (existing !== undefined) return existing as T;
    const decorated = new Proxy(target, {
      get: (receiver, key) => {
        const value: unknown = Reflect.get(receiver, key);
        if (
          kind === "domain" &&
          (key === "executionProgress" || key === "compactionCheckpoints")
        )
          return value === undefined
            ? undefined
            : this.#port(value as object, "nested");
        if (typeof value !== "function") return value;
        // Call the actual receiver so Store private fields and optional capability checks survive.
        return (...args: unknown[]) =>
          this.#run(() => Reflect.apply(value, receiver, args));
      },
    });
    this.#decorated.set(target, decorated);
    return decorated;
  }

  #run(operation: () => Promise<unknown>): Promise<unknown> {
    this.#checkCloseDeadline();
    if (this.#failure !== null) return Promise.reject(this.#failure);
    if (this.#closed)
      return Promise.reject(
        new RuntimeAuthorityError("runtime_worker_closing"),
      );
    if (
      this.#queries.size >= MAX_WORKER_REQUESTS ||
      processRequests >= MAX_PROCESS_REQUESTS
    ) {
      const error = new RuntimeAuthorityError("runtime_store_access_capacity");
      this.#invalidate(error);
      return Promise.reject(error);
    }
    const query = new RuntimeAuthorityQuery<unknown>({
      time: this.#time,
      timeoutMs: this.#timeoutMs,
      timeoutCode: "runtime_store_access_timeout",
      failureCode: "runtime_store_access_failed",
      onFailure: (error) => this.#invalidate(error),
    });
    this.#queries.add(query);
    processRequests++;
    // Retain one physical owner and one completion handler after timeout/close;
    // ordinary Store errors keep their original classification and retry semantics.
    return query
      .run({
        key: "store-operation",
        operation: async () => {
          try {
            return { ok: true as const, value: await operation() };
          } catch (error) {
            return { ok: false as const, error };
          } finally {
            this.#queries.delete(query);
            processRequests--;
          }
        },
        confirmed() {},
      })
      .then((result) => {
        const settled = result as
          | { ok: true; value: unknown }
          | { ok: false; error: unknown };
        // Another concurrent operation may already have revoked this wake's authority.
        this.#checkCloseDeadline();
        if (this.#failure !== null) throw this.#failure;
        if (!settled.ok) throw settled.error;
        return settled.value;
      });
  }

  #checkCloseDeadline(): void {
    if (
      this.#closeStarted !== null &&
      authorityElapsed(this.#time, this.#closeStarted) >= this.#timeoutMs
    )
      this.close();
  }

  #invalidate(error: RuntimeAuthorityError): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    for (const query of this.#queries) query.invalidate(error);
    this.#onFailure(error);
  }
}
