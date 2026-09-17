import assert from "node:assert/strict";
import test from "node:test";
import type {
  OutboxRetentionResult,
  OutboxRetentionPolicy,
  OutboxRetentionOptions,
} from "@crewon/application";
import { OutboxRetentionMaintenance } from "./outbox-retention-maintenance.ts";
import { ArtifactRetentionMaintenance } from "./artifact-retention-maintenance.ts";
import { InMemoryRunStore } from "@crewon/store";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { RunEventHub } from "./run-event-hub.ts";

const policy = { retentionMs: 1_000, minimumIntervalMs: 10, maxBatchSize: 2 };
const deferred = { disposition: "deferred", deletedMessages: 0 } as const;

test("outbox and artifact schedulers share admission, coalesce ticks and retain hung adapters across close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let release!: (value: OutboxRetentionResult) => void,
    calls = 0;
  const physical = new Promise<OutboxRetentionResult>((resolve) => {
    release = resolve;
  });
  const store = {
    pruneDeliveredOutbox: async () => {
      calls++;
      return physical;
    },
  };
  const first = new OutboxRetentionMaintenance(store, policy, () => false);
  const duplicate = new OutboxRetentionMaintenance(store, policy, () => false);
  const second = new OutboxRetentionMaintenance(
    { pruneDeliveredOutbox: () => physical },
    policy,
    () => false,
  );
  let artifactCalls = 0;
  const artifact = new ArtifactRetentionMaintenance(
    {
      maintainArtifacts: async () => {
        artifactCalls++;
        return {
          disposition: "deferred",
          indexed: 0,
          checked: 0,
          deleted: 0,
          deletedBytes: 0,
          recovered: 0,
          recoveredBytes: 0,
          recoveryDeferred: 0,
        };
      },
    },
    { canRetireArtifact: async () => false },
  );
  t.after(async () => {
    release(deferred);
    await first.close();
    await second.close();
    await duplicate.close();
    await artifact.close();
  });
  const wake = first.wake();
  for (let i = 0; i < 20_000; i++) assert.equal(first.wake(), wake);
  await duplicate.wake();
  assert.equal(calls, 1);
  const other = second.wake();
  await artifact.wake();
  assert.equal(artifactCalls, 0);
  const closing = first.close();
  t.mock.timers.tick(1_000);
  await Promise.all([wake, other, closing]);
  assert(first.status().inFlight);
  assert.equal(first.status().resources.observing, false);
  assert.equal(first.status().lastFailureCode, "outbox_retention_timeout");
  await artifact.wake();
  assert.equal(artifactCalls, 0);
  release(deferred);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await artifact.wake();
  assert.equal(artifactCalls, 1);
  assert.equal(artifact.status().scheduler.activePasses, 0);
});

test("actual dispatcher close returns after its grace while an uncooperative outbox adapter remains observable", async (t) => {
  const store = new InMemoryRunStore(),
    eventHub = new RunEventHub();
  const dispatcher = new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: "maintenance-test",
      nextLeaseId: () => "lease",
      scanIntervalMs: null,
      retention: policy,
    },
  );
  let release!: (value: OutboxRetentionResult) => void,
    calls = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const physical = new Promise<OutboxRetentionResult>((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release(deferred);
    await dispatcher.close();
    eventHub.close();
    await store.close();
  });
  t.mock.method(
    store.outboxRetention,
    "pruneDeliveredOutbox",
    async (
      _policy: OutboxRetentionPolicy,
      options?: OutboxRetentionOptions,
    ) => {
      calls++;
      assert(options?.signal);
      entered();
      return physical;
    },
  );
  dispatcher.start();
  // The scheduler interval is unref'ed; keep this fixture alive while awaiting entry.
  const timeout = setTimeout(() => entered(), 1_000);
  try {
    await started;
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(calls, 1);
  const start = performance.now();
  await dispatcher.close();
  assert(performance.now() - start < 1_500);
  assert(dispatcher.retentionStatus().inFlight);
  assert.equal(dispatcher.retentionStatus().resources.observing, false);
  release(deferred);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(dispatcher.retentionStatus().inFlight, false);
  assert.equal(calls, 1);
});
