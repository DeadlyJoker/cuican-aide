import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryRunStore } from "@crewon/store";
import type { RunLifecycleEvent } from "@crewon/domain";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { RunEventHub } from "./run-event-hub.ts";

test("durable consumer settles before an actual event is published or acknowledged", async (t) => {
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async (events) => {
    assert.deepEqual(events, [f.event]);
    enter();
    await gate;
  });
  let acknowledgments = 0,
    publications = 0;
  const ack = f.store.acknowledgeOutbox.bind(f.store);
  t.mock.method(
    f.store,
    "acknowledgeOutbox",
    async (...args: Parameters<InMemoryRunStore["acknowledgeOutbox"]>) => {
      acknowledgments++;
      return ack(...args);
    },
  );
  const publish = f.hub.publish.bind(f.hub);
  t.mock.method(f.hub, "publish", (events: readonly RunLifecycleEvent[]) => {
    publications++;
    return publish(events);
  });
  const drain = f.dispatcher.wake();
  await Promise.race([
    entered,
    drain.then(() => {
      assert.equal(f.dispatcher.lastFailureCode(), null);
      throw new Error("consumer_not_entered");
    }),
  ]);
  assert.equal(acknowledgments, 0);
  assert.equal(publications, 0);
  release();
  await drain;
  assert.equal(acknowledgments, 1);
  assert.equal(publications, 1);
  assert.deepEqual(await f.store.listPendingOutbox(4), []);
});

test("a failed durable consumer leaves the original outbox reference retryable", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    if (++calls === 1) throw new Error("named_plan_checkpoint_failed");
  });
  await f.dispatcher.wake();
  assert.equal(f.dispatcher.lastFailureCode(), "named_plan_checkpoint_failed");
  f.advance();
  assert.equal((await f.store.listPendingOutbox(4)).length, 1);
  await f.dispatcher.wake();
  assert.equal(calls, 2);
  assert.equal(f.dispatcher.lastFailureCode(), null);
  assert.deepEqual(await f.store.listPendingOutbox(4), []);
});

test("invalid durable event identity never reaches the plan consumer", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
  });
  t.mock.method(f.store, "listRunEvents", async () => []);
  await f.dispatcher.wake();
  assert.equal(calls, 0);
  assert.equal(
    f.dispatcher.lastFailureCode(),
    "outbox_event_reference_invalid",
  );
  f.advance();
  assert.equal((await f.store.listPendingOutbox(4)).length, 1);
});

async function fixture(
  t: TestContext,
  consumeRunEvents: (events: readonly RunLifecycleEvent[]) => Promise<void>,
) {
  let now = Date.parse("2026-10-06T01:00:00Z"),
    lease = 0;
  const store = new InMemoryRunStore({
    clock: { nowEpochMilliseconds: () => now },
  });
  const hub = new RunEventHub();
  const event: RunLifecycleEvent = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "plan-run" },
    eventId: "plan-created",
    sequence: 1,
    occurredAt: "2026-10-06T00:00:01Z",
    type: "run.created",
    data: {
      threadId: "plan-thread",
      tenantId: "tenant",
      spaceId: "space",
      createdByActorId: "actor",
      authorityId: "authority",
      runtimeGeneration: "ts-v0",
      agentVersionId: "version",
      policySnapshotId: "policy",
      workspaceBindingId: null,
      collaborationMode: "default",
      goalBinding: null,
    },
  };
  await store.commitThread({
    tenantId: "tenant",
    expectedRevision: 0,
    idempotency: {
      scope: "plan-outbox-thread",
      key: "thread",
      requestFingerprint: "thread",
    },
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "plan-thread" },
        eventId: "thread-created",
        sequence: 1,
        occurredAt: "2026-10-06T00:00:00Z",
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
  await store.commitRun({
    tenantId: "tenant",
    expectedRevision: 0,
    idempotency: {
      scope: "plan-outbox-run",
      key: "run",
      requestFingerprint: "run",
    },
    events: [event],
    workItems: [],
    outbox: [
      {
        messageId: "plan-outbox",
        tenantId: "tenant",
        runId: "plan-run",
        topic: "run.updated",
        createdAt: event.occurredAt,
        payload: {
          eventId: event.eventId,
          throughSequence: event.sequence,
          eventType: event.type,
        },
      },
    ],
  });
  const dispatcher = new OutboxDispatcher(
    { store, eventHub: hub, consumeRunEvents },
    {
      ownerId: "plan-consumer",
      nextLeaseId: () => `lease-${++lease}`,
      retryAfterMs: 500,
      scanIntervalMs: null,
      retention: null,
    },
  );
  t.after(async () => {
    await dispatcher.close();
    hub.close();
    await store.close();
  });
  return {
    store,
    hub,
    dispatcher,
    event,
    advance: () => {
      now += 500;
    },
  };
}
