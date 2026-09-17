import { RunStoreError } from "@crewon/application";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { postgresQueryClient } from "./postgres-query-client.ts";

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (error?: Error | boolean) => void,
) => void;
type Limits = Readonly<{
  maximumPendingConnections: number;
  maximumClientQueries: number;
  queryTimeoutMs: number;
  checkoutTimeoutMs: number;
  closeTimeoutMs: number;
}>;

/** Shared by the authorities using one owned pool; no independent retry queue. */
export class BoundedPostgresPool extends Pool {
  readonly #limits: Limits;
  readonly #pending = new Set<Promise<void>>();
  readonly #leases = new Map<PoolClient, () => void>();
  #closing: Promise<void> | null = null;
  #failureCount = 0;
  #lastFailureCode: string | null = null;

  constructor(config: PoolConfig, overrides: Partial<Limits> = {}) {
    const statementTimeout =
      typeof config.statement_timeout === "number"
        ? config.statement_timeout
        : 30_000;
    const limits: Limits = {
      maximumPendingConnections: Math.max(32, 2 * (config.max ?? 10)),
      maximumClientQueries: 32,
      queryTimeoutMs:
        statementTimeout +
        Math.ceil(Math.min(1_000, Math.max(50, statementTimeout / 10))),
      checkoutTimeoutMs: Math.max(60_000, 4 * statementTimeout),
      closeTimeoutMs: 5_000,
      ...overrides,
    };
    for (const [key, maximum] of [
      ["maximumPendingConnections", 200],
      ["maximumClientQueries", 128],
      ["queryTimeoutMs", 310_000],
      ["closeTimeoutMs", 30_000],
      ["checkoutTimeoutMs", 1_200_000],
    ] as const) {
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > maximum
      )
        throw new RunStoreError("postgres_resource_limits_invalid");
    }
    let observeFailure: (code: string) => void = () => {};
    const options = {
      ...config,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
      // A driver read timeout can return before physically ending its query.
      // The owned client supplies the deadline and discards that connection.
      query_timeout: 0,
      Client: postgresQueryClient({
        ...limits,
        onFailure: (code) => observeFailure(code),
      }),
    };
    super(options);
    this.#limits = limits;
    observeFailure = (code) => {
      this.#failureCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#failureCount + 1,
      );
      this.#lastFailureCode = code;
    };
    this.on("error", () => observeFailure("postgres_idle_connection_lost"));
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const error =
      this.ending || this.#closing !== null
        ? new RunStoreError("postgres_pool_closed")
        : this.waitingCount >= this.#limits.maximumPendingConnections
          ? new RunStoreError("postgres_connection_capacity_exhausted")
          : null;
    if (error !== null) {
      if (callback !== undefined) {
        queueMicrotask(() => callback(error, undefined, () => {}));
        return;
      }
      return Promise.reject(error);
    }
    const acquire = (done: ConnectCallback) => {
      let finished!: () => void;
      const pending = new Promise<void>((resolve) => {
        finished = resolve;
      });
      this.#pending.add(pending);
      super.connect((error, client) => {
        this.#pending.delete(pending);
        finished();
        if (error !== undefined || client === undefined) {
          done(
            error ?? new RunStoreError("postgres_connection_failed"),
            undefined,
            () => {},
          );
          return;
        }
        if (this.ending || this.#closing !== null) {
          client.release(true);
          done(new RunStoreError("postgres_pool_closed"), undefined, () => {});
          return;
        }
        const originalRelease = client.release.bind(client);
        let released = false,
          forced = false;
        const release = (error?: Error | boolean) => {
          if (released) {
            if (forced) return; // A transaction's late finally after bounded shutdown.
            throw new RunStoreError("postgres_client_already_released");
          }
          released = true;
          clearTimeout(checkoutTimer);
          this.#leases.delete(client);
          originalRelease(error);
        };
        client.release = release;
        const forceRelease = () => {
          forced = true;
          release(true);
        };
        const checkoutTimer = setTimeout(() => {
          this.#failureCount = Math.min(
            Number.MAX_SAFE_INTEGER,
            this.#failureCount + 1,
          );
          this.#lastFailureCode = "postgres_checkout_deadline_exceeded";
          forceRelease();
        }, this.#limits.checkoutTimeoutMs);
        checkoutTimer.unref();
        this.#leases.set(client, forceRelease);
        done(undefined, client, release);
      });
    };
    if (callback !== undefined) {
      acquire(callback);
      return;
    }
    return new Promise<PoolClient>((resolve, reject) => {
      acquire((error, client) =>
        error === undefined ? resolve(client!) : reject(error),
      );
    });
  }

  override end(): Promise<void>;
  override end(callback: () => void): void;
  override end(callback?: () => void): Promise<void> | void {
    if (this.#closing === null) {
      const pending = [...this.#pending];
      const timer = setTimeout(() => {
        for (const release of this.#leases.values()) release();
      }, this.#limits.closeTimeoutMs);
      this.#closing = Promise.all([super.end(), ...pending])
        .then(() => {})
        .finally(() => clearTimeout(timer));
    }
    if (callback !== undefined) {
      void this.#closing.then(callback);
      return;
    }
    return this.#closing;
  }

  resourceSnapshot() {
    return {
      totalConnections: this.totalCount,
      idleConnections: this.idleCount,
      waitingConnections: this.waitingCount,
      pendingAcquisitions: this.#pending.size,
      borrowedConnections: this.#leases.size,
      maximumPendingConnections: this.#limits.maximumPendingConnections,
      failures: this.#failureCount,
      lastFailureCode: this.#lastFailureCode,
      closing: this.#closing !== null,
    };
  }
}
