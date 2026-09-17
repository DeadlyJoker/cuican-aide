import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  RunApplicationService,
  type ActorContext,
  type ApplicationIdGenerator,
  type ApplicationIdKind,
  type OutboxMessage,
} from "@crewon/application";
import type { RunLifecycleEvent } from "@crewon/domain";
import { InMemoryRunStore } from "@crewon/store";

import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { RunEventHub } from "./run-event-hub.ts";
import { StandaloneAuthorization } from "./standalone-adapters.ts";

test("20,000 foreground triggers reuse one pending delivery and a failed drain remains retryable", async (context) => {
  const store = new InMemoryRunStore(),
    eventHub = new RunEventHub();
  const dispatcher = new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: "coalesced",
      nextLeaseId: () => "lease",
      scanIntervalMs: null,
      retention: null,
    },
  );
  let reject!: (error: Error) => void,
    calls = 0;
  const pending = new Promise<null>((_, fail) => {
    reject = fail;
  });
  context.mock.method(store, "claimNextOutbox", () => {
    calls++;
    return calls === 1 ? pending : Promise.resolve(null);
  });
  context.after(async () => {
    reject(new Error("fixture_closed"));
    await dispatcher.close();
    eventHub.close();
    await store.close();
  });
  const first = dispatcher.wake();
  for (let i = 0; i < 20_000; i++) assert.equal(dispatcher.wake(), first);
  assert.equal(calls, 1);
  reject(new Error("queue_temporarily_unavailable"));
  await first;
  assert.equal(dispatcher.lastFailureCode(), "queue_temporarily_unavailable");
  await dispatcher.wake();
  assert.equal(calls, 2);
  assert.equal(dispatcher.lastFailureCode(), null);
});

test("a synchronous reentrant delivery trigger sees the admitted operation", async (context) => {
  const store = new InMemoryRunStore(),
    eventHub = new RunEventHub();
  const dispatcher = new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: "reentrant",
      nextLeaseId: () => "lease",
      scanIntervalMs: null,
      retention: null,
    },
  );
  let reentrant: Promise<void> | undefined,
    calls = 0;
  context.mock.method(store, "claimNextOutbox", async () => {
    calls++;
    reentrant = dispatcher.wake();
    return null;
  });
  context.after(async () => {
    await dispatcher.close();
    eventHub.close();
    await store.close();
  });
  const wake = dispatcher.wake();
  assert.equal(reentrant, wake);
  await wake;
  assert.equal(calls, 1);
});

test("bridges externally committed Run events through claimed Outbox messages", async (context) => {
  const actor = standaloneActor();
  const store = new InMemoryRunStore({
    clock: { nowEpochMilliseconds: () => Date.parse("2026-08-08T00:01:00Z") },
  });
  const eventHub = new RunEventHub();
  const ids = new IncrementingIds();
  const application = new RunApplicationService({
    store,
    authorization: new StandaloneAuthorization(actor),
    clock: new IncrementingApplicationClock(),
    ids,
  });
  const dispatcher = new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: "dispatcher-1",
      nextLeaseId: () => ids.nextId("outboxLease"),
      scanIntervalMs: null,
    },
  );
  context.after(async () => {
    await dispatcher.close();
    eventHub.close();
    await store.close();
  });

  await seedThread(store);
  const subscription = eventHub.subscribe("run-1");
  const created = await application.createRun(actor, {
    kind: "run.create",
    idempotencyKey: "create-1",
    threadId: "thread-1",
    route: {
      authorityId: "standalone-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
  });
  assert.equal(created.state.runId, "run-1");
  assert.equal((await store.listPendingOutbox(100)).length, 1);
  assert.equal((await store.listPendingWorkItems(100)).length, 1);

  await dispatcher.wake();
  assert.deepEqual(await subscription.next(), {
    done: false,
    value: created.events[0],
  });
  assert.deepEqual(await store.listPendingOutbox(100), []);

  const workerCommit = await application.transitionRun(actor, {
    kind: "run.start",
    runId: created.state.runId,
    expectedRevision: 1,
    idempotencyKey: "worker-start-1",
  });
  assert.equal((await store.listPendingOutbox(100)).length, 1);

  await dispatcher.wake();
  assert.deepEqual(await subscription.next(), {
    done: false,
    value: workerCommit.events[0],
  });
  assert.deepEqual(await store.listPendingOutbox(100), []);
  assert.equal(dispatcher.lastFailureCode(), null);
  subscription.close();
});

test("retries a malformed Outbox message without a busy loop", async (context) => {
  const clock = new MutableLeaseClock();
  const store = new InMemoryRunStore({ clock });
  const eventHub = new RunEventHub();
  const message: OutboxMessage = {
    messageId: "outbox-malformed-1",
    tenantId: "tenant-1",
    runId: "run-malformed-1",
    topic: "run.updated",
    payload: { throughSequence: 1 },
    createdAt: "2026-08-08T00:00:01Z",
  };
  await seedThread(store);
  await store.commitRun({
    tenantId: "tenant-1",
    idempotency: {
      scope: "malformed-outbox-test",
      key: "create-1",
      requestFingerprint: "malformed-outbox-fingerprint",
    },
    expectedRevision: 0,
    events: [createdEvent("run-malformed-1")],
    outbox: [message],
    workItems: [],
  });
  const dispatcher = new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: "dispatcher-1",
      nextLeaseId: () => "lease-malformed-1",
      retryAfterMs: 500,
      scanIntervalMs: null,
    },
  );
  context.after(async () => {
    await dispatcher.close();
    eventHub.close();
    await store.close();
  });

  await dispatcher.wake();
  assert.equal(dispatcher.lastFailureCode(), "outbox_payload_invalid");
  assert.deepEqual(await store.listPendingOutbox(100), []);
  clock.advance(500);
  assert.deepEqual(await store.listPendingOutbox(100), [message]);
});

test("publishes a full range to an active subscriber and preserves every reconnect cursor after slow-subscriber overflow", async (context) => {
  const fixture = await rangeFixture(context, [32]);
  const active = fixture.eventHub.subscribe("run-range");
  const slow = fixture.eventHub.subscribe("run-range");
  const consumed: RunLifecycleEvent[] = [];
  const consume = (async () => {
    for (let index = 0; index < 32; index += 1) {
      const next = await active.next();
      assert.equal(next.done, false);
      consumed.push(next.value!);
    }
  })();
  await fixture.dispatcher.wake();
  await consume;
  assert.deepEqual(consumed, fixture.outputs);
  assert.deepEqual(await slow.next(), { done: true, value: undefined });
  assert.deepEqual(await fixture.store.listPendingOutbox(100), []);
  for (let cursor = 2; cursor <= 34; cursor += 1) {
    const resumed = await fixture.store.listRunEvents(
      { tenantId: "tenant-1", runId: "run-range" },
      cursor,
      32,
    );
    assert.deepEqual(
      resumed,
      fixture.outputs.filter((event) => event.sequence > cursor),
    );
  }
  active.close();
});

test("bounds a dispatcher drain by events even when messages describe ranges", async (context) => {
  const fixture = await rangeFixture(context, [32, 32], 3);
  await fixture.dispatcher.wake();
  assert.equal((await fixture.store.listPendingOutbox(100)).length, 1);
  await fixture.dispatcher.wake();
  assert.deepEqual(await fixture.store.listPendingOutbox(100), []);
});

test("validates the whole durable range before publishing or acknowledging any of it", async (context) => {
  const fixture = await rangeFixture(context, [4]);
  const original = fixture.store.listRunEvents.bind(fixture.store);
  fixture.store.listRunEvents = async (...args) =>
    (await original(...args)).slice(0, 3);
  const subscription = fixture.eventHub.subscribe("run-range");
  await fixture.dispatcher.wake();
  assert.equal(
    fixture.dispatcher.lastFailureCode(),
    "outbox_event_reference_invalid",
  );
  assert.deepEqual(await fixture.store.listPendingOutbox(100), []);
  fixture.clock.advance(500);
  assert.equal((await fixture.store.listPendingOutbox(100)).length, 1);
  subscription.close();
  assert.deepEqual(await subscription.next(), { done: true, value: undefined });
  fixture.store.listRunEvents = original;
  await fixture.dispatcher.wake();
  assert.equal(fixture.dispatcher.lastFailureCode(), null);
  assert.deepEqual(await fixture.store.listPendingOutbox(100), []);
});

async function rangeFixture(
  context: TestContext,
  sizes: number[],
  maxBatchSize = 100,
) {
  const clock = new MutableLeaseClock();
  const store = new InMemoryRunStore({ clock });
  const eventHub = new RunEventHub(2);
  let lease = 0;
  const dispatcher = new OutboxDispatcher(
    { store, eventHub },
    {
      ownerId: "range-dispatcher",
      nextLeaseId: () => `range-lease-${++lease}`,
      retryAfterMs: 500,
      scanIntervalMs: null,
      maxBatchSize,
    },
  );
  context.after(async () => {
    await dispatcher.close();
    eventHub.close();
    await store.close();
  });
  await seedThread(store);
  const created = createdEvent("run-range");
  const outputs: RunLifecycleEvent[] = Array.from(
    { length: sizes.reduce((total, size) => total + size, 0) },
    (_, index) => ({
      ...created,
      eventId: `range-event-${index}`,
      sequence: index + 3,
      type: "model.output.delta",
      data: {
        segmentId: "range-segment",
        segmentSequence: index + 1,
        delta: `part-${index}`,
      },
    }),
  );
  let offset = 0;
  const messages: OutboxMessage[] = sizes.map((count, index) => {
    const first = outputs[offset]!;
    const last = outputs[offset + count - 1]!;
    offset += count;
    return {
      messageId: `range-message-${index}`,
      tenantId: "tenant-1",
      runId: "run-range",
      createdAt: created.occurredAt,
      topic: "run.events.available",
      payload: {
        schemaVersion: "crewon.run-event-range.v0",
        fromSequence: first.sequence,
        throughSequence: last.sequence,
        firstEventId: first.eventId,
        lastEventId: last.eventId,
      },
    };
  });
  await store.commitRun({
    tenantId: "tenant-1",
    expectedRevision: 0,
    idempotency: { scope: "range", key: "range", requestFingerprint: "range" },
    events: [
      created,
      {
        ...created,
        eventId: "range-started",
        sequence: 2,
        type: "run.started",
        data: {},
      },
      ...outputs,
    ],
    outbox: messages,
    workItems: [],
  });
  return { store, eventHub, dispatcher, outputs, clock };
}

class IncrementingIds implements ApplicationIdGenerator {
  readonly #counters = new Map<ApplicationIdKind, number>();

  nextId(kind: ApplicationIdKind): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${kind}-${next}`;
  }
}

class IncrementingApplicationClock {
  #second = 0;

  now(): string {
    this.#second += 1;
    return `2026-08-08T00:00:${this.#second.toString().padStart(2, "0")}Z`;
  }
}

class MutableLeaseClock {
  #now = Date.parse("2026-08-08T00:01:00Z");

  nowEpochMilliseconds(): number {
    return this.#now;
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

function createdEvent(runId: string): RunLifecycleEvent {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId },
    eventId: "event-malformed-1",
    sequence: 1,
    occurredAt: "2026-08-08T00:00:01Z",
    type: "run.created",
    data: {
      threadId: "thread-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
      createdByActorId: "actor-1",
      authorityId: "standalone-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
      collaborationMode: "default",
      goalBinding: null,
    },
  };
}

function standaloneActor(): ActorContext {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
}

async function seedThread(store: InMemoryRunStore): Promise<void> {
  await store.commitThread({
    tenantId: "tenant-1",
    idempotency: {
      scope: "outbox-test-thread",
      key: "create-thread-1",
      requestFingerprint: "create-thread-fingerprint",
    },
    expectedRevision: 0,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread-1" },
        eventId: "thread-event-created-1",
        sequence: 1,
        occurredAt: "2026-08-08T00:00:00Z",
        type: "thread.created",
        data: {
          tenantId: "tenant-1",
          spaceId: "space-1",
          createdByActorId: "actor-1",
          title: null,
        },
      },
    ],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
  });
}
