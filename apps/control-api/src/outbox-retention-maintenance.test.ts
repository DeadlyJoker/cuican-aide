import assert from "node:assert/strict";
import test from "node:test";
import type { OutboxRetentionResult } from "@crewon/application";
import { InMemoryRunStore } from "@crewon/store";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { RunEventHub } from "./run-event-hub.ts";
import { OutboxRetentionMaintenance } from "./outbox-retention-maintenance.ts";

const policy = { retentionMs: 1_000, minimumIntervalMs: 10, maxBatchSize: 2 };
const result: OutboxRetentionResult = {
  disposition: "pruned",
  deletedMessages: 2,
};

test("maintenance yields to delivery, coalesces ticks and closes after its only in-flight batch", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  let busy = true;
  let calls = 0;
  let resolve!: (value: OutboxRetentionResult) => void;
  const pending = new Promise<OutboxRetentionResult>((done) => {
    resolve = done;
  });
  const maintenance = new OutboxRetentionMaintenance(
    {
      pruneDeliveredOutbox: async (received) => {
        assert.deepEqual(received, policy);
        calls++;
        return pending;
      },
    },
    policy,
    () => busy,
  );
  maintenance.start();
  maintenance.start();
  assert.equal(calls, 0);
  context.mock.timers.tick(10);
  assert.equal(calls, 0);
  busy = false;
  context.mock.timers.tick(10);
  assert.equal(calls, 1);
  context.mock.timers.tick(100);
  assert.equal(calls, 1);
  let closed = false;
  const closing = maintenance.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  context.mock.timers.tick(100);
  assert.equal(calls, 1);
  resolve(result);
  await closing;
  assert.deepEqual(maintenance.status(), {
    inFlight: false,
    lastResult: result,
    lastFailureCode: null,
    resources: {
      activePasses: 0,
      maximumPasses: 2,
      ownPassInFlight: false,
      observing: false,
      admissionDeferred: false,
    },
  });
  await maintenance.wake();
  context.mock.timers.tick(100);
  assert.equal(calls, 1);
});

test("maintenance records bounded errors and recovers without leaking error contents", async () => {
  let failing = true;
  const maintenance = new OutboxRetentionMaintenance(
    {
      pruneDeliveredOutbox: async () => {
        if (failing)
          throw new Error("sensitive database detail must not escape");
        return result;
      },
    },
    policy,
    () => false,
  );
  await maintenance.wake();
  assert.deepEqual(maintenance.status(), {
    inFlight: false,
    lastResult: null,
    lastFailureCode: "outbox_retention_failed",
    resources: {
      activePasses: 0,
      maximumPasses: 2,
      ownPassInFlight: false,
      observing: false,
      admissionDeferred: false,
    },
  });
  failing = false;
  await maintenance.wake();
  const status = maintenance.status();
  assert.equal(status.lastFailureCode, null);
  assert.deepEqual(status.lastResult, result);
  await maintenance.close();
});

test("the actual dispatcher owns maintenance start/close and keeps delivery errors separate", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const store = new InMemoryRunStore();
  let calls = 0;
  context.mock.method(
    store.outboxRetention,
    "pruneDeliveredOutbox",
    async () => {
      calls++;
      throw new Error("sqlite_error");
    },
  );
  const eventHub = new RunEventHub();
  const dispatcher = new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: "dispatcher",
      nextLeaseId: () => "lease",
      scanIntervalMs: null,
      retention: policy,
    },
  );
  dispatcher.start();
  await dispatcher.wake();
  context.mock.timers.tick(10);
  for (let index = 0; index < 5; index++) await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(dispatcher.lastFailureCode(), null);
  assert.equal(dispatcher.retentionStatus().lastFailureCode, "sqlite_error");
  await dispatcher.close();
  context.mock.timers.tick(100);
  assert.equal(calls, 1);
  eventHub.close();
  await store.close();
});

test("unsupported adapters, disabled retention and invalid budgets do not create maintenance work", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const store = {
    pruneDeliveredOutbox: async () => {
      calls++;
      return result;
    },
  };
  for (const maintenance of [
    new OutboxRetentionMaintenance(undefined, policy, () => false),
    new OutboxRetentionMaintenance(store, null, () => false),
  ]) {
    maintenance.start();
    context.mock.timers.tick(100);
    await maintenance.wake();
    await maintenance.close();
  }
  assert.equal(calls, 0);
  for (const invalid of [
    { maxBatchSize: 501 },
    { retentionMs: 0 },
    { minimumIntervalMs: NaN },
  ]) {
    assert.throws(
      () =>
        new OutboxRetentionMaintenance(
          store,
          { ...policy, ...invalid },
          () => false,
        ),
      /outbox_retention_policy_invalid/,
    );
  }
});
