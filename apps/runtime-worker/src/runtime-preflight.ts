import {
  RuntimeAuthorityError,
  RuntimeAuthorityQuery,
  systemAuthorityTime,
  type AuthorityTime,
} from "./runtime-authority-query.ts";

const MAX_WORKER_REQUESTS = 4;
const MAX_PROCESS_REQUESTS = 8;
let processRequests = 0;

export type RuntimePreflightIdentity = Readonly<{
  tenantId: string;
  kind: "runtime" | "priorCompactor" | "policy";
  resourceId: string;
}>;

type Pending = {
  query: RuntimeAuthorityQuery<unknown>;
  logical: Promise<unknown> | null;
  expired: boolean;
};

/** Read-only execution prerequisites retain physical owners without blocking unrelated work. */
export class RuntimePreflight {
  readonly #time: AuthorityTime;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Pending>();
  #closed = false;
  #lastFailureCode: string | null = null;

  constructor(input: { leaseDurationMs: number; time?: AuthorityTime }) {
    this.#time = input.time ?? systemAuthorityTime;
    this.#timeoutMs = Math.max(
      1,
      Math.min(10000, Math.floor(input.leaseDurationMs / 3)),
    );
  }

  run<T>(input: {
    identity: RuntimePreflightIdentity;
    operation(): T | Promise<T>;
  }): Promise<T> {
    if (this.#closed)
      return Promise.reject(
        new RuntimeAuthorityError("runtime_worker_closing"),
      );
    const { tenantId, kind, resourceId } = input.identity;
    if (
      tenantId.length === 0 ||
      tenantId.length > 256 ||
      resourceId.length === 0 ||
      resourceId.length > 1024
    )
      return Promise.reject(
        new RuntimeAuthorityError("runtime_preflight_failed"),
      );
    const key = JSON.stringify([tenantId, kind, resourceId]);
    const existing = this.#pending.get(key);
    if (existing !== undefined) {
      if (!existing.expired && existing.logical !== null)
        return existing.logical as Promise<T>;
      return Promise.reject(
        new RuntimeAuthorityError("runtime_preflight_pending"),
      );
    }
    if (
      this.#pending.size >= MAX_WORKER_REQUESTS ||
      processRequests >= MAX_PROCESS_REQUESTS
    ) {
      this.#lastFailureCode = "runtime_preflight_capacity";
      return Promise.reject(
        new RuntimeAuthorityError("runtime_preflight_capacity"),
      );
    }
    const query = new RuntimeAuthorityQuery<unknown>({
      time: this.#time,
      timeoutMs: this.#timeoutMs,
      timeoutCode: "runtime_preflight_timeout",
      failureCode: "runtime_preflight_failed",
      onFailure: (error) => {
        pending.expired = true;
        this.#lastFailureCode = error.code;
      },
    });
    const pending: Pending = { query, logical: null, expired: false };
    this.#pending.set(key, pending);
    processRequests++;
    pending.logical = query
      .run({
        key,
        operation: async () => {
          try {
            return { ok: true as const, value: await input.operation() };
          } catch (error) {
            return { ok: false as const, error };
          } finally {
            if (this.#pending.get(key) === pending) this.#pending.delete(key);
            processRequests--;
          }
        },
        confirmed() {},
      })
      .then((value) => {
        if (this.#closed)
          throw new RuntimeAuthorityError("runtime_worker_closing");
        const result = value as
          | { ok: true; value: T }
          | { ok: false; error: unknown };
        if (!result.ok) throw result.error;
        return result.value;
      });
    return pending.logical as Promise<T>;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new RuntimeAuthorityError("runtime_worker_closing");
    for (const { query } of this.#pending.values()) query.invalidate(error);
  }

  snapshot() {
    return {
      pendingRequests: this.#pending.size,
      processRequests,
      maxWorkerRequests: MAX_WORKER_REQUESTS,
      maxProcessRequests: MAX_PROCESS_REQUESTS,
      timeoutMs: this.#timeoutMs,
      lastFailureCode: this.#lastFailureCode,
      closed: this.#closed,
    };
  }
}
