import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test, type TestContext } from "node:test";

import {
  ApplicationError,
  AutomationApplicationService,
  type AutomationApplicationIdGenerator,
  type AutomationStore,
  type DurableQueueStore,
  type ModelHistoryStore,
  type RunStore,
  type ThreadRollbackStore,
  type ThreadStore,
} from "@crewon/application";
import {
  createThreadRollbackArtifacts,
  type ThreadLifecycleEvent,
} from "@crewon/domain";

export type AutomationConformanceStore = AutomationStore &
  ThreadStore &
  RunStore &
  ModelHistoryStore &
  ThreadRollbackStore &
  DurableQueueStore &
  Readonly<{ close(): Promise<void> }>;

export function registerAutomationStoreConformance(
  name: string,
  createStore: () =>
    | AutomationConformanceStore
    | Promise<AutomationConformanceStore>,
): void {
  describe(name, () => {
    test("atomically creates and invokes one manual-only Automation", async (context) => {
      const store = await managedStore(context, createStore);
      await seedAutomationThread(store);
      const service = automationApplicationService(store);

      const created = await service.createAutomation(
        actor(),
        automationCreateCommand(),
      );
      assert.equal(created.disposition, "committed");
      assert.deepEqual(
        await service.createAutomation(actor(), automationCreateCommand()),
        { ...created, disposition: "replayed" },
      );

      const invoked = await service.runAutomationNow(
        actor(),
        automationRunCommand(),
      );
      assert.equal(invoked.disposition, "committed");
      assert.deepEqual(invoked.binding, invoked.message.origin.binding);
      assert.deepEqual(invoked.binding, invoked.historyItem.origin.binding);
      assert.deepEqual(invoked.binding, invoked.runEvent.data.origin?.binding);
      assert.deepEqual(invoked.binding, invoked.workItem.payload.binding);
      assert.equal(
        invoked.runState.origin?.binding.runId,
        invoked.runState.runId,
      );
      assert.deepEqual(
        await service.runAutomationNow(actor(), automationRunCommand()),
        { ...invoked, disposition: "replayed" },
      );
      assert.deepEqual(
        await store.listMessages(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          100,
        ),
        [invoked.message],
      );
      assert.deepEqual(
        await store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          100,
        ),
        [invoked.historyItem],
      );
      assert.deepEqual(
        await store.loadRun({
          tenantId: "tenant-1",
          runId: invoked.runState.runId,
        }),
        invoked.runState,
      );
      assert.deepEqual(await store.listPendingWorkItems(100), [
        invoked.workItem,
      ]);
    });

    test("fences active Runs and terminal Runs with unsettled Work", async (context) => {
      const store = await managedStore(context, createStore);
      await seedAutomationThread(store);
      const service = automationApplicationService(store);
      await service.createAutomation(actor(), automationCreateCommand());
      const first = await service.runAutomationNow(
        actor(),
        automationRunCommand(),
      );
      const secondCommand = {
        ...automationRunCommand(),
        idempotencyKey: "automation-run-2",
        expectedThreadRevision: 2,
      } as const;

      await assert.rejects(
        service.runAutomationNow(actor(), secondCommand),
        applicationError("conflict", "thread_active_run_conflict"),
      );
      await store.commitRun({
        tenantId: "tenant-1",
        idempotency: {
          scope: "automation-conformance-terminal",
          key: "terminal",
          requestFingerprint: "terminal",
        },
        expectedRevision: 1,
        events: [
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: first.runState.runId },
            eventId: "automation-run-started",
            sequence: 2,
            occurredAt: "2026-08-09T00:00:01Z",
            type: "run.started",
            data: {},
          },
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: first.runState.runId },
            eventId: "automation-run-completed",
            sequence: 3,
            occurredAt: "2026-08-09T00:00:02Z",
            type: "run.completed",
            data: { outputRef: null },
          },
        ],
        outbox: [],
        workItems: [],
      });
      await assert.rejects(
        service.runAutomationNow(actor(), secondCommand),
        applicationError("conflict", "thread_unsettled_work_conflict"),
      );
      const claim = await store.claimNextWorkItem({
        ownerId: "automation-conformance-worker",
        leaseId: "automation-conformance-lease",
        leaseDurationMs: 60_000,
      });
      assert.ok(claim !== null);
      await assert.rejects(
        service.runAutomationNow(actor(), secondCommand),
        applicationError("conflict", "thread_unsettled_work_conflict"),
      );
      await store.completeWorkItem({
        workItemId: claim.workItem.workItemId,
        ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId,
        leaseEpoch: claim.lease.epoch,
      });
      assert.equal(
        (await service.runAutomationNow(actor(), secondCommand)).disposition,
        "committed",
      );
    });

    test("isolates tenant/space and replays create after Thread tombstone", async (context) => {
      const store = await managedStore(context, createStore);
      await seedAutomationThread(store);
      const service = automationApplicationService(store);
      const created = await service.createAutomation(
        actor(),
        automationCreateCommand(),
      );
      assert.equal(
        await store.loadAutomation({
          tenantId: "tenant-2",
          spaceId: "space-1",
          automationId: created.record.definition.automationId,
        }),
        null,
      );
      assert.equal(
        await store.loadAutomation({
          tenantId: "tenant-1",
          spaceId: "space-2",
          automationId: created.record.definition.automationId,
        }),
        null,
      );
      assert.deepEqual(
        await store.listAutomations({
          tenantId: "tenant-1",
          spaceId: "space-2",
          before: null,
          limit: 100,
        }),
        [],
      );
      await store.commitThread(deleteThreadInput());
      assert.deepEqual(
        await service.createAutomation(actor(), automationCreateCommand()),
        { ...created, disposition: "replayed" },
      );
      await assert.rejects(
        service.runAutomationNow(actor(), automationRunCommand()),
        applicationError("conflict", "automation_thread_not_active"),
      );
    });

    test("replays the immutable invocation after its Message is rolled back", async (context) => {
      const store = await managedStore(context, createStore);
      await seedAutomationThread(store);
      const service = automationApplicationService(store);
      await service.createAutomation(actor(), automationCreateCommand());
      const invoked = await service.runAutomationNow(
        actor(),
        automationRunCommand(),
      );
      await store.commitRun({
        tenantId: "tenant-1",
        idempotency: {
          scope: "automation-conformance-rollback-terminal",
          key: "terminal",
          requestFingerprint: "terminal",
        },
        expectedRevision: 1,
        events: [
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: invoked.runState.runId },
            eventId: "automation-rollback-run-started",
            sequence: 2,
            occurredAt: "2026-08-09T00:00:01Z",
            type: "run.started",
            data: {},
          },
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: invoked.runState.runId },
            eventId: "automation-rollback-run-completed",
            sequence: 3,
            occurredAt: "2026-08-09T00:00:02Z",
            type: "run.completed",
            data: { outputRef: null },
          },
        ],
        outbox: [],
        workItems: [],
      });
      const claim = await store.claimNextWorkItem({
        ownerId: "automation-rollback-worker",
        leaseId: "automation-rollback-lease",
        leaseDurationMs: 60_000,
      });
      assert.ok(claim !== null);
      await store.completeWorkItem({
        workItemId: claim.workItem.workItemId,
        ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId,
        leaseEpoch: claim.lease.epoch,
      });
      const rollback = createThreadRollbackArtifacts([invoked.historyItem], {
        tenantId: "tenant-1",
        threadId: "thread-1",
        actorId: "actor-1",
        rollbackId: "automation-rollback-1",
        markerItemId: "automation-rollback-marker-1",
        threadEventId: "automation-rollback-event-1",
        threadEventSequence: 3,
        occurredAt: "2026-08-09T00:00:03Z",
        requestedTurns: 1,
      });
      await store.commitThreadRollback({
        tenantId: "tenant-1",
        idempotency: {
          scope: "automation-conformance-rollback",
          key: "rollback",
          requestFingerprint: "rollback",
        },
        expectedThreadRevision: 2,
        expectedHistorySequence: 1,
        event: rollback.event,
        marker: rollback.marker,
      });
      const audit = await store.listMessages(
        { tenantId: "tenant-1", threadId: "thread-1" },
        0,
        100,
        "audit",
      );
      assert.equal(audit[0]?.invalidation?.rollbackId, "automation-rollback-1");
      assert.deepEqual(
        await service.runAutomationNow(actor(), automationRunCommand()),
        { ...invoked, disposition: "replayed" },
      );
    });
  });
}

async function managedStore(
  context: TestContext,
  createStore: () =>
    | AutomationConformanceStore
    | Promise<AutomationConformanceStore>,
) {
  const store = await createStore();
  context.after(() => store.close());
  return store;
}

export async function seedAutomationThread(store: ThreadStore): Promise<void> {
  const event: ThreadLifecycleEvent = {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: "thread-created",
    sequence: 1,
    occurredAt: "2026-08-08T00:00:00Z",
    type: "thread.created",
    data: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      createdByActorId: "actor-1",
      title: "Automation thread",
    },
  };
  await store.commitThread({
    tenantId: "tenant-1",
    idempotency: {
      scope: "automation-conformance-thread",
      key: "create",
      requestFingerprint: "create",
    },
    expectedRevision: 0,
    events: [event],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
  });
}

function deleteThreadInput() {
  const occurredAt = "2026-08-09T00:00:03Z";
  return {
    tenantId: "tenant-1",
    idempotency: {
      scope: "automation-conformance-thread",
      key: "delete",
      requestFingerprint: "delete",
    },
    expectedRevision: 1,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0" as const,
        identity: { threadId: "thread-1" },
        eventId: "thread-deleted",
        sequence: 2,
        occurredAt,
        type: "thread.deleted" as const,
        data: { actorId: "actor-1" },
      },
    ],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
    tombstone: {
      expectedActiveRunId: null,
      expectedGoalRevision: null,
      occurredAt,
    },
  };
}

export function automationApplicationService(store: AutomationStore) {
  return new AutomationApplicationService({
    store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-09T00:00:00Z" },
    ids: new SequentialIds(),
    digester: { sha256 },
    routeResolver: {
      resolveRoute: async () => ({
        authorityId: "authority-1",
        runtimeGeneration: "generation-1",
        agentVersionId: "agent-version-1",
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
      }),
    },
  });
}

class SequentialIds implements AutomationApplicationIdGenerator {
  readonly #counts = new Map<string, number>();

  nextId(kind: Parameters<AutomationApplicationIdGenerator["nextId"]>[0]) {
    const count = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, count);
    return `${kind}-${count}`;
  }
}

function actor() {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  } as const;
}

export function automationCreateCommand() {
  return {
    kind: "automation.create" as const,
    idempotencyKey: "automation-create-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    title: "Daily summary",
    prompt: "Summarize the project.",
    requestedAgentVersionId: null,
    schedule: {
      scheduleType: "daily" as const,
      nextRunAt: "2026-08-10T10:00:00Z",
      intervalSeconds: 86_400,
      time: "18:00",
      weekday: 0,
      timezone: "Asia/Shanghai",
    },
  };
}

export function automationRunCommand() {
  return {
    kind: "automation.runNow" as const,
    idempotencyKey: "automation-run-1",
    automationId: "automation-1",
    expectedAutomationRevision: 1 as const,
    expectedThreadRevision: 1,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function applicationError(category: string, code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
