import assert from "node:assert/strict";
import test from "node:test";
import {
  TeamTaskScheduler,
  TeamTaskSchedulerPump,
  type TeamTaskSchedulerInput,
} from "./team-task-scheduler.ts";
import type { TeamTaskFence, TeamTaskLocator } from "./team-task-journal.ts";

const scope = { tenantId: "tenant-1", spaceId: "space-1" } as const;
const locators = ["task-a", "task-b", "task-c"].map((taskId) => ({
  ...scope,
  taskId,
}));

function fakeStore(initial: readonly TeamTaskLocator[]) {
  const available = [...initial];
  const claims: TeamTaskFence[] = [];
  const store: Pick<TeamTaskSchedulerInput["store"], "listRunnable" | "claim"> =
    {
      async listRunnable(input) {
        return available.slice(0, input.limit);
      },
      async claim(input) {
        const index = available.findIndex(
          (locator) => locator.taskId === input.taskId,
        );
        if (index < 0) return null;
        available.splice(index, 1);
        const fence = {
          tenantId: input.tenantId,
          spaceId: input.spaceId,
          taskId: input.taskId,
          ownerId: input.ownerId,
          leaseId: input.leaseId,
          epoch: 1,
        };
        claims.push(fence);
        return fence;
      },
    };
  return { store, claims, available };
}

function schedulerInput(
  overrides: Partial<TeamTaskSchedulerInput>,
): TeamTaskSchedulerInput {
  return {
    store: fakeStore([]).store,
    scope,
    ownerId: "scheduler-owner",
    concurrency: 2,
    listLimit: 10,
    leaseDurationMs: 1_000,
    createLeaseId: ({ locator, sequence }) =>
      `lease-${locator.taskId}-${sequence}`,
    execute: async () => undefined,
    ...overrides,
  };
}

test("coalesces wake calls, enforces concurrency, and refills a freed slot", async () => {
  const fake = fakeStore(locators);
  const gates = new Map<string, { promise: Promise<void>; release(): void }>();
  const started: string[] = [];
  const scheduler = new TeamTaskScheduler(
    schedulerInput({
      store: fake.store,
      execute: async (fence) => {
        started.push(fence.taskId);
        let release!: () => void;
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        gates.set(fence.taskId, { promise, release });
        await promise;
      },
    }),
  );

  const first = scheduler.wake();
  assert.equal(first, scheduler.wake());
  assert.deepEqual(await first, { started: 2, skipped: 0, capacity: 2 });
  assert.deepEqual(started, ["task-a", "task-b"]);
  assert.equal(fake.claims.length, 2);

  gates.get("task-a")!.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["task-a", "task-b", "task-c"]);

  gates.get("task-b")!.release();
  gates.get("task-c")!.release();
  await scheduler.idle();
  await scheduler.close();
  assert.deepEqual(fake.available, []);
});

test("does not execute a raced claim and reports executor failure without retrying immediately", async () => {
  const fake = fakeStore([locators[0]!]);
  let errors = 0;
  const scheduler = new TeamTaskScheduler(
    schedulerInput({
      store: {
        ...fake.store,
        claim: async () => null,
      },
      concurrency: 1,
      onError: () => {
        errors++;
      },
    }),
  );
  assert.deepEqual(await scheduler.wake(), {
    started: 0,
    skipped: 1,
    capacity: 1,
  });
  assert.deepEqual(fake.claims, []);

  const failed = fakeStore([locators[0]!]);
  const failedScheduler = new TeamTaskScheduler(
    schedulerInput({
      store: failed.store,
      concurrency: 1,
      onError: () => {
        errors++;
      },
      execute: async () => {
        throw new Error("executor_failed");
      },
    }),
  );
  assert.deepEqual(await failedScheduler.wake(), {
    started: 1,
    skipped: 0,
    capacity: 1,
  });
  await failedScheduler.idle();
  assert.equal(errors, 1);
  await failedScheduler.close();
});

test("close waits for an in-flight executor and rejects later wakes", async () => {
  const fake = fakeStore([locators[0]!]);
  let release!: () => void;
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new TeamTaskScheduler(
    schedulerInput({
      store: fake.store,
      concurrency: 1,
      execute: async () => running,
    }),
  );
  await scheduler.wake();
  let closed = false;
  const closing = scheduler.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
  await assert.rejects(scheduler.wake(), /team_scheduler_closed/);
});

test("pump coalesces explicit notifications, supports scan fallback, and closes its timer", async () => {
  const fake = fakeStore([locators[0]!]);
  let executions = 0;
  const scheduler = new TeamTaskScheduler(
    schedulerInput({
      store: fake.store,
      concurrency: 1,
      execute: async () => {
        executions++;
      },
    }),
  );
  const pump = new TeamTaskSchedulerPump({
    scheduler,
    scanIntervalMs: 10,
  });
  pump.start();
  pump.notify();
  await scheduler.idle();
  assert.equal(executions, 1);
  await pump.close();
  pump.notify();
  assert.equal(executions, 1);
});

test("polls durable cancellation and aborts the claimed executor", async () => {
  const fake = fakeStore([locators[0]!]);
  let canceled = false;
  let errors = 0;
  const scheduler = new TeamTaskScheduler(
    schedulerInput({
      store: {
        ...fake.store,
        read: async () => ({
          intent: {} as never,
          status: "coordinating" as const,
          revision: 1,
          cancelRequested: canceled,
          lease: null,
          result: null,
          effectCount: 0,
          journalBytes: 1,
        }),
      },
      cancellationPollIntervalMs: 5,
      execute: async (_fence, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
      onError: () => {
        errors++;
      },
    }),
  );
  await scheduler.wake();
  canceled = true;
  await scheduler.idle();
  assert.equal(errors, 1);
  await scheduler.close();
});
