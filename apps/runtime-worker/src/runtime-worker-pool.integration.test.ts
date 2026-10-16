import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import { fixture, waitFor } from "./runtime-worker-pool.test-support.ts";
import { runtimeWorkerConcurrency } from "./runtime-worker-pool.ts";

test("bounds Run concurrency and preserves the library's single-lane default", () => {
  assert.equal(runtimeWorkerConcurrency(undefined), 1);
  for (const value of [0, -1, 9, 1.5, NaN, Infinity])
    assert.throws(
      () => runtimeWorkerConcurrency(value),
      /runtime_worker_concurrency_invalid/,
    );
});

test("production composition streams two Runs independently, bounds a third, and preserves history on reopen", async (t) => {
  const f = await fixture(t);
  const runs = await Promise.all([
    f.enqueue("first"),
    f.enqueue("second"),
    f.enqueue("third"),
  ]);
  f.runtime.start();
  await waitFor(() => f.entered.size === 2);
  await waitFor(async () =>
    (
      await Promise.all(
        runs
          .slice(0, 2)
          .map((run) =>
            f.store.listRunEvents(
              { tenantId: "tenant-1", runId: run.runId },
              0,
              100,
            ),
          ),
      )
    ).every((events) =>
      events.some((event) => event.type === "model.output.delta"),
    ),
  );
  // Reconnecting readers recover each stream's own committed prefix while both
  // model calls are still pending; no second model request is needed.
  const streamingReader = new SqliteRunStore(f.databasePath);
  try {
    for (const run of runs.slice(0, 2)) {
      const prefix = await streamingReader.listRunEvents(
        { tenantId: "tenant-1", runId: run.runId },
        0,
        100,
      );
      assert.equal(
        prefix.filter((event) => event.type === "model.output.delta").length,
        1,
      );
      assert.equal(
        prefix.every((event) => event.identity.runId === run.runId),
        true,
      );
      assert.equal(
        prefix.some((event) => event.type === "run.completed"),
        false,
      );
      assert.deepEqual(
        await streamingReader.listRunEvents(
          { tenantId: "tenant-1", runId: run.runId },
          prefix.at(-1)!.sequence,
          100,
        ),
        [],
      );
    }
  } finally {
    streamingReader.close();
  }
  assert.equal(f.entered.has(runs[2]!.runId), false);
  assert.equal(f.maximumActive(), 2);
  // The slow first Run must not prevent the second from finishing or the third starting.
  f.release(runs[1]!.runId);
  await waitFor(
    async () => (await f.load(runs[1]!.runId))?.status === "completed",
  );
  await waitFor(() => f.entered.has(runs[2]!.runId));
  assert.equal((await f.load(runs[0]!.runId))?.status, "running");
  f.release(runs[2]!.runId);
  f.release(runs[0]!.runId);
  await waitFor(async () =>
    (await Promise.all(runs.map((r) => f.load(r.runId)))).every(
      (r) => r?.status === "completed",
    ),
  );
  assert.equal(f.maximumActive(), 2);
  await f.runtime.close();
  assert.equal(f.closed(), 1);
  for (const run of runs) {
    const messages = await f.store.listMessages(
      { tenantId: "tenant-1", threadId: run.threadId },
      0,
      20,
    );
    assert.deepEqual(
      messages.map((message) => message.content),
      [run.label, `answer:${run.runId}`],
    );
    const attempts = await f.store.listRunAttempts(
      {
        tenantId: "tenant-1",
        runId: run.runId,
        stepId: run.workItemId,
      },
      0,
      20,
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, "completed");
  }
  // A fresh read connection sees the same durable results; no replayed model requests.
  const reopened = new SqliteRunStore(f.databasePath);
  try {
    for (const run of runs)
      assert.equal(
        (await reopened.loadRun({ tenantId: "tenant-1", runId: run.runId }))
          ?.status,
        "completed",
      );
    assert.equal(f.entered.size, 3);
  } finally {
    reopened.close();
  }
});

test("canceling one parallel Run leaves its sibling streaming and closes all lanes before the transport", async (t) => {
  const f = await fixture(t);
  const first = await f.enqueue("cancel me"),
    second = await f.enqueue("keep working");
  f.runtime.start();
  await waitFor(() => f.entered.size === 2);
  const running = await f.load(first.runId);
  assert.ok(running);
  await f.runs.transitionRun(f.actor, {
    kind: "run.requestCancel",
    runId: first.runId,
    expectedRevision: running.revision,
    idempotencyKey: "cancel-first",
  });
  await waitFor(async () => (await f.load(first.runId))?.status === "canceled");
  assert.equal(f.entered.get(first.runId)?.aborted, true);
  assert.equal(f.entered.get(second.runId)?.aborted, false);
  f.release(second.runId);
  await waitFor(
    async () => (await f.load(second.runId))?.status === "completed",
  );
  await f.runtime.close();
  assert.equal(f.closed(), 1);
});

test("closing production composition aborts both in-flight streams and joins them before shared transport disposal", async (t) => {
  const f = await fixture(t);
  await f.enqueue("first");
  await f.enqueue("second");
  f.runtime.start();
  await waitFor(() => f.entered.size === 2);
  const closing = f.runtime.close();
  assert.equal(f.runtime.close(), closing);
  await closing;
  assert.equal(
    [...f.entered.values()].every((signal) => signal.aborted),
    true,
  );
  assert.equal(f.active(), 0);
  assert.equal(f.closed(), 1);
});

test("measures production-scan queue admission and free-lane refill without model latency", async (t) => {
  const f = await fixture(t, 1000);
  f.runtime.start();
  await setTimeout(120);
  const queuedAt = performance.now();
  const first = await f.enqueue("latency-first");
  const second = await f.enqueue("latency-second");
  const third = await f.enqueue("latency-third");
  await waitFor(() => f.entered.size === 2);
  const admittedAt = performance.now();
  await setTimeout(120);
  const releasedAt = performance.now();
  f.release(second.runId);
  await waitFor(() => f.entered.has(third.runId));
  const refilledAt = performance.now();
  f.release(third.runId);
  f.release(first.runId);
  await waitFor(
    async () => (await f.load(third.runId))?.status === "completed",
  );
  assert.ok(
    admittedAt - queuedAt < 600,
    "idle lane waited for the one-second scan",
  );
  assert.ok(
    refilledAt - releasedAt < 600,
    "free lane waited for the one-second scan",
  );
  t.diagnostic(
    JSON.stringify({
      scenario: "production-scan",
      enqueueToModelEntryMs: admittedAt - queuedAt,
      releasedLaneToNextModelEntryMs: refilledAt - releasedAt,
      maximumActive: f.maximumActive(),
    }),
  );
});

test("SQLite hints converge when the durable queue empties, including WAL writes from completion", async (t) => {
  const f = await fixture(t, 60_000);
  let wakes = 0;
  for (const worker of f.runtime.workers) {
    const wake = worker.wake.bind(worker);
    t.mock.method(worker, "wake", () => {
      wakes++;
      return wake();
    });
  }
  f.runtime.start();
  const run = await f.enqueue("hint convergence");
  await waitFor(() => f.entered.has(run.runId));
  f.release(run.runId);
  await waitFor(async () => (await f.load(run.runId))?.status === "completed");
  await setTimeout(100);
  const settled = wakes;
  await setTimeout(150);
  assert.equal(
    wakes,
    settled,
    "own claim/commit WAL writes must not create a wake loop",
  );
  assert.ok(wakes < 50, `hint burst produced ${wakes} wakes for one Run`);
});
