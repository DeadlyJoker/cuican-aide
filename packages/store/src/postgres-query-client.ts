import { RunStoreError } from "@crewon/application";
import { Client, type ClientConfig, type QueryResult } from "pg";

/** Store queries use the ordinary pg Promise/callback API, never cursor submissions. */
export function postgresQueryClient(limits: {
  queryTimeoutMs: number;
  maximumClientQueries: number;
  onFailure(code: string): void;
}) {
  return class DeadlinePostgresClient extends Client {
    #pending = 0;
    #unavailable = false;
    #closing: Promise<void> | null = null;

    constructor(config?: string | ClientConfig) {
      super(config);
      // pg rejects active queries on transport failure. An idle/checked-out
      // client's error event must not crash the host before recovery can run.
      this.on("error", () => {
        this.#unavailable = true;
        limits.onFailure("postgres_connection_lost");
      });
    }

    override query: Client["query"] = ((...args: unknown[]) => {
      const config = args[0];
      if (config !== null && typeof config === "object" && "submit" in config)
        throw new RunStoreError("postgres_query_shape_unsupported");
      const last = args.at(-1);
      const suppliedCallback = (
        typeof last === "function" ? last : undefined
      ) as ((error: Error | null, result?: QueryResult) => void) | undefined;
      const values = typeof args[1] === "function" ? undefined : args[1];
      const failure = this.#unavailable
        ? new RunStoreError("postgres_connection_unavailable")
        : this.#pending >= limits.maximumClientQueries
          ? new RunStoreError("postgres_query_capacity_exhausted")
          : null;
      if (failure !== null) {
        if (suppliedCallback !== undefined) {
          queueMicrotask(() => suppliedCallback(failure));
          return;
        }
        return Promise.reject(failure);
      }
      const dispatch = (
        callback: (error: Error | null, result?: QueryResult) => void,
      ) => {
        this.#pending++;
        let settled = false;
        const finish = (error: Error | null, result?: QueryResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#pending--;
          callback(error, result);
        };
        const timer = setTimeout(() => {
          this.#unavailable = true;
          limits.onFailure("postgres_query_deadline_exceeded");
          // Destroy the connection rather than just rejecting a Promise while
          // pg continues to queue new commands behind the old physical query.
          void this.end().catch(() => {});
          finish(new RunStoreError("postgres_query_deadline_exceeded"));
        }, limits.queryTimeoutMs);
        try {
          // pg itself normalizes text/config, values and result row modes.
          const query = Client.prototype.query as (
            config: unknown,
            values: unknown,
            callback?: typeof finish,
          ) => Promise<QueryResult> | void;
          const driverConfig =
            config !== null && typeof config === "object"
              ? { ...config, query_timeout: 0 }
              : config;
          if (suppliedCallback === undefined) {
            // Preserve the original API mode for pg instrumentation and Store
            // snapshot/fault-injection boundaries that observe its Promise.
            void (
              query.call(this, driverConfig, values) as Promise<QueryResult>
            ).then(
              (result) => finish(null, result),
              (error: Error) => finish(error),
            );
          } else query.call(this, driverConfig, values, finish);
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new RunStoreError("postgres_query_invalid"),
          );
        }
      };
      if (suppliedCallback !== undefined) {
        dispatch(suppliedCallback);
        return;
      }
      return new Promise<QueryResult>((resolve, reject) => {
        dispatch((error, result) =>
          error === null ? resolve(result!) : reject(error),
        );
      });
    }) as Client["query"];

    override end(): Promise<void>;
    override end(callback: (error: Error) => void): void;
    override end(callback?: (error: Error) => void): Promise<void> | void {
      this.#unavailable = true;
      this.#closing ??= super.end();
      if (callback !== undefined) {
        void this.#closing.then(
          () => callback(undefined as unknown as Error),
          callback,
        );
        return;
      }
      return this.#closing;
    }
  };
}
