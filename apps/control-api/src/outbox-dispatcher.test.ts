import assert from "node:assert/strict";
import test from "node:test";

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

test("retries Human Gate publication when its typed authority is unavailable", async (context) => {
  const clock = new MutableLeaseClock();
  const store = new InMemoryRunStore({ clock });
  const eventHub = new RunEventHub();
  const message: OutboxMessage = {
    messageId: "outbox-gate-1",
    tenantId: "tenant-1",
    runId: "run-gate-1",
    topic: "workflow.gate.requested",
    payload: { gateRequestId: "gate-request-1" },
    createdAt: "2026-08-08T00:00:01Z",
  };
  await seedThread(store);
  await store.commitRun({
    tenantId: "tenant-1",
    idempotency: { scope: "gate-outbox-test", key: "create-1",
      requestFingerprint: "gate-outbox-fingerprint" },
    expectedRevision: 0,
    events: [createdEvent("run-gate-1")],
    outbox: [message],
    workItems: [],
  });
  const dispatcher = new OutboxDispatcher({ store, eventHub }, {
    ownerId: "dispatcher-1",
    nextLeaseId: () => "lease-gate-1",
    retryAfterMs: 500,
    scanIntervalMs: null,
  });
  context.after(async () => {
    await dispatcher.close();
    eventHub.close();
    await store.close();
  });

  await dispatcher.wake();
  assert.equal(
    dispatcher.lastFailureCode(),
    "workflow_gate_publication_unavailable",
  );
  assert.deepEqual(await store.listPendingOutbox(100), []);
  clock.advance(500);
  assert.deepEqual(await store.listPendingOutbox(100), [message]);
});

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
