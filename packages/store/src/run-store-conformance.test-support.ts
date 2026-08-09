import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";

import type { RunLifecycleEvent, RunState } from "@crewon/domain";

import {
  RunStoreError,
  type CommitRunInput,
  type OutboxMessage,
  type RunStore,
  type ThreadStore,
  type WorkItem,
} from "@crewon/application";
import type { LeaseClock } from "./lease-clock.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";

const FIXED_NOW = Date.parse("2026-08-08T00:01:00Z");

/** Registers the behavioral contract every RunStore adapter must satisfy. */
export function registerRunStoreConformance(
  name: string,
  createStore: (
    clock: LeaseClock,
  ) => RunConformanceStore | Promise<RunConformanceStore>,
  options: Readonly<{ databaseTimeQueue?: boolean }> = {},
): void {
  describe(name, () => {
    test("atomically commits event, snapshot, queues and idempotency receipt", async (context) => {
      const store = await managedStore(context, createStore);
      const input = createRunningCommitFixture();
      const committed = await store.commitRun(input);

      assert.deepEqual(committed, {
        disposition: "committed",
        state: runningStateFixture(),
        events: input.events,
        outbox: input.outbox,
        workItems: input.workItems,
      });
      assert.deepEqual(
        await store.loadRun(runLocator()),
        runningStateFixture(),
      );
      assert.deepEqual(
        await store.listRunEvents(runLocator(), 0, 100),
        input.events,
      );
      assert.deepEqual(await store.listPendingOutbox(100), input.outbox);
      assert.deepEqual(await store.listPendingWorkItems(100), input.workItems);

      assert.deepEqual(await store.commitRun(input), {
        ...committed,
        disposition: "replayed",
      });
    });

    test("rejects idempotency reuse and stale revisions without changing state", async (context) => {
      const store = await managedStore(context, createStore);
      const input = createRunningCommitFixture();
      await store.commitRun(input);

      await assert.rejects(
        store.commitRun({
          ...input,
          idempotency: {
            ...input.idempotency,
            requestFingerprint: "changed-command",
          },
          events: [input.events[0]],
        }),
        hasStoreCode("idempotency_conflict"),
      );
      await assert.rejects(
        store.commitRun({
          tenantId: "tenant-1",
          idempotency: idempotency("stale-revision"),
          expectedRevision: 1,
          events: [approvalEvent(3)],
          outbox: [],
          workItems: [],
        }),
        hasStoreCode("revision_conflict"),
      );

      assert.deepEqual(
        await store.loadRun(runLocator()),
        runningStateFixture(),
      );
      assert.deepEqual(
        await store.listRunEvents(runLocator(), 0, 100),
        input.events,
      );
    });

    test("rolls back the whole commit on reducer or outbox failure", async (context) => {
      const store = await managedStore(context, createStore);
      await assert.rejects(
        store.commitRun({
          tenantId: "tenant-1",
          idempotency: idempotency("invalid-transition"),
          expectedRevision: 0,
          events: [createdEvent(), completedEvent(2)],
          outbox: [outboxMessage("outbox-invalid", 2)],
          workItems: [workItem("work-item-invalid", 2)],
        }),
      );
      assert.equal(await store.loadRun(runLocator()), null);
      assert.deepEqual(await store.listRunEvents(runLocator(), 0, 100), []);
      assert.deepEqual(await store.listPendingOutbox(100), []);

      const seed = createRunningCommitFixture();
      await store.commitRun(seed);
      await assert.rejects(
        store.commitRun({
          tenantId: "tenant-1",
          idempotency: idempotency("duplicate-outbox"),
          expectedRevision: 2,
          events: [approvalEvent(3)],
          outbox: [outboxMessage("outbox-1", 3)],
          workItems: [],
        }),
        hasStoreCode("outbox_message_conflict"),
      );
      await assert.rejects(
        store.commitRun({
          tenantId: "tenant-1",
          idempotency: idempotency("duplicate-work-item"),
          expectedRevision: 2,
          events: [approvalEvent(3)],
          outbox: [],
          workItems: [workItem("work-item-1", 3)],
        }),
        hasStoreCode("work_item_conflict"),
      );
      assert.deepEqual(
        await store.loadRun(runLocator()),
        runningStateFixture(),
      );
      assert.deepEqual(
        await store.listRunEvents(runLocator(), 0, 100),
        seed.events,
      );

      const cyclicPayload: Record<string, unknown> = {};
      cyclicPayload.self = cyclicPayload;
      await assert.rejects(
        store.commitRun({
          tenantId: "tenant-1",
          idempotency: idempotency("malformed-outbox"),
          expectedRevision: 2,
          events: [approvalEvent(3)],
          outbox: [
            {
              ...outboxMessage("outbox-malformed", 3),
              payload: cyclicPayload,
            } as OutboxMessage,
          ],
          workItems: [],
        }),
        hasStoreCode("non_json_value"),
      );
      assert.deepEqual(
        await store.loadRun(runLocator()),
        runningStateFixture(),
      );
      assert.deepEqual(
        await store.listRunEvents(runLocator(), 0, 100),
        seed.events,
      );
    });

    test("requires an active same-space Thread before creating a Run", async (context) => {
      const store = await createStore(new ManualLeaseClock());
      context.after(() => store.close());
      const input = createRunningCommitFixture();

      await assert.rejects(
        store.commitRun(input),
        hasStoreCode("thread_not_found"),
      );
      await seedThread(store, { spaceId: "space-2" });
      await assert.rejects(
        store.commitRun(input),
        hasStoreCode("thread_not_found"),
      );
      assert.equal(await store.loadRun(runLocator()), null);
      assert.deepEqual(await store.listRunEvents(runLocator(), 0, 100), []);
      assert.deepEqual(await store.listPendingOutbox(100), []);
      assert.deepEqual(await store.listPendingWorkItems(100), []);
    });

    test("allows exactly one concurrent writer for an expected revision", async (context) => {
      const store = await managedStore(context, createStore);
      await store.commitRun({
        tenantId: "tenant-1",
        idempotency: idempotency("create-only"),
        expectedRevision: 0,
        events: [createdEvent()],
        outbox: [],
        workItems: [],
      });

      const results = await Promise.allSettled([
        store.commitRun({
          tenantId: "tenant-1",
          idempotency: idempotency("writer-a"),
          expectedRevision: 1,
          events: [startedEvent(2, "event-writer-a")],
          outbox: [],
          workItems: [],
        }),
        store.commitRun({
          tenantId: "tenant-1",
          idempotency: idempotency("writer-b"),
          expectedRevision: 1,
          events: [startedEvent(2, "event-writer-b")],
          outbox: [],
          workItems: [],
        }),
      ]);

      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.ok(
        rejected.reason instanceof RunStoreError &&
          rejected.reason.code === "revision_conflict",
      );
      assert.equal((await store.loadRun(runLocator()))?.revision, 2);
      assert.equal((await store.listRunEvents(runLocator(), 0, 100)).length, 2);
    });

    test("returns stable sequence pagination with a hard limit", async (context) => {
      const store = await managedStore(context, createStore);
      const input = createRunningCommitFixture();
      await store.commitRun(input);

      assert.deepEqual(await store.listRunEvents(runLocator(), 1, 1), [
        input.events[1],
      ]);
      await assert.rejects(
        store.listRunEvents(runLocator(), 0, 1_001),
        hasStoreCode("page_limit_invalid"),
      );
    });

    test("lists a Thread's Runs with a stable newest-first cursor", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store, { threadId: "thread-2" });
      await store.commitRun(runListCommit("run-list-1", "thread-1", 10));
      await store.commitRun(runListCommit("run-list-2", "thread-1", 20));
      await store.commitRun(runListCommit("run-other-thread", "thread-2", 30));

      const first = await store.listThreadRuns({
        tenantId: "tenant-1",
        spaceId: "space-1",
        threadId: "thread-1",
        before: null,
        limit: 1,
      });
      assert.deepEqual(
        first.map(({ runId }) => runId),
        ["run-list-2"],
      );
      const second = await store.listThreadRuns({
        tenantId: "tenant-1",
        spaceId: "space-1",
        threadId: "thread-1",
        before: {
          runId: first[0]!.runId,
          updatedAt: first[0]!.updatedAt,
        },
        limit: 100,
      });
      assert.deepEqual(
        second.map(({ runId }) => runId),
        ["run-list-1"],
      );
    });

    test("enforces globally unique event identifiers without partial writes", async (context) => {
      const store = await managedStore(context, createStore);
      await store.commitRun(createRunningCommitFixture());
      const duplicateEventId: RunLifecycleEvent = {
        ...createdEvent(),
        identity: { runId: "run-store-2" },
        eventId: "event-2",
        occurredAt: "2026-08-08T00:01:00Z",
        data: {
          ...createdEvent().data,
          threadId: "thread-2",
        },
      };

      await assert.rejects(
        store.commitRun({
          tenantId: "tenant-1",
          idempotency: idempotency("duplicate-event-id"),
          expectedRevision: 0,
          events: [duplicateEventId],
          outbox: [],
          workItems: [],
        }),
        hasStoreCode("event_id_conflict"),
      );
      assert.equal(await store.loadRun(runLocator("run-store-2")), null);
    });

    test("rejects oversized events before writing any state", async (context) => {
      const store = await managedStore(context, createStore);
      const oversized: RunLifecycleEvent = {
        ...createdEvent(),
        data: {
          ...createdEvent().data,
          threadId: "x".repeat(64 * 1024),
        },
      };

      await assert.rejects(
        store.commitRun({
          tenantId: "tenant-1",
          idempotency: idempotency("oversized-event"),
          expectedRevision: 0,
          events: [oversized],
          outbox: [],
          workItems: [],
        }),
        hasStoreCode("event_too_large"),
      );
      assert.equal(await store.loadRun(runLocator()), null);
    });

    if (options.databaseTimeQueue !== true) {
      test("reclaims an expired Outbox lease and fences the stale owner", async (context) => {
        const clock = new ManualLeaseClock();
        const store = await createStore(clock);
        context.after(() => store.close());
        await seedThread(store);
        const input = createRunningCommitFixture();
        await store.commitRun(input);

        const first = await store.claimNextOutbox({
          ownerId: "dispatcher-a",
          leaseId: "lease-a",
          leaseDurationMs: 1_000,
        });
        assert.deepEqual(first, {
          message: input.outbox[0],
          lease: {
            ownerId: "dispatcher-a",
            leaseId: "lease-a",
            epoch: 1,
            expiresAt: "2026-08-08T00:01:01.000Z",
          },
        });
        assert.deepEqual(await store.listPendingOutbox(100), []);
        assert.equal(
          await store.claimNextOutbox({
            ownerId: "dispatcher-b",
            leaseId: "lease-b-too-early",
            leaseDurationMs: 1_000,
          }),
          null,
        );

        clock.advance(1_000);
        const reclaimed = await store.claimNextOutbox({
          ownerId: "dispatcher-b",
          leaseId: "lease-b",
          leaseDurationMs: 1_000,
        });
        assert.deepEqual(reclaimed, {
          message: input.outbox[0],
          lease: {
            ownerId: "dispatcher-b",
            leaseId: "lease-b",
            epoch: 2,
            expiresAt: "2026-08-08T00:01:02.000Z",
          },
        });

        await assert.rejects(
          store.acknowledgeOutbox({
            messageId: input.outbox[0].messageId,
            ownerId: first.lease.ownerId,
            leaseId: first.lease.leaseId,
            leaseEpoch: first.lease.epoch,
          }),
          hasStoreCode("stale_lease"),
        );
        await store.acknowledgeOutbox({
          messageId: input.outbox[0].messageId,
          ownerId: reclaimed.lease.ownerId,
          leaseId: reclaimed.lease.leaseId,
          leaseEpoch: reclaimed.lease.epoch,
        });
        assert.deepEqual(await store.listPendingOutbox(100), []);
        assert.equal(
          await store.claimNextOutbox({
            ownerId: "dispatcher-c",
            leaseId: "lease-c",
            leaseDurationMs: 1_000,
          }),
          null,
        );
        await assert.rejects(
          store.acknowledgeOutbox({
            messageId: input.outbox[0].messageId,
            ownerId: reclaimed.lease.ownerId,
            leaseId: reclaimed.lease.leaseId,
            leaseEpoch: reclaimed.lease.epoch,
          }),
          hasStoreCode("queue_item_already_settled"),
        );
      });

      test("delays retries and completes a fenced Work Item", async (context) => {
        const clock = new ManualLeaseClock();
        const store = await createStore(clock);
        context.after(() => store.close());
        await seedThread(store);
        const input = createRunningCommitFixture();
        await store.commitRun(input);

        const firstOutbox = await store.claimNextOutbox({
          ownerId: "dispatcher-a",
          leaseId: "outbox-lease-1",
          leaseDurationMs: 1_000,
        });
        assert.ok(firstOutbox !== null);
        await store.retryOutbox({
          messageId: firstOutbox.message.messageId,
          ownerId: firstOutbox.lease.ownerId,
          leaseId: firstOutbox.lease.leaseId,
          leaseEpoch: firstOutbox.lease.epoch,
          retryAfterMs: 500,
          reasonCode: "subscriber_unavailable",
        });
        assert.equal(
          await store.claimNextOutbox({
            ownerId: "dispatcher-a",
            leaseId: "outbox-lease-too-early",
            leaseDurationMs: 1_000,
          }),
          null,
        );
        clock.advance(500);
        const retriedOutbox = await store.claimNextOutbox({
          ownerId: "dispatcher-a",
          leaseId: "outbox-lease-2",
          leaseDurationMs: 1_000,
        });
        assert.equal(retriedOutbox?.lease.epoch, 2);

        const firstWorkItem = await store.claimNextWorkItem({
          ownerId: "worker-a",
          leaseId: "work-lease-1",
          leaseDurationMs: 1_000,
        });
        assert.deepEqual(firstWorkItem?.workItem, input.workItems[0]);
        assert.equal(firstWorkItem?.lease.epoch, 1);
        assert.ok(firstWorkItem !== null);
        await store.retryWorkItem({
          workItemId: firstWorkItem.workItem.workItemId,
          ownerId: firstWorkItem.lease.ownerId,
          leaseId: firstWorkItem.lease.leaseId,
          leaseEpoch: firstWorkItem.lease.epoch,
          retryAfterMs: 250,
          reasonCode: "runtime_unavailable",
        });
        assert.equal(
          await store.claimNextWorkItem({
            ownerId: "worker-a",
            leaseId: "work-lease-too-early",
            leaseDurationMs: 1_000,
          }),
          null,
        );
        clock.advance(250);
        const retriedWorkItem = await store.claimNextWorkItem({
          ownerId: "worker-b",
          leaseId: "work-lease-2",
          leaseDurationMs: 1_000,
        });
        assert.equal(retriedWorkItem?.lease.epoch, 2);
        assert.ok(retriedWorkItem !== null);
        await assert.rejects(
          store.completeWorkItem({
            workItemId: firstWorkItem.workItem.workItemId,
            ownerId: firstWorkItem.lease.ownerId,
            leaseId: firstWorkItem.lease.leaseId,
            leaseEpoch: firstWorkItem.lease.epoch,
          }),
          hasStoreCode("stale_lease"),
        );
        await store.completeWorkItem({
          workItemId: retriedWorkItem.workItem.workItemId,
          ownerId: retriedWorkItem.lease.ownerId,
          leaseId: retriedWorkItem.lease.leaseId,
          leaseEpoch: retriedWorkItem.lease.epoch,
        });
        assert.deepEqual(await store.listPendingWorkItems(100), []);
      });

      test("renews a Work Item lease without weakening epoch fencing", async (context) => {
        const clock = new ManualLeaseClock();
        const store = await createStore(clock);
        context.after(() => store.close());
        await seedThread(store);
        await store.commitRun(createRunningCommitFixture());
        const first = await store.claimNextWorkItem({
          ownerId: "worker-a",
          leaseId: "work-renew-1",
          leaseDurationMs: 1_000,
        });
        assert.ok(first !== null);
        clock.advance(500);

        assert.deepEqual(
          await store.renewWorkItemLease({
            workItemId: first.workItem.workItemId,
            ownerId: first.lease.ownerId,
            leaseId: first.lease.leaseId,
            leaseEpoch: first.lease.epoch,
            leaseDurationMs: 1_000,
          }),
          {
            ownerId: "worker-a",
            leaseId: "work-renew-1",
            epoch: 1,
            expiresAt: "2026-08-08T00:01:01.500Z",
          },
        );
        clock.advance(500);
        assert.equal(
          await store.claimNextWorkItem({
            ownerId: "worker-b",
            leaseId: "work-too-early",
            leaseDurationMs: 1_000,
          }),
          null,
        );
        clock.advance(500);
        const reclaimed = await store.claimNextWorkItem({
          ownerId: "worker-b",
          leaseId: "work-reclaimed",
          leaseDurationMs: 1_000,
        });
        assert.equal(reclaimed?.lease.epoch, 2);
        await assert.rejects(
          store.renewWorkItemLease({
            workItemId: first.workItem.workItemId,
            ownerId: first.lease.ownerId,
            leaseId: first.lease.leaseId,
            leaseEpoch: first.lease.epoch,
            leaseDurationMs: 1_000,
          }),
          hasStoreCode("stale_lease"),
        );
      });
    }
  });
}

async function managedStore(
  context: TestContext,
  createStore: (
    clock: LeaseClock,
  ) => RunConformanceStore | Promise<RunConformanceStore>,
): Promise<RunConformanceStore> {
  const store = await createStore(new ManualLeaseClock());
  context.after(() => store.close());
  await seedThread(store);
  return store;
}

type RunConformanceStore = RunStore & ThreadStore;

export function createRunningCommitFixture(
  collaborationMode: "default" | "plan" = "default",
): CommitRunInput {
  const events = [
    {
      ...createdEvent(),
      data: { ...createdEvent().data, collaborationMode },
    },
    startedEvent(2),
  ] as const;
  return {
    tenantId: "tenant-1",
    idempotency: idempotency("create-running-run"),
    expectedRevision: 0,
    events,
    outbox: [outboxMessage("outbox-1", 2)],
    workItems: [workItem("work-item-1", 2)],
  };
}

function runListCommit(
  runId: string,
  threadId: string,
  startSecond: number,
): CommitRunInput {
  const timestamp = (offset: number) =>
    `2026-08-08T00:00:${(startSecond + offset).toString().padStart(2, "0")}Z`;
  const created: Extract<RunLifecycleEvent, { type: "run.created" }> = {
    ...createdEvent(),
    identity: { runId },
    eventId: `${runId}:created`,
    occurredAt: timestamp(0),
    data: { ...createdEvent().data, threadId },
  };
  const started: RunLifecycleEvent = {
    ...startedEvent(2),
    identity: { runId },
    eventId: `${runId}:started`,
    occurredAt: timestamp(1),
  };
  return {
    tenantId: "tenant-1",
    idempotency: idempotency(`list:${runId}`),
    expectedRevision: 0,
    events: [created, started],
    outbox: [
      {
        ...outboxMessage(`${runId}:outbox`, 2),
        runId,
        createdAt: timestamp(1),
      },
    ],
    workItems: [
      {
        ...workItem(`${runId}:work`, 2),
        runId,
        createdAt: timestamp(1),
      },
    ],
  };
}

function createdEvent(): Extract<RunLifecycleEvent, { type: "run.created" }> {
  return event(1, "run.created", {
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
    origin: null,
    goalBinding: null,
  }) as Extract<RunLifecycleEvent, { type: "run.created" }>;
}

function startedEvent(
  sequence: number,
  eventId = `event-${sequence}`,
): RunLifecycleEvent {
  return event(sequence, "run.started", {}, eventId);
}

function completedEvent(sequence: number): RunLifecycleEvent {
  return event(sequence, "run.completed", { outputRef: "artifact-1" });
}

function approvalEvent(sequence: number): RunLifecycleEvent {
  return event(sequence, "run.approval.required", {
    approvalId: "approval-1",
    actionDigest: "sha256:action-1",
  });
}

function event(
  sequence: number,
  type: RunLifecycleEvent["type"],
  data: Record<string, unknown>,
  eventId = `event-${sequence}`,
): RunLifecycleEvent {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId,
    sequence,
    occurredAt: `2026-08-08T00:00:${sequence.toString().padStart(2, "0")}Z`,
    type,
    data,
  } as RunLifecycleEvent;
}

function outboxMessage(
  messageId: string,
  throughSequence: number,
): OutboxMessage {
  return {
    messageId,
    tenantId: "tenant-1",
    runId: "run-store-1",
    topic: "run.updated",
    payload: { throughSequence },
    createdAt: `2026-08-08T00:00:${throughSequence.toString().padStart(2, "0")}Z`,
  };
}

function workItem(workItemId: string, throughSequence: number): WorkItem {
  return {
    workItemId,
    tenantId: "tenant-1",
    runId: "run-store-1",
    kind: "run.execute",
    payload: { throughSequence },
    createdAt: `2026-08-08T00:00:${throughSequence.toString().padStart(2, "0")}Z`,
  };
}

export class ManualLeaseClock implements LeaseClock {
  #now: number;

  constructor(now = FIXED_NOW) {
    this.#now = now;
  }

  nowEpochMilliseconds(): number {
    return this.#now;
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

export function runningStateFixture(): RunState {
  return {
    runId: "run-store-1",
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
    origin: null,
    goalBinding: null,
    goalAccounting: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    status: "running",
    revision: 2,
    lastSequence: 2,
    cancelRequested: false,
    waitingApproval: null,
    suspensionReasonCode: null,
    reconciliationReceiptId: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-08T00:00:01Z",
    updatedAt: "2026-08-08T00:00:02Z",
    terminalAt: null,
  };
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}

function runLocator(runId = "run-store-1") {
  return { tenantId: "tenant-1", runId } as const;
}

function idempotency(key: string) {
  return {
    scope: "tenant-1:actor-1:run-commands",
    key,
    requestFingerprint: `fingerprint:${key}`,
  } as const;
}
