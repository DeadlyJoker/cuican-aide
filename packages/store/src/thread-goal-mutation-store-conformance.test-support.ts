import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test, type TestContext } from "node:test";

import {
  RunStoreError,
  type CommitThreadGoalMutationInput,
  type ModelHistoryStore,
  type OutboxMessage,
  type RunStore,
  type ThreadGoalMutationStore,
  type ThreadGoalEventStore,
  type ThreadGoalSnapshotStore,
  type ThreadGoalStore,
  type ThreadStore,
  type TurnStartStore,
} from "@crewon/application";
import {
  advanceRunGoalAccounting,
  threadGoalContinuationPrompt,
  type RunGoalBinding,
  type RunLifecycleEvent,
  type RunState,
  type ThreadGoal,
} from "@crewon/domain";

import {
  createDeleteThreadCommitFixture,
  seedThread,
} from "./thread-store-conformance.test-support.ts";
import { turnStartCommit } from "./turn-start-store-conformance.test-support.ts";

type GoalMutationConformanceStore = ThreadGoalMutationStore &
  ThreadGoalEventStore &
  ThreadGoalSnapshotStore &
  ThreadGoalStore &
  ThreadStore &
  ModelHistoryStore &
  TurnStartStore &
  RunStore;

/** Registers user Goal mutation behavior shared by every durable Store. */
export function registerThreadGoalMutationStoreConformance(
  name: string,
  createStore: () =>
    | GoalMutationConformanceStore
    | Promise<GoalMutationConformanceStore>,
): void {
  describe(name, () => {
    test("atomically hands off the Goal snapshot with its durable event cursor", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const locator = { tenantId: "tenant-1", threadId: "thread-1" };
      assert.deepEqual(await store.loadThreadGoalSnapshot(locator), {
        goal: null,
        eventSequence: 0,
      });

      const firstGoal = { ...goalFixture(), status: "paused" as const };
      await store.commitThreadGoalMutation(
        goalMutationInput({
          idempotencyKey: "goal-snapshot-set-1",
          goal: { kind: "set", expectedRevision: null, goal: firstGoal },
          expectedActiveRun: null,
        }),
      );
      assert.deepEqual(await store.loadThreadGoalSnapshot(locator), {
        goal: firstGoal,
        eventSequence: 1,
      });

      await store.commitThreadGoalMutation(
        goalMutationInput({
          idempotencyKey: "goal-snapshot-clear-1",
          goal: {
            kind: "clear",
            expectedRevision: 1,
            occurredAt: "2026-08-08T00:00:03Z",
          },
          expectedActiveRun: null,
        }),
      );
      assert.deepEqual(await store.loadThreadGoalSnapshot(locator), {
        goal: null,
        eventSequence: 2,
      });

      const recreatedGoal = {
        ...firstGoal,
        goalId: "goal-2",
        revision: 1,
        objective: "question-2",
        createdAt: "2026-08-08T00:00:04Z",
        updatedAt: "2026-08-08T00:00:04Z",
      };
      await store.commitThreadGoalMutation(
        goalMutationInput({
          idempotencyKey: "goal-snapshot-set-2",
          goal: {
            kind: "set",
            expectedRevision: null,
            goal: recreatedGoal,
          },
          expectedActiveRun: null,
        }),
      );
      assert.deepEqual(await store.loadThreadGoalSnapshot(locator), {
        goal: recreatedGoal,
        eventSequence: 3,
      });
      assert.deepEqual(
        await store.loadThreadGoalSnapshot({
          tenantId: "tenant-2",
          threadId: "thread-1",
        }),
        { goal: null, eventSequence: 0 },
      );
    });

    test("atomically clears an idle Goal when terminally tombstoning its Thread", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const goal = { ...goalFixture(), status: "paused" as const };
      await store.commitThreadGoalMutation(
        goalMutationInput({
          idempotencyKey: "goal-before-thread-delete",
          goal: { kind: "set", expectedRevision: null, goal },
          expectedActiveRun: null,
        }),
      );
      const input = createDeleteThreadCommitFixture(1, 2, goal.revision);

      const committed = await store.commitThread(input);

      assert.equal(committed.state.status, "deleted");
      assert.equal(await store.loadThreadGoal(threadLocator()), null);
      assert.deepEqual(await store.loadThreadGoalSnapshot(threadLocator()), {
        goal: null,
        eventSequence: 2,
      });
      assert.deepEqual(
        (await store.listThreadGoalEvents(threadLocator(), 0, 10)).map(
          (event) => ({ type: event.type, occurredAt: event.occurredAt }),
        ),
        [
          { type: "goal.updated", occurredAt: goal.updatedAt },
          { type: "goal.cleared", occurredAt: "2026-08-08T00:00:02Z" },
        ],
      );
      assert.deepEqual(await store.commitThread(input), {
        ...committed,
        disposition: "replayed",
      });
      assert.equal(
        (await store.listThreadGoalEvents(threadLocator(), 0, 10)).length,
        2,
      );
    });

    test("rejects a tombstone while a Goal activation Run and Work Item are queued", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const goal = goalFixture();
      await store.commitThreadGoalMutation(
        goalMutationInput({
          idempotencyKey: "active-goal-before-delete",
          goal: { kind: "set", expectedRevision: null, goal },
          expectedActiveRun: null,
          continuation: goalActivation(goal, 1),
        }),
      );

      await assert.rejects(
        store.commitThread(
          createDeleteThreadCommitFixture(1, 2, goal.revision),
        ),
        hasStoreCode("thread_active_run_conflict"),
      );

      assert.deepEqual(await store.loadThreadGoal(threadLocator()), goal);
      assert.deepEqual(
        (await store.listPendingWorkItems(10)).map((item) => [
          item.workItemId,
          item.payload.trigger,
        ]),
        [["work-goal-activation-1", "goalActivation"]],
      );
    });

    test("appends one Goal event per external set or clear and never duplicates replay", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const goal = goalFixture();
      const set = goalMutationInput({
        idempotencyKey: "goal-event-set",
        goal: { kind: "set", expectedRevision: null, goal },
        expectedActiveRun: null,
        continuation: goalActivation(goal, 1),
      });

      await store.commitThreadGoalMutation(set);
      await store.commitThreadGoalMutation(set);
      const firstPage = await store.listThreadGoalEvents(
        { tenantId: "tenant-1", threadId: "thread-1" },
        0,
        1,
      );
      assert.equal(firstPage.length, 1);
      assert.deepEqual(firstPage, [
        {
          schemaVersion: "crewon.thread-goal-event.v0",
          tenantId: "tenant-1",
          threadId: "thread-1",
          eventId: firstPage[0]?.eventId,
          sequence: 1,
          occurredAt: goal.updatedAt,
          type: "goal.updated",
          data: { goal },
        },
      ]);

      const clear = goalMutationInput({
        idempotencyKey: "goal-event-clear",
        goal: {
          kind: "clear",
          expectedRevision: goal.revision,
          occurredAt: "2026-08-08T00:00:05Z",
        },
        expectedActiveRun: {
          runId: "run-goal-activation-1",
          expectedRevision: 1,
        },
        cancellationRunId: "run-goal-activation-1",
        cancellationSequence: 2,
      });
      await store.commitThreadGoalMutation(clear);
      await store.commitThreadGoalMutation(clear);

      const secondPage = await store.listThreadGoalEvents(
        { tenantId: "tenant-1", threadId: "thread-1" },
        1,
        1,
      );
      assert.equal(secondPage.length, 1);
      assert.deepEqual(secondPage[0], {
        schemaVersion: "crewon.thread-goal-event.v0",
        tenantId: "tenant-1",
        threadId: "thread-1",
        eventId: secondPage[0]?.eventId,
        sequence: 2,
        occurredAt: "2026-08-08T00:00:05Z",
        type: "goal.cleared",
        data: { previousGoalId: goal.goalId, previousRevision: goal.revision },
      });
      assert.deepEqual(
        await store.listThreadGoalEvents(
          { tenantId: "tenant-1", threadId: "thread-1" },
          2,
          10,
        ),
        [],
      );
    });

    test("atomically replaces a leased queued Goal Run and replays the receipt", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const currentGoal = goalFixture();
      await store.commitThreadGoalMutation(
        goalMutationInput({
          idempotencyKey: "initial-goal-activation",
          goal: { kind: "set", expectedRevision: null, goal: currentGoal },
          expectedActiveRun: null,
          continuation: goalActivation(currentGoal, 1),
        }),
      );
      const claim = await store.claimNextWorkItem({
        ownerId: "worker-before-goal-edit",
        leaseId: "lease-before-goal-edit",
        leaseDurationMs: 60_000,
      });
      assert.ok(claim !== null);

      const nextGoal = {
        ...currentGoal,
        revision: 2,
        objective: "question-1 revised",
        updatedAt: "2026-08-08T00:00:03Z",
      };
      const input = goalMutationInput({
        goal: { kind: "set", expectedRevision: 1, goal: nextGoal },
        idempotencyKey: "replace-goal-activation",
        expectedActiveRun: {
          runId: "run-goal-activation-1",
          expectedRevision: 1,
        },
        cancellationRunId: "run-goal-activation-1",
        cancellationSequence: 2,
        continuation: goalActivation(nextGoal, 2),
      });
      const committed = await store.commitThreadGoalMutation(input);

      assert.equal(committed.disposition, "committed");
      assert.equal(committed.canceledRunState?.status, "canceled");
      assert.equal(committed.continuation?.runState.status, "queued");
      assert.deepEqual(
        await store.loadThreadGoal({
          tenantId: "tenant-1",
          threadId: "thread-1",
        }),
        nextGoal,
      );
      assert.equal(
        (
          await store.loadRun({
            tenantId: "tenant-1",
            runId: "run-goal-activation-1",
          })
        )?.status,
        "canceled",
      );
      assert.deepEqual(
        (await store.listPendingWorkItems(10)).map((item) => item.workItemId),
        ["work-goal-activation-2"],
      );
      await assert.rejects(
        store.completeWorkItem({
          workItemId: claim.workItem.workItemId,
          ownerId: claim.lease.ownerId,
          leaseId: claim.lease.leaseId,
          leaseEpoch: claim.lease.epoch,
        }),
        hasStoreCode("queue_item_already_settled"),
      );
      assert.deepEqual(await store.commitThreadGoalMutation(input), {
        ...committed,
        disposition: "replayed",
      });
    });

    test("never replaces a queued user Turn with a Goal continuation prompt", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const currentGoal = goalFixture();
      await store.commitTurnStart(
        turnStartCommit({
          goal: { kind: "set", expectedRevision: null, goal: currentGoal },
          goalBinding: binding(currentGoal),
        }),
      );
      const nextGoal = {
        ...currentGoal,
        revision: 2,
        objective: "question-1 revised",
        updatedAt: "2026-08-08T00:00:03Z",
      };
      const currentRun = await store.loadRun({
        tenantId: "tenant-1",
        runId: "run-turn-1",
      });
      assert.ok(currentRun !== null);

      const committed = await store.commitThreadGoalMutation(
        goalMutationInput({
          idempotencyKey: "retain-user-turn",
          goal: { kind: "set", expectedRevision: 1, goal: nextGoal },
          expectedActiveRun: { runId: "run-turn-1", expectedRevision: 1 },
          retainedRunUpdate: retainedRunUpdate(
            currentRun,
            nextGoal,
            "objectiveUpdated",
            "2026-08-08T00:00:03Z",
          ),
        }),
      );

      assert.equal(committed.canceledRunState, null);
      assert.equal(committed.continuation, null);
      assert.equal(
        (
          await store.loadRun({
            tenantId: "tenant-1",
            runId: "run-turn-1",
          })
        )?.status,
        "queued",
      );
      assert.deepEqual(
        (await store.listPendingWorkItems(10)).map((item) => item.workItemId),
        ["work-run-turn-1"],
      );
    });

    test("creates an idle active Goal Run without fabricating a previous Run", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const goal = goalFixture();
      const input = goalMutationInput({
        goal: { kind: "set", expectedRevision: null, goal },
        expectedActiveRun: null,
        continuation: goalActivation(goal, 1),
      });

      const committed = await store.commitThreadGoalMutation(input);

      assert.equal(committed.canceledRunState, null);
      assert.equal(
        committed.continuation?.workItems[0]?.payload.trigger,
        "goalActivation",
      );
      assert.deepEqual(
        await store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        input.continuation?.history.items,
      );
    });

    test("retains a running Run while revising its Goal authority", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const currentGoal = goalFixture();
      await store.commitTurnStart(
        turnStartCommit({
          goal: { kind: "set", expectedRevision: null, goal: currentGoal },
          goalBinding: binding(currentGoal),
        }),
      );
      await store.commitRun({
        tenantId: "tenant-1",
        idempotency: idempotency("start-running"),
        expectedRevision: 1,
        events: [
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: "run-turn-1" },
            eventId: "event-start-running",
            sequence: 2,
            occurredAt: "2026-08-08T00:00:03Z",
            type: "run.started",
            data: {},
          },
        ],
        outbox: [],
        workItems: [],
      });
      const nextGoal = {
        ...currentGoal,
        revision: 2,
        status: "paused" as const,
        timeUsedSeconds: 1,
        updatedAt: "2026-08-08T00:00:04Z",
      };
      const currentRun = await store.loadRun({
        tenantId: "tenant-1",
        runId: "run-turn-1",
      });
      assert.ok(currentRun !== null);

      const committed = await store.commitThreadGoalMutation(
        goalMutationInput({
          goal: { kind: "set", expectedRevision: 1, goal: nextGoal },
          expectedActiveRun: { runId: "run-turn-1", expectedRevision: 2 },
          retainedRunUpdate: retainedRunUpdate(
            currentRun,
            nextGoal,
            null,
            "2026-08-08T00:00:04Z",
          ),
        }),
      );

      assert.equal(committed.canceledRunState, null);
      assert.equal(committed.continuation, null);
      assert.equal(committed.retainedRun?.runState.status, "running");
      assert.equal(
        (
          await store.loadRun({
            tenantId: "tenant-1",
            runId: "run-turn-1",
          })
        )?.status,
        "running",
      );
      assert.deepEqual(committed.goalState, nextGoal);
    });

    test("rejects a stale active-Run fence without partial Goal or queue writes", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const currentGoal = goalFixture();
      await store.commitTurnStart(
        turnStartCommit({
          goal: { kind: "set", expectedRevision: null, goal: currentGoal },
          goalBinding: binding(currentGoal),
        }),
      );
      const nextGoal = {
        ...currentGoal,
        revision: 2,
        objective: "stale edit",
        updatedAt: "2026-08-08T00:00:03Z",
      };

      await assert.rejects(
        store.commitThreadGoalMutation(
          goalMutationInput({
            goal: { kind: "set", expectedRevision: 1, goal: nextGoal },
            expectedActiveRun: {
              runId: "run-turn-1",
              expectedRevision: 99,
            },
            cancellationRunId: "run-turn-1",
            cancellationSequence: 2,
            continuation: goalActivation(nextGoal, 2),
          }),
        ),
        hasStoreCode("goal_active_run_conflict"),
      );
      assert.deepEqual(
        await store.loadThreadGoal({
          tenantId: "tenant-1",
          threadId: "thread-1",
        }),
        currentGoal,
      );
      assert.equal(
        (
          await store.loadRun({
            tenantId: "tenant-1",
            runId: "run-turn-1",
          })
        )?.status,
        "queued",
      );
      assert.deepEqual(
        (await store.listPendingWorkItems(10)).map((item) => item.workItemId),
        ["work-run-turn-1"],
      );
    });
  });
}

function retainedRunUpdate(
  run: RunState,
  nextGoal: ThreadGoal | null,
  steeringKind: "objectiveUpdated" | "budgetLimited" | null,
  occurredAt: string,
): NonNullable<CommitThreadGoalMutationInput["retainedRunUpdate"]> {
  const nextBinding =
    nextGoal?.status === "active" || nextGoal?.status === "budgetLimited"
      ? binding(nextGoal)
      : null;
  const next = advanceRunGoalAccounting(run.goalAccounting, {
    currentUsage: run.usage,
    throughRunSequence: run.lastSequence,
    occurredAt,
    nextBinding,
    pendingSteering:
      steeringKind === null || nextBinding === null
        ? null
        : {
            handoffId: `handoff-${run.runId}-${nextBinding.revision}`,
            kind: steeringKind,
            target: nextBinding,
            createdAt: occurredAt,
          },
    trackTime: nextBinding !== null && run.status !== "queued",
  }).next;
  const event: Extract<
    RunLifecycleEvent,
    { type: "run.goal.accounting.updated" }
  > = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: run.runId },
    eventId: `event-goal-accounting-${run.runId}-${next.revision}`,
    sequence: run.lastSequence + 1,
    occurredAt,
    type: "run.goal.accounting.updated",
    data: { next },
  };
  return { events: [event], outbox: [outboxFor(event)] };
}

export function goalMutationInput(overrides: {
  idempotencyKey?: string;
  goal: CommitThreadGoalMutationInput["goal"];
  expectedActiveRun: CommitThreadGoalMutationInput["expectedActiveRun"];
  cancellationRunId?: string;
  cancellationSequence?: number;
  continuation?: CommitThreadGoalMutationInput["continuation"];
  retainedRunUpdate?: CommitThreadGoalMutationInput["retainedRunUpdate"];
}): CommitThreadGoalMutationInput {
  const cancellation =
    overrides.cancellationRunId === undefined
      ? null
      : queuedCancellation(
          overrides.cancellationRunId,
          overrides.cancellationSequence ?? 2,
        );
  return {
    tenantId: "tenant-1",
    threadId: "thread-1",
    idempotency: idempotency(overrides.idempotencyKey ?? "goal-mutation"),
    goal: overrides.goal,
    expectedActiveRun: overrides.expectedActiveRun,
    queuedRunCancellation: cancellation,
    retainedRunUpdate: overrides.retainedRunUpdate ?? null,
    continuation: overrides.continuation ?? null,
  };
}

function threadLocator() {
  return { tenantId: "tenant-1", threadId: "thread-1" } as const;
}

function queuedCancellation(
  runId: string,
  firstSequence: number,
): NonNullable<CommitThreadGoalMutationInput["queuedRunCancellation"]> {
  const occurredAt = "2026-08-08T00:00:04Z";
  const events: readonly RunLifecycleEvent[] = [
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId },
      eventId: `event-goal-cancel-request-${runId}`,
      sequence: firstSequence,
      occurredAt,
      type: "run.cancel.requested",
      data: { actorId: "actor-1" },
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId },
      eventId: `event-goal-canceled-${runId}`,
      sequence: firstSequence + 1,
      occurredAt,
      type: "run.canceled",
      data: { reasonCode: "goal_mutated" },
    },
  ];
  return { events, outbox: events.map(outboxFor) };
}

export function goalActivation(
  goal: ThreadGoal,
  historySequence: number,
): NonNullable<CommitThreadGoalMutationInput["continuation"]> {
  const occurredAt = "2026-08-08T00:00:04Z";
  const runId = `run-goal-activation-${goal.revision}`;
  const event: Extract<RunLifecycleEvent, { type: "run.created" }> = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId },
    eventId: `event-goal-activation-${goal.revision}`,
    sequence: 1,
    occurredAt,
    type: "run.created",
    data: {
      threadId: goal.threadId,
      tenantId: goal.tenantId,
      spaceId: "space-1",
      createdByActorId: "actor-1",
      authorityId: "authority-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
      collaborationMode: "default",
      goalBinding: binding(goal),
    },
  };
  const prompt = threadGoalContinuationPrompt(goal);
  return {
    history: {
      expectedLastSequence: historySequence - 1,
      items: [
        {
          schemaVersion: "crewon.model-history-item.v0",
          itemId: `history-goal-activation-${goal.revision}`,
          tenantId: goal.tenantId,
          threadId: goal.threadId,
          sequence: historySequence,
          runId,
          segmentId: null,
          createdAt: occurredAt,
          type: "message",
          role: "user",
          source: "goal_continuation",
          content: prompt,
          contentDigest: digest(prompt),
        },
      ],
    },
    events: [event],
    outbox: [outboxFor(event)],
    workItems: [
      {
        workItemId: `work-goal-activation-${goal.revision}`,
        tenantId: goal.tenantId,
        runId,
        kind: "run.execute",
        payload: {
          throughSequence: 1,
          trigger: "goalActivation",
          goalId: goal.goalId,
          goalRevision: goal.revision,
        },
        createdAt: occurredAt,
      },
    ],
  };
}

function outboxFor(event: RunLifecycleEvent): OutboxMessage {
  return {
    messageId: `outbox-${event.eventId}`,
    tenantId: "tenant-1",
    runId: event.identity.runId,
    topic: "run.updated",
    payload: {
      eventId: event.eventId,
      eventType: event.type,
      throughSequence: event.sequence,
    },
    createdAt: event.occurredAt,
  };
}

export function goalFixture(): ThreadGoal {
  return {
    schemaVersion: "crewon.thread-goal.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    goalId: "goal-1",
    revision: 1,
    objective: "question-1",
    status: "active",
    tokenBudget: 200_000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-08-08T00:00:02Z",
    updatedAt: "2026-08-08T00:00:02Z",
  };
}

function binding(goal: ThreadGoal): RunGoalBinding {
  return {
    goalId: goal.goalId,
    revision: goal.revision,
    objectiveDigest: digest(goal.objective),
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function idempotency(key: string) {
  return {
    scope: "thread-goal-mutation",
    key,
    requestFingerprint: `fingerprint-${key}`,
  };
}

async function managedStore(
  context: TestContext,
  createStore: () =>
    | GoalMutationConformanceStore
    | Promise<GoalMutationConformanceStore>,
): Promise<GoalMutationConformanceStore> {
  const store = await createStore();
  context.after(() => store.close());
  return store;
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
