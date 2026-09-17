import assert from "node:assert/strict";
import test from "node:test";
import type { WorkItemClaim, QueueLease } from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { RuntimeWorkerQueries } from "./runtime-worker-queries.ts";
import {
  RuntimeAuthorityError,
  type AuthorityTime,
} from "./runtime-authority-query.ts";
import {
  CancellationWatcher,
  LeaseHeartbeat,
} from "./runtime-worker-watchers.ts";

const claim: WorkItemClaim = {
  workItem: {
    workItemId: "work",
    tenantId: "tenant",
    runId: "run",
    kind: "run.execute",
    payload: {},
    createdAt: "2020-01-01T00:00:00Z",
  },
  lease: {
    ownerId: "worker",
    leaseId: "lease",
    epoch: 1,
    expiresAt: "2020-01-01T00:00:30Z",
  },
};
function clock() {
  let wall = 0,
    steady = 0;
  const timers = new Map<() => void, number>();
  const time: AuthorityTime = {
    now: () => ({ wall, steady }),
    after: (delay, callback) => {
      timers.set(callback, steady + delay);
      return () => {
        timers.delete(callback);
      };
    },
  };
  return {
    time,
    timers,
    advance(wallDelta: number, steadyDelta = wallDelta, fire = true) {
      wall += wallDelta;
      steady += steadyDelta;
      if (fire)
        for (const [callback, due] of [...timers])
          if (due <= steady) {
            timers.delete(callback);
            callback();
          }
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("renewal owns one physical query across 20,000 waits, timeout and late response", async () => {
  const c = clock(),
    q = new RuntimeWorkerQueries({ leaseDurationMs: 30000, time: c.time });
  const physical = deferred<QueueLease>();
  let calls = 0;
  const operation = () => {
    calls++;
    return physical.promise;
  };
  const pending = q.renew(claim, operation);
  for (let i = 0; i < 20000; i++)
    assert.equal(q.renew(claim, operation), pending);
  const rejected = assert.rejects(pending, {
    code: "lease_confirmation_timeout",
  });
  c.advance(10000);
  await rejected;
  for (let i = 0; i < 20000; i++)
    assert.throws(() => q.renew(claim, operation), {
      code: "runtime_watch_query_pending",
    });
  assert.equal(calls, 1);
  assert.equal(q.pending, true);
  assert.equal(c.timers.size, 0);
  physical.resolve(claim.lease);
  await Promise.resolve();
  assert.equal(q.pending, false);
  assert.throws(() => q.confirmedClaim(claim), RuntimeAuthorityError);
  await q.renew(claim, async () => claim.lease);
  assert.equal(q.confirmation(claim).remainingMs(), 20000);
  q.close();
  assert.equal(c.timers.size, 0);
});

test("confirmation uses request start and latest lease without comparing remote wall clocks", async () => {
  const c = clock(),
    q = new RuntimeWorkerQueries({ leaseDurationMs: 30000, time: c.time });
  const physical = deferred<QueueLease>();
  const pending = q.renew(claim, () => physical.promise);
  c.advance(9000);
  const renewed = { ...claim.lease, expiresAt: "2020-01-01T00:01:00Z" };
  physical.resolve(renewed);
  await pending;
  assert.equal(q.confirmation(claim).remainingMs(), 11000);
  assert.deepEqual(q.confirmedClaim(claim).lease, renewed);
  c.advance(-5000, 11000);
  assert.throws(() => q.confirmedClaim(claim), RuntimeAuthorityError);
  q.close();
});

for (const sleep of [false, true])
  test(`late renewal cannot beat a delayed timer (wall-only sleep=${sleep})`, async () => {
    const c = clock(),
      q = new RuntimeWorkerQueries({ leaseDurationMs: 30000, time: c.time });
    const physical = deferred<QueueLease>();
    const pending = q.renew(claim, () => physical.promise);
    const rejected = assert.rejects(pending, {
      code: "lease_confirmation_timeout",
    });
    c.advance(10000, sleep ? 0 : 10000, false);
    physical.resolve(claim.lease);
    await rejected;
    assert.equal(q.pending, false);
    assert.equal(c.timers.size, 0);
    assert.throws(() => q.confirmedClaim(claim), RuntimeAuthorityError);
    q.close();
  });

for (const field of ["ownerId", "leaseId", "epoch"] as const)
  test(`renewal rejects mismatched ${field}`, async () => {
    const q = new RuntimeWorkerQueries({ leaseDurationMs: 30000 });
    await assert.rejects(
      q.renew(claim, async () => ({
        ...claim.lease,
        [field]: field === "epoch" ? 2 : "other",
      })),
      { code: "lease_confirmation_failed" },
    );
    assert.throws(() => q.confirmedClaim(claim), RuntimeAuthorityError);
    q.close();
  });

for (const fireDeadline of [true, false])
  test(`heartbeat deadline or dispatch check stops authority before lease expiry (timer fired=${fireDeadline})`, async () => {
    const c = clock(),
      q = new RuntimeWorkerQueries({ leaseDurationMs: 30000, time: c.time });
    await q.renew(claim, async () => claim.lease);
    const controller = new AbortController();
    const heartbeat = new LeaseHeartbeat(
      10000,
      async () => {},
      controller,
      q.confirmation(claim),
    );
    for (let i = 0; i < 20000; i++) heartbeat.start();
    assert.equal(q.snapshot().confirmationListeners, 1);
    assert.equal(c.timers.size, 1);
    c.advance(20000, 20000, fireDeadline);
    if (!fireDeadline)
      assert.throws(() => q.confirmedClaim(claim), RuntimeAuthorityError);
    assert.equal(controller.signal.reason, "runtime_lease_unconfirmed");
    assert.ok(heartbeat.failure() instanceof RuntimeAuthorityError);
    assert.equal(q.snapshot().confirmationListeners, 0);
    assert.equal(c.timers.size, 0);
    await heartbeat.close();
    q.close();
  });

test("closed cancellation watcher ignores late results; query remains physically owned", async () => {
  const c = clock(),
    q = new RuntimeWorkerQueries({ leaseDurationMs: 30000, time: c.time });
  const physical = deferred<RunState>();
  const controller = new AbortController();
  let activeTimers = 0;
  let tick!: () => Promise<void>;
  const watcher = new CancellationWatcher(
    250,
    () => q.readCancellation(claim, () => physical.promise),
    controller,
    {
      every: (_, callback) => {
        activeTimers++;
        tick = callback;
        return () => {
          activeTimers--;
        };
      },
    },
  );
  for (let i = 0; i < 20000; i++) watcher.start();
  assert.equal(activeTimers, 1);
  const pending = tick();
  const closing = watcher.close();
  q.close();
  await closing;
  await pending;
  assert.equal(q.pending, true);
  assert.equal(activeTimers, 0);
  assert.equal(c.timers.size, 0);
  physical.resolve({ cancelRequested: true } as RunState);
  await Promise.resolve();
  assert.equal(q.pending, false);
  assert.equal(controller.signal.aborted, false);
  assert.equal(watcher.failure(), null);
});

test("heartbeat start after an earlier abort cannot accumulate subscriptions", async () => {
  const c = clock(),
    q = new RuntimeWorkerQueries({ leaseDurationMs: 30000, time: c.time });
  const controller = new AbortController();
  controller.abort("runtime_worker_closing");
  const heartbeat = new LeaseHeartbeat(
    10000,
    async () => {},
    controller,
    q.confirmation(claim),
  );
  for (let i = 0; i < 20000; i++) heartbeat.start();
  assert.equal(q.snapshot().confirmationListeners, 0);
  assert.equal(c.timers.size, 0);
  await heartbeat.close();
  q.close();
});

test("cancellation timeout aborts logical execution without freeing or reissuing its physical query", async () => {
  const c = clock(),
    q = new RuntimeWorkerQueries({ leaseDurationMs: 30000, time: c.time });
  const physical = deferred<RunState>();
  const controller = new AbortController();
  let tick!: () => Promise<void>;
  const watcher = new CancellationWatcher(
    250,
    () => q.readCancellation(claim, () => physical.promise),
    controller,
    {
      every: (_, callback) => {
        tick = callback;
        return () => {};
      },
    },
  );
  watcher.start();
  const pending = tick();
  c.advance(1000);
  await pending;
  assert.equal(controller.signal.reason, "cancellation_watch_failed");
  for (let i = 0; i < 20000; i++)
    assert.throws(
      () => q.readCancellation(claim, () => physical.promise),
      RuntimeAuthorityError,
    );
  assert.equal(q.pending, true);
  await watcher.close();
  q.close();
  physical.resolve({ cancelRequested: false } as RunState);
  await Promise.resolve();
  assert.equal(q.pending, false);
});

test("execution progress queries retain physical ownership after timeout and ignore late results", async () => {
  const c = clock(),
    q = new RuntimeWorkerQueries({ leaseDurationMs: 30000, time: c.time });
  const physical = deferred<string>();
  let calls = 0;
  const pending = q.executionProgress(claim, "page:0", () => {
    calls++;
    return physical.promise;
  });
  const rejected = assert.rejects(pending, {
    code: "execution_progress_query_timeout",
  });
  c.advance(1000);
  await rejected;
  assert.equal(q.snapshot().progressPending, true);
  await assert.rejects(
    q.executionProgress(claim, "page:100", async () => {
      calls++;
      return "new";
    }),
    { code: "runtime_watch_query_pending" },
  );
  assert.equal(calls, 1);
  assert.equal(c.timers.size, 0);
  q.close();
  physical.resolve("old");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(q.snapshot().progressPending, false);
  await assert.rejects(
    q.executionProgress(claim, "page:0", async () => "closed"),
    { code: "runtime_worker_closing" },
  );
});

test("execution progress operations preserve Store errors and close detaches their logical waiter", async () => {
  const c = clock(),
    q = new RuntimeWorkerQueries({ leaseDurationMs: 30000, time: c.time });
  const error = new Error("bad checkpoint digest");
  await assert.rejects(
    q.executionProgress(claim, "load", async () => {
      throw error;
    }),
    (value) => value === error,
  );
  assert.equal(q.snapshot().progressPending, false);
  const physical = deferred<void>();
  const pending = q.executionProgress(
    claim,
    "save:100",
    () => physical.promise,
  );
  const rejected = assert.rejects(pending, { code: "runtime_worker_closing" });
  q.close();
  await rejected;
  assert.equal(c.timers.size, 0);
  assert.equal(q.pending, true);
  physical.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(q.pending, false);
});
