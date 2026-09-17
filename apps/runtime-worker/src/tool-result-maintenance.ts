import type { DomainStore } from "@crewon/application";
import {
  ToolBrokerError,
  type ScopedRetainedToolExecutionResult,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import { reconcileCommittedToolResult } from "./committed-tool-result.ts";
import { ToolResultMaintenanceQuery } from "./tool-result-maintenance-query.ts";
import {
  externalResourceLease,
  type RuntimeResourceLease,
} from "./runtime-resource-lease.ts";

const PASS_LIMIT = 16;
const PASS_BUDGET_MS = 25;
export type ToolResultMaintenanceSnapshot = Readonly<{
  inspected: number;
  acknowledged: number;
  failures: number;
  pending: boolean;
  receiptReads: number;
  processReceiptReads: number;
  maxProcessReceiptReads: number;
}>;

/** Repairs local ownership across Runs; at most one physical receipt read is outstanding. */
export class ToolResultMaintenance {
  readonly #store: Pick<DomainStore, "loadToolExecutionReceiptByAction">;
  readonly #nextRuntimeLease: () => RuntimeResourceLease<ToolRuntimePort> | null;
  readonly #queries = new ToolResultMaintenanceQuery();
  #running: Promise<void> | null = null;
  #closed = false;
  #last = { inspected: 0, acknowledged: 0, failures: 0 };

  constructor(
    input: {
      store: Pick<DomainStore, "loadToolExecutionReceiptByAction">;
    } & (
      | { nextRuntime: () => ToolRuntimePort | null; nextRuntimeLease?: never }
      | {
          nextRuntimeLease: () => RuntimeResourceLease<ToolRuntimePort> | null;
          nextRuntime?: never;
        }
    ),
  ) {
    this.#store = input.store;
    this.#nextRuntimeLease =
      input.nextRuntimeLease ??
      (() => {
        const runtime = input.nextRuntime!();
        return runtime === null ? null : externalResourceLease(runtime);
      });
  }

  snapshot(): ToolResultMaintenanceSnapshot {
    return {
      ...this.#last,
      pending: this.#running !== null,
      ...this.#queries.snapshot(),
    };
  }

  poll(): Promise<ToolResultMaintenanceSnapshot> {
    // Repeated wakes do not attach Promise reactions to a stalled Store query.
    if (this.#closed || this.#running !== null || !this.#queries.available)
      return Promise.resolve(this.snapshot());
    this.#last = { inspected: 0, acknowledged: 0, failures: 0 };
    const work = this.#runPass()
      .catch(() => {
        this.#last.failures++;
      })
      .finally(() => {
        if (this.#running === work) this.#running = null;
      });
    this.#running = work;
    return new Promise((resolve) => {
      const timeout = setTimeout(
        () => resolve(this.snapshot()),
        PASS_BUDGET_MS,
      );
      void work.then(() => {
        clearTimeout(timeout);
        resolve(this.snapshot());
      });
    });
  }

  close(): void {
    this.#closed = true;
    this.#queries.close();
  }

  async #runPass(): Promise<void> {
    const lease = this.#nextRuntimeLease();
    if (lease === null) return;
    try {
      await this.#inspect(lease.resource);
    } finally {
      lease.release();
    }
  }

  async #inspect(runtime: ToolRuntimePort): Promise<void> {
    const deadline = performance.now() + PASS_BUDGET_MS;
    if (
      runtime?.scanRetainedExecutionResults === undefined ||
      runtime.acknowledgeExecutionResult === undefined
    )
      return;
    const seen = new Set<string>();
    for (let scanned = 0; scanned < PASS_LIMIT; scanned++) {
      if (
        this.#closed ||
        !this.#queries.available ||
        performance.now() >= deadline
      )
        break;
      // Advance one metadata slot at a time. A slow first lookup cannot make
      // an entire prefetched batch repeat with its tail permanently unvisited.
      const results = runtime.scanRetainedExecutionResults({ limit: 1 });
      if (!Array.isArray(results) || results.length > 1)
        throw new ToolBrokerError("tool_result_query_limit_invalid");
      const result = results[0];
      if (result === undefined) continue;
      try {
        validateMetadata(result);
        const identity = JSON.stringify([
          result.tenantId,
          result.runId,
          result.executionId,
        ]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        this.#last.inspected++;
        if (
          await reconcileCommittedToolResult({
            runtime,
            store: {
              loadToolExecutionReceiptByAction: (query) =>
                this.#queries.read({ store: this.#store, query }),
            },
            tenantId: result.tenantId,
            runId: result.runId,
            result,
            mayAcknowledge: () => !this.#closed,
          })
        )
          this.#last.acknowledged++;
      } catch {
        // Keep evidence and rotate onward; one bad receipt must not occupy every later pass.
        this.#last.failures++;
      }
    }
  }
}

function validateMetadata(result: ScopedRetainedToolExecutionResult): void {
  if (result === null || typeof result !== "object")
    throw new ToolBrokerError("tool_result_metadata_invalid");
  for (const value of [
    result.tenantId,
    result.runId,
    result.executionId,
    result.idempotencyKey,
    result.actionDigest,
    result.name,
  ]) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 512 ||
      value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      throw new ToolBrokerError("tool_result_metadata_invalid");
  }
  if (result.kind !== "function" && result.kind !== "custom")
    throw new ToolBrokerError("tool_result_metadata_invalid");
}
