import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeWorker } from "./runtime-worker.ts";

/** Coordinate the fault-injection boundary without changing any production deadline. */
export async function waitForWorkerQueries(
  worker: RuntimeWorker,
  expected: { pendingRequests: number },
): Promise<void> {
  const deadline = performance.now() + 5000;
  for (;;) {
    const queries = worker.watcherResourceSnapshot();
    const store = worker.storeAccessSnapshot();
    if (
      !queries.renewalPending &&
      !queries.cancellationPending &&
      !queries.progressPending &&
      store.pendingRequests === expected.pendingRequests
    )
      return;
    assert.ok(
      performance.now() < deadline,
      JSON.stringify({ queries, store, expected }),
    );
    await delay(1);
  }
}
