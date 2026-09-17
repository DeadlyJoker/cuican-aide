import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutboxMessage } from "@crewon/application";
import type { RunLifecycleEvent } from "@crewon/domain";
import { InMemoryRunStore, SqliteRunStore } from "@crewon/store";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { RunEventHub } from "./run-event-hub.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture_deadline")), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function dispatcher(
  store: InMemoryRunStore | SqliteRunStore,
  eventHub = new RunEventHub(),
) {
  let lease = 0;
  return new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: "dispatcher",
      nextLeaseId: () => `lease-${++lease}`,
      leaseDurationMs: 30_000,
      scanIntervalMs: null,
      retention: null,
    },
  );
}

test("20,000 close calls share one bounded wait while unresolved I/O keeps its admission", async (context) => {
  const store = new InMemoryRunStore(),
    hub = new RunEventHub();
  const owner = dispatcher(store, hub),
    pending = deferred<null>();
  const claim = context.mock.method(
    store,
    "claimNextOutbox",
    () => pending.promise,
  );
  const wake = owner.wake();
  context.after(async () => {
    pending.resolve(null);
    await wake;
    await owner.close();
    hub.close();
    await store.close();
  });
  const closing = owner.close();
  for (let index = 0; index < 20_000; index += 1)
    assert.equal(owner.close(), closing);
  await within(closing);
  assert.equal(owner.deliveryStatus().inFlight, true);
  assert.equal(owner.deliveryStatus().closeDeadlineExceeded, true);
  await owner.wake();
  assert.equal(claim.mock.callCount(), 1);
  pending.resolve(null);
  await wake;
  assert.equal(owner.deliveryStatus().inFlight, false);
  assert.equal(owner.close(), closing);
});

test("replacement dispatchers defer on the same Store until the closed owner's call settles", async (context) => {
  const store = new InMemoryRunStore(),
    hub = new RunEventHub();
  const first = dispatcher(store, hub),
    replacement = dispatcher(store, hub);
  const pending = deferred<null>();
  let calls = 0;
  context.mock.method(store, "claimNextOutbox", () =>
    ++calls === 1 ? pending.promise : Promise.resolve(null),
  );
  const wake = first.wake();
  context.after(async () => {
    pending.resolve(null);
    await wake;
    await first.close();
    await replacement.close();
    hub.close();
    await store.close();
  });
  await within(first.close());
  for (let index = 0; index < 5_000; index += 1) void replacement.wake();
  assert.equal(calls, 1);
  assert.equal(replacement.deliveryStatus().admissionDeferred, true);
  pending.resolve(null);
  await wake;
  await replacement.wake();
  assert.equal(calls, 2);
  assert.equal(replacement.deliveryStatus().admissionDeferred, false);
});

test("different Stores share a process limit that timed-out close calls cannot release", async (context) => {
  const resources = Array.from({ length: 5 }, () => {
    const store = new InMemoryRunStore(),
      hub = new RunEventHub(),
      pending = deferred<null>();
    const owner = dispatcher(store, hub);
    const claim = context.mock.method(
      store,
      "claimNextOutbox",
      () => pending.promise,
    );
    return { store, hub, pending, owner, claim };
  });
  const wakes = resources.slice(0, 4).map(({ owner }) => owner.wake());
  context.after(async () => {
    for (const resource of resources) resource.pending.resolve(null);
    await Promise.all(wakes);
    for (const { owner, store, hub } of resources) {
      await owner.close();
      hub.close();
      await store.close();
    }
  });
  const fifth = resources[4]!;
  await fifth.owner.wake();
  assert.equal(fifth.claim.mock.callCount(), 0);
  await within(
    Promise.all(resources.slice(0, 4).map(({ owner }) => owner.close())),
  );
  assert.equal(fifth.owner.deliveryStatus().activeDrains, 4);
  for (let index = 0; index < 5_000; index += 1) void fifth.owner.wake();
  assert.equal(fifth.claim.mock.callCount(), 0);
  resources[0]!.pending.resolve(null);
  await wakes[0];
  fifth.pending.resolve(null);
  await fifth.owner.wake();
  assert.equal(fifth.claim.mock.callCount(), 1);
});

test("synchronous close during lease ID creation prevents entering the Store", async (context) => {
  const store = new InMemoryRunStore(),
    hub = new RunEventHub();
  let owner!: OutboxDispatcher;
  owner = new OutboxDispatcher(
    { store, eventHub: hub },
    {
      ownerId: "reentrant",
      nextLeaseId: () => {
        void owner.close();
        return "lease";
      },
      retention: null,
      scanIntervalMs: null,
    },
  );
  const claim = context.mock.method(store, "claimNextOutbox");
  context.after(async () => {
    await owner.close();
    hub.close();
    await store.close();
  });
  await owner.wake();
  await owner.close();
  assert.equal(claim.mock.callCount(), 0);
  assert.equal(owner.deliveryStatus().inFlight, false);
});

for (const phase of ["claim", "read", "acknowledge", "retry"] as const) {
  test(`SQLite reopen preserves delivery after close with ${phase} response still pending`, async (context) => {
    const fixture = await sqliteFixture(context);
    const { store, owner, hub, outputs, open, advance } = fixture;
    const entered = deferred<void>(),
      release = deferred<void>();
    const method =
      phase === "claim"
        ? "claimNextOutbox"
        : phase === "read"
          ? "listRunEvents"
          : phase === "acknowledge"
            ? "acknowledgeOutbox"
            : "retryOutbox";
    const original = store[method].bind(store) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const held = context.mock.method(
      store,
      method,
      async (...args: unknown[]) => {
        const result = await original(...args);
        entered.resolve();
        await release.promise;
        return result;
      },
    );
    if (phase === "retry")
      context.mock.method(store, "listRunEvents", async () => {
        throw new Error("fixture_read_failed");
      });
    const published: RunLifecycleEvent[] = [];
    context.mock.method(
      hub,
      "publish",
      (events: readonly RunLifecycleEvent[]) => {
        published.push(...events);
      },
    );
    const wake = owner.wake();
    context.after(async () => {
      release.resolve();
      await wake;
    });
    await within(entered.promise);
    await within(owner.close());
    assert.equal(owner.deliveryStatus().inFlight, true);
    const beforeLate = [...published];
    hub.close();
    release.resolve();
    await wake;
    assert.deepEqual(published, beforeLate);
    assert.equal(held.mock.callCount(), 1);
    assert.equal(owner.deliveryStatus().inFlight, false);
    await store.close();
    advance(30_001);
    const reopened = open(),
      resumedHub = new RunEventHub();
    const resumed = dispatcher(reopened, resumedHub),
      delivered: RunLifecycleEvent[] = [];
    context.mock.method(
      resumedHub,
      "publish",
      (events: readonly RunLifecycleEvent[]) => {
        delivered.push(...events);
      },
    );
    context.after(async () => {
      await resumed.close();
      resumedHub.close();
    });
    await resumed.wake();
    assert.deepEqual(
      delivered,
      phase === "acknowledge" ? outputs.slice(4) : outputs,
    );
    assert.deepEqual(await reopened.listPendingOutbox(10), []);
    assert.deepEqual(
      await reopened.listRunEvents({ tenantId: "tenant", runId: "run" }, 2, 10),
      outputs,
    );
  });
}

test("closing during range delivery leaves the unacknowledged range recoverable by every cursor", async (context) => {
  const { store, owner, hub, outputs, open, advance } =
    await sqliteFixture(context);
  const publish = hub.publish.bind(hub);
  let published = 0;
  context.mock.method(
    hub,
    "publish",
    (events: readonly RunLifecycleEvent[]) => {
      publish(events);
      published += events.length;
      void owner.close();
    },
  );
  const acknowledge = context.mock.method(store, "acknowledgeOutbox");
  await owner.wake();
  await owner.close();
  assert.equal(published, 1);
  assert.equal(acknowledge.mock.callCount(), 0);
  await store.close();
  advance(30_001);
  const reopened = open(),
    nextHub = new RunEventHub(),
    next = dispatcher(reopened, nextHub);
  const delivered: RunLifecycleEvent[] = [];
  context.mock.method(
    nextHub,
    "publish",
    (events: readonly RunLifecycleEvent[]) => {
      delivered.push(...events);
    },
  );
  context.after(async () => {
    await next.close();
    nextHub.close();
  });
  await next.wake();
  assert.deepEqual(delivered, outputs);
  for (let cursor = 2; cursor <= 10; cursor += 1) {
    assert.deepEqual(
      await reopened.listRunEvents(
        { tenantId: "tenant", runId: "run" },
        cursor,
        10,
      ),
      outputs.filter((event) => event.sequence > cursor),
    );
  }
});

async function sqliteFixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-outbox105-"));
  let now = Date.parse("2026-09-15T00:00:00Z");
  const stores: SqliteRunStore[] = [];
  const open = () => {
    const store = new SqliteRunStore(join(directory, "control.sqlite"), {
      clock: { nowEpochMilliseconds: () => now },
    });
    stores.push(store);
    return store;
  };
  const store = open(),
    hub = new RunEventHub(),
    owner = dispatcher(store, hub);
  context.after(async () => {
    await owner.close();
    hub.close();
    for (const store of stores) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.commitThread({
    tenantId: "tenant",
    idempotency: { scope: "seed", key: "thread", requestFingerprint: "thread" },
    expectedRevision: 0,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread" },
        eventId: "thread-created",
        sequence: 1,
        occurredAt: "2026-09-15T00:00:00Z",
        type: "thread.created",
        data: {
          tenantId: "tenant",
          spaceId: "space",
          createdByActorId: "actor",
          title: null,
        },
      },
    ],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
  });
  const created: RunLifecycleEvent = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run" },
    eventId: "created",
    sequence: 1,
    occurredAt: "2026-09-15T00:00:00Z",
    type: "run.created",
    data: {
      threadId: "thread",
      tenantId: "tenant",
      spaceId: "space",
      createdByActorId: "actor",
      authorityId: "authority",
      runtimeGeneration: "generation",
      agentVersionId: "agent",
      policySnapshotId: "policy",
      workspaceBindingId: null,
      collaborationMode: "default",
      goalBinding: null,
    },
  };
  const outputs: RunLifecycleEvent[] = Array.from(
    { length: 8 },
    (_, index) => ({
      ...created,
      eventId: `output-${index}`,
      sequence: index + 3,
      type: "model.output.delta",
      data: {
        segmentId: "segment",
        segmentSequence: index + 1,
        delta: `part-${index}`,
      },
    }),
  );
  const outbox: OutboxMessage[] = [0, 1].map((index) => ({
    messageId: `message-${index}`,
    tenantId: "tenant",
    runId: "run",
    topic: "run.events.available",
    createdAt: created.occurredAt,
    payload: {
      schemaVersion: "crewon.run-event-range.v0",
      fromSequence: outputs[index * 4]!.sequence,
      throughSequence: outputs[index * 4 + 3]!.sequence,
      firstEventId: outputs[index * 4]!.eventId,
      lastEventId: outputs[index * 4 + 3]!.eventId,
    },
  }));
  await store.commitRun({
    tenantId: "tenant",
    idempotency: { scope: "seed", key: "run", requestFingerprint: "run" },
    expectedRevision: 0,
    events: [
      created,
      {
        ...created,
        eventId: "started",
        sequence: 2,
        type: "run.started",
        data: {},
      },
      ...outputs,
    ],
    outbox,
    workItems: [],
  });
  return {
    store,
    hub,
    owner,
    outputs,
    open,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
