import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test, type TestContext } from "node:test";

import {
  RunStoreError,
  type CommitTurnStartInput,
  type ModelHistoryStore,
  type RunStore,
  type ThreadStore,
  type ThreadGoalEventStore,
  type ThreadGoalStore,
  type TurnStartStore,
} from "@crewon/application";
import type {
  RunCollaborationMode,
  RunGoalBinding,
  ThreadGoal,
} from "@crewon/domain";

import {
  createDeleteThreadCommitFixture,
  seedThread,
} from "./thread-store-conformance.test-support.ts";

const CONTENT_DIGEST = `sha256:${"a".repeat(64)}`;
type TurnStartConformanceStore = TurnStartStore &
  ThreadStore &
  ThreadGoalStore &
  ThreadGoalEventStore &
  ModelHistoryStore &
  RunStore;

/** Registers atomic user Message + Run admission behavior for every Store. */
export function registerTurnStartStoreConformance(
  name: string,
  createStore: () =>
    | TurnStartConformanceStore
    | Promise<TurnStartConformanceStore>,
): void {
  describe(name, () => {
    test("atomically commits and replays one user Message with its Run", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const input = turnStartCommit();

      const committed = await store.commitTurnStart(input);

      assert.equal(committed.disposition, "committed");
      assert.equal(committed.threadState.revision, 2);
      assert.equal(committed.threadState.lastMessageSequence, 1);
      assert.equal(committed.runState.status, "queued");
      assert.equal(committed.goalState, null);
      assert.deepEqual(
        await store.loadThread({ tenantId: "tenant-1", threadId: "thread-1" }),
        committed.threadState,
      );
      assert.deepEqual(
        await store.loadRun({ tenantId: "tenant-1", runId: "run-turn-1" }),
        committed.runState,
      );
      assert.deepEqual(
        await store.listMessages(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        input.thread.messages,
      );
      assert.deepEqual(
        await store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        input.thread.history.items,
      );
      assert.deepEqual(
        await store.listRunEvents(
          { tenantId: "tenant-1", runId: "run-turn-1" },
          0,
          10,
        ),
        input.run.events,
      );
      assert.deepEqual(await store.listPendingOutbox(10), input.run.outbox);
      assert.deepEqual(
        await store.listPendingWorkItems(10),
        input.run.workItems,
      );
      assert.deepEqual(await store.commitTurnStart(input), {
        ...committed,
        disposition: "replayed",
      });
      assert.deepEqual(
        await store.loadTurnStartReceipt({
          tenantId: input.tenantId,
          threadId: "thread-1",
          idempotency: input.idempotency,
        }),
        { ...committed, disposition: "replayed" },
      );
      await assert.rejects(
        store.loadTurnStartReceipt({
          tenantId: input.tenantId,
          threadId: "thread-1",
          idempotency: {
            ...input.idempotency,
            requestFingerprint: "different-fingerprint",
          },
        }),
        hasStoreCode("idempotency_conflict"),
      );
    });

    test("rejects a parallel active Run without appending another Message", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      await store.commitTurnStart(turnStartCommit());
      const parallel = turnStartCommit({
        key: "turn-start-2",
        fingerprint: "fingerprint-2",
        runId: "run-turn-2",
        expectedThreadRevision: 2,
        threadEventSequence: 3,
        messageSequence: 2,
        historySequence: 2,
        occurredAt: "2026-08-08T00:00:03Z",
      });

      await assert.rejects(
        store.commitTurnStart(parallel),
        hasStoreCode("thread_active_run_conflict"),
      );

      assert.equal(
        (
          await store.loadThread({
            tenantId: "tenant-1",
            threadId: "thread-1",
          })
        )?.revision,
        2,
      );
      assert.equal(
        (
          await store.listMessages(
            { tenantId: "tenant-1", threadId: "thread-1" },
            0,
            10,
          )
        ).length,
        1,
      );
      assert.equal(
        await store.loadRun({ tenantId: "tenant-1", runId: "run-turn-2" }),
        null,
      );
    });

    test("rejects a Thread tombstone while a queued Run and Work Item remain active", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      await store.commitTurnStart(turnStartCommit());
      const tombstone = createDeleteThreadCommitFixture(2, 3);

      await assert.rejects(
        store.commitThread(tombstone),
        hasStoreCode("thread_active_run_conflict"),
      );

      assert.equal(
        (
          await store.loadThread({
            tenantId: "tenant-1",
            threadId: "thread-1",
          })
        )?.status,
        "active",
      );
      assert.deepEqual(
        (await store.listPendingWorkItems(10)).map((item) => item.workItemId),
        ["work-run-turn-1"],
      );
    });

    test("atomically creates a persistent Goal and pins its exact Run binding", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const goal = goalFixture();
      const input = turnStartCommit({
        goal: { kind: "set", expectedRevision: null, goal },
        goalBinding: binding(goal),
      });

      const committed = await store.commitTurnStart(input);

      assert.deepEqual(committed.goalState, goal);
      assert.deepEqual(committed.runState.goalBinding, binding(goal));
      assert.equal(committed.runState.collaborationMode, "default");
      assert.deepEqual(
        await store.loadThreadGoal({
          tenantId: "tenant-1",
          threadId: "thread-1",
        }),
        goal,
      );
      assert.deepEqual(await store.commitTurnStart(input), {
        ...committed,
        disposition: "replayed",
      });
      assert.deepEqual(
        (
          await store.listThreadGoalEvents(
            { tenantId: "tenant-1", threadId: "thread-1" },
            0,
            10,
          )
        ).map((event) => [event.sequence, event.type]),
        [[1, "goal.updated"]],
      );
    });

    test("atomically clears the Goal when admitting a Plan Run", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const goal = goalFixture();
      await store.commitTurnStart(
        turnStartCommit({
          goal: { kind: "set", expectedRevision: null, goal },
          goalBinding: binding(goal),
        }),
      );
      await store.commitRun({
        tenantId: "tenant-1",
        idempotency: {
          scope: "turn-start-terminal",
          key: "turn-start-terminal-1",
          requestFingerprint: "turn-start-terminal-fingerprint-1",
        },
        expectedRevision: 1,
        events: [
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: "run-turn-1" },
            eventId: "run-turn-terminal-event-1",
            sequence: 2,
            occurredAt: "2026-08-08T00:00:03Z",
            type: "run.failed",
            data: { code: "test_terminal", retryable: false },
          },
        ],
        outbox: [],
        workItems: [],
      });

      const committed = await store.commitTurnStart(
        turnStartCommit({
          key: "turn-start-plan-1",
          fingerprint: "turn-start-plan-fingerprint-1",
          runId: "run-turn-plan-1",
          expectedThreadRevision: 2,
          threadEventSequence: 3,
          messageSequence: 2,
          historySequence: 2,
          occurredAt: "2026-08-08T00:00:04Z",
          goal: {
            kind: "clear",
            expectedRevision: 1,
            occurredAt: "2026-08-08T00:00:02Z",
          },
          collaborationMode: "plan",
          goalBinding: null,
        }),
      );

      assert.equal(committed.goalState, null);
      assert.equal(committed.runState.collaborationMode, "plan");
      assert.equal(committed.runState.goalBinding, null);
      assert.equal(
        await store.loadThreadGoal({
          tenantId: "tenant-1",
          threadId: "thread-1",
        }),
        null,
      );
      assert.deepEqual(
        (
          await store.listThreadGoalEvents(
            { tenantId: "tenant-1", threadId: "thread-1" },
            0,
            10,
          )
        ).map((event) => [event.sequence, event.type]),
        [
          [1, "goal.updated"],
          [2, "goal.cleared"],
        ],
      );
    });

    test("serializes concurrent Turn starts to one durable winner", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const first = turnStartCommit();
      const second = turnStartCommit({
        key: "turn-start-racing-2",
        fingerprint: "fingerprint-racing-2",
        runId: "run-turn-racing-2",
      });

      const outcomes = await Promise.allSettled([
        store.commitTurnStart(first),
        store.commitTurnStart(second),
      ]);

      assert.equal(
        outcomes.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const rejected = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      assert.ok(rejected !== undefined);
      assert.ok(
        rejected.reason instanceof RunStoreError &&
          (rejected.reason.code === "revision_conflict" ||
            rejected.reason.code === "thread_active_run_conflict"),
      );
      assert.equal(
        (
          await store.listMessages(
            { tenantId: "tenant-1", threadId: "thread-1" },
            0,
            10,
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await store.listThreadRuns({
            tenantId: "tenant-1",
            spaceId: "space-1",
            threadId: "thread-1",
            before: null,
            limit: 10,
          })
        ).length,
        1,
      );
    });

    test("rolls back every authority when queue handoff is invalid", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const goal = goalFixture();
      const input = turnStartCommit({
        goal: { kind: "set", expectedRevision: null, goal },
        goalBinding: binding(goal),
      });
      const invalid: CommitTurnStartInput = {
        ...input,
        run: {
          ...input.run,
          workItems: [{ ...input.run.workItems[0]!, runId: "different-run" }],
        },
      };

      await assert.rejects(
        store.commitTurnStart(invalid),
        hasStoreCode("work_item_run_id_mismatch"),
      );

      assert.equal(
        (
          await store.loadThread({
            tenantId: "tenant-1",
            threadId: "thread-1",
          })
        )?.revision,
        1,
      );
      assert.deepEqual(
        await store.listMessages(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        [],
      );
      assert.equal(
        await store.loadRun({ tenantId: "tenant-1", runId: "run-turn-1" }),
        null,
      );
      assert.deepEqual(await store.listPendingOutbox(10), []);
      assert.deepEqual(await store.listPendingWorkItems(10), []);
      assert.equal(
        await store.loadThreadGoal({
          tenantId: "tenant-1",
          threadId: "thread-1",
        }),
        null,
      );
    });
  });
}

export function turnStartCommit(
  overrides: Readonly<{
    key?: string;
    fingerprint?: string;
    runId?: string;
    expectedThreadRevision?: number;
    threadEventSequence?: number;
    messageSequence?: number;
    historySequence?: number;
    occurredAt?: string;
    goal?: CommitTurnStartInput["goal"];
    collaborationMode?: RunCollaborationMode;
    goalBinding?: RunGoalBinding | null;
  }> = {},
): CommitTurnStartInput {
  const key = overrides.key ?? "turn-start-1";
  const runId = overrides.runId ?? "run-turn-1";
  const expectedThreadRevision = overrides.expectedThreadRevision ?? 1;
  const threadEventSequence = overrides.threadEventSequence ?? 2;
  const messageSequence = overrides.messageSequence ?? 1;
  const historySequence = overrides.historySequence ?? 1;
  const occurredAt = overrides.occurredAt ?? "2026-08-08T00:00:02Z";
  const messageId = `message-${messageSequence}`;
  const runEventId = `run-event-${runId}`;
  return {
    tenantId: "tenant-1",
    idempotency: {
      scope: "turn-start-scope",
      key,
      requestFingerprint: overrides.fingerprint ?? "fingerprint-1",
    },
    goal: overrides.goal ?? { kind: "keep", expectedRevision: null },
    thread: {
      expectedRevision: expectedThreadRevision,
      events: [
        {
          schemaVersion: "crewon.thread-event.v0",
          identity: { threadId: "thread-1" },
          eventId: `thread-event-${threadEventSequence}`,
          sequence: threadEventSequence,
          occurredAt,
          type: "thread.message.appended",
          data: {
            messageId,
            messageSequence,
            role: "user",
            contentDigest: CONTENT_DIGEST,
          },
        },
      ],
      messages: [
        {
          messageId,
          tenantId: "tenant-1",
          threadId: "thread-1",
          sequence: messageSequence,
          role: "user",
          content: `question-${messageSequence}`,
          contentDigest: CONTENT_DIGEST,
          createdAt: occurredAt,
          origin: null,
        },
      ],
      history: {
        expectedLastSequence: historySequence - 1,
        items: [
          {
            schemaVersion: "crewon.model-history-item.v0",
            itemId: `history-${historySequence}`,
            tenantId: "tenant-1",
            threadId: "thread-1",
            sequence: historySequence,
            runId: null,
            segmentId: null,
            createdAt: occurredAt,
            type: "message",
            role: "user",
            source: "thread_message",
            content: `question-${messageSequence}`,
            contentDigest: CONTENT_DIGEST,
          },
        ],
      },
    },
    run: {
      expectedRevision: 0,
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId },
          eventId: runEventId,
          sequence: 1,
          occurredAt,
          type: "run.created",
          data: {
            threadId: "thread-1",
            tenantId: "tenant-1",
            spaceId: "space-1",
            createdByActorId: "actor-1",
            authorityId: "authority-1",
            runtimeGeneration: "ts-v0",
            agentVersionId: "agent-version-1",
            policySnapshotId: "policy-1",
            workspaceBindingId: "workspace-1",
            collaborationMode: overrides.collaborationMode ?? "default",
            goalBinding: overrides.goalBinding ?? null,
          },
        },
      ],
      outbox: [
        {
          messageId: `outbox-${runId}`,
          tenantId: "tenant-1",
          runId,
          topic: "run.updated",
          payload: {
            eventId: runEventId,
            eventType: "run.created",
            throughSequence: 1,
          },
          createdAt: occurredAt,
        },
      ],
      workItems: [
        {
          workItemId: `work-${runId}`,
          tenantId: "tenant-1",
          runId,
          kind: "run.execute",
          payload: { throughSequence: 1 },
          createdAt: occurredAt,
        },
      ],
    },
  };
}

function goalFixture(): ThreadGoal {
  return {
    schemaVersion: "crewon.thread-goal.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    goalId: "goal-1",
    revision: 1,
    objective: "question-1",
    status: "active",
    tokenBudget: null,
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
    objectiveDigest: `sha256:${createHash("sha256")
      .update(goal.objective)
      .digest("hex")}`,
  };
}

async function managedStore(
  context: TestContext,
  createStore: () =>
    | TurnStartConformanceStore
    | Promise<TurnStartConformanceStore>,
): Promise<TurnStartConformanceStore> {
  const store = await createStore();
  context.after(() => store.close());
  return store;
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
