import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";

import {
  createThreadRollbackArtifacts,
  type ModelHistoryItem,
  type RunLifecycleEvent,
  type ThreadLifecycleEvent,
} from "@crewon/domain";
import {
  RunStoreError,
  type CommitThreadInput,
  type CommitThreadRollbackInput,
  type CommitTextRunCompletionInput,
  type DomainStore,
  type MessageRecord,
} from "@crewon/application";

import type { LeaseClock } from "./lease-clock.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";
import {
  prepareTextCompletion,
  textRunCompletionInput,
} from "./run-execution-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";

/** Registers the append-only rollback contract shared by every durable adapter. */
export function registerThreadRollbackStoreConformance(
  name: string,
  createStore: (clock: LeaseClock) => DomainStore | Promise<DomainStore>,
): void {
  describe(name, () => {
    test("atomically tombstones a turn, replays first, and filters before LIMIT", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const seeded = messageCommit();
      await store.commitThread(seeded);
      const rollback = rollbackInput(seeded, 1);

      const committed = await store.commitThreadRollback(rollback);

      assert.deepEqual(
        committed.invalidatedMessages.map(
          ({ messageSequence }) => messageSequence,
        ),
        [3, 4],
      );
      assert.equal(committed.state.lastMessageSequence, 4);
      assert.equal(committed.state.revision, 6);
      assert.deepEqual(await store.listModelHistoryItems(locator(), 0, 100), [
        ...seeded.history.items,
        rollback.marker,
      ]);

      await store.commitThread(replacementCommit());
      assert.deepEqual(
        (await store.listMessages(locator(), 2, 1)).map(
          ({ sequence }) => sequence,
        ),
        [5],
      );
      const audit = await store.listMessages(locator(), 2, 3, "audit");
      assert.deepEqual(
        audit.map(({ sequence, invalidation }) => ({
          sequence,
          invalidation: invalidation?.rollbackId ?? null,
        })),
        [
          { sequence: 3, invalidation: rollback.marker.rollbackId },
          { sequence: 4, invalidation: rollback.marker.rollbackId },
          { sequence: 5, invalidation: null },
        ],
      );

      assert.deepEqual(await store.commitThreadRollback(rollback), {
        ...committed,
        disposition: "replayed",
      });
      assert.deepEqual(
        await store.loadThreadRollbackReceipt({
          tenantId: rollback.tenantId,
          threadId: rollback.event.identity.threadId,
          idempotency: rollback.idempotency,
        }),
        { ...committed, disposition: "replayed" },
      );
    });

    test("fences both an active Run and terminal Run with unsettled Work", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      await store.commitRun(createRunningCommitFixture());
      const rollback = emptyRollbackInput();

      await assert.rejects(
        store.commitThreadRollback(rollback),
        hasStoreCode("thread_active_run_conflict"),
      );

      const completed: RunLifecycleEvent = {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: "run-store-1" },
        eventId: "event-rollback-fence-completed",
        sequence: 3,
        occurredAt: "2026-08-08T00:00:03Z",
        type: "run.completed",
        data: { outputRef: "artifact-rollback-fence" },
      };
      await store.commitRun({
        tenantId: "tenant-1",
        idempotency: idempotency("terminal-with-work"),
        expectedRevision: 2,
        events: [completed],
        outbox: [],
        workItems: [],
      });
      await assert.rejects(
        store.commitThreadRollback(rollback),
        hasStoreCode("thread_active_work_conflict"),
      );
    });

    test("atomically invalidates provider continuation and model state", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const user = providerUserCommit();
      await store.commitThread(user);
      await store.commitRun(createRunningCommitFixture());
      const claim = await store.claimNextWorkItem({
        ownerId: "rollback-provider-worker",
        leaseId: "rollback-provider-lease",
        leaseDurationMs: 1_000,
      });
      assert.ok(claim !== null);
      await prepareTextCompletion(store, claim);
      const base = textRunCompletionInput(claim);
      const assistant = { ...base.thread.messages[0]!, sequence: 2 };
      const baseThreadEvent = base.thread.events[0]!;
      assert.equal(baseThreadEvent.type, "thread.message.appended");
      if (baseThreadEvent.type !== "thread.message.appended") {
        throw new Error("rollback_provider_fixture_invalid");
      }
      const completion: CommitTextRunCompletionInput = {
        ...base,
        run: {
          ...base.run,
          events: base.run.events.map((event) =>
            event.type === "message.completed"
              ? {
                  ...event,
                  data: { ...event.data, messageSequence: 2 },
                }
              : event,
          ),
        },
        thread: {
          expectedRevision: 2,
          events: [
            {
              ...baseThreadEvent,
              sequence: 3,
              data: {
                ...baseThreadEvent.data,
                messageSequence: 2,
              },
            },
          ],
          messages: [assistant],
        },
        history: {
          expectedLastSequence: 1,
          items: [{ ...base.history.items[0]!, sequence: 2 }],
        },
        modelState: { ...base.modelState, throughHistorySequence: 2 },
      };
      await store.commitTextRunCompletion(completion);
      const history = await store.listModelHistoryItems(locator(), 0, 100);
      const artifacts = createThreadRollbackArtifacts(history, {
        tenantId: "tenant-1",
        threadId: "thread-1",
        actorId: "actor-1",
        rollbackId: "rollback-provider-state",
        markerItemId: "rollback-provider-marker",
        threadEventId: "rollback-provider-event",
        threadEventSequence: 4,
        occurredAt: "2026-08-08T00:01:03Z",
        requestedTurns: 1,
      });

      const result = await store.commitThreadRollback({
        tenantId: "tenant-1",
        idempotency: idempotency("rollback-provider-state"),
        expectedThreadRevision: 3,
        expectedHistorySequence: 2,
        event: artifacts.event,
        marker: artifacts.marker,
      });

      assert.equal(result.invalidatedContinuationCount, 1);
      assert.equal(result.invalidatedModelState, true);
      assert.equal(
        await store.loadThreadContinuation({
          tenantId: "tenant-1",
          threadId: "thread-1",
          agentVersionId: "text-agent-version",
          adapterName: "text-adapter",
          adapterVersion: "1",
          modelId: "text-model",
        }),
        null,
      );
      assert.equal(await store.loadThreadModelState(locator()), null);
    });
  });
}

export async function commitThreadRollbackFixture(store: DomainStore) {
  await seedThread(store);
  const seeded = messageCommit();
  await store.commitThread(seeded);
  const input = rollbackInput(seeded, 1);
  const result = await store.commitThreadRollback(input);
  return { input, result };
}

function messageCommit(): CommitThreadInput {
  const roles = ["user", "assistant", "user", "assistant"] as const;
  const messages: MessageRecord[] = roles.map((role, index) => {
    const sequence = index + 1;
    return {
      messageId: `rollback-message-${sequence}`,
      tenantId: "tenant-1",
      threadId: "thread-1",
      sequence,
      role,
      content: `rollback content ${sequence}`,
      contentDigest: digest(sequence),
      createdAt: timestamp(sequence),
      origin: null,
      proposedPlan: null,
    };
  });
  const events: ThreadLifecycleEvent[] = messages.map((message) => ({
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: message.threadId },
    eventId: `rollback-thread-event-${message.sequence + 1}`,
    sequence: message.sequence + 1,
    occurredAt: message.createdAt,
    type: "thread.message.appended",
    data: {
      messageId: message.messageId,
      messageSequence: message.sequence,
      role: message.role,
      contentDigest: message.contentDigest,
    },
  }));
  const history: ModelHistoryItem[] = messages.map((message) => ({
    schemaVersion: "crewon.model-history-item.v0",
    itemId: `rollback-history-${message.sequence}`,
    tenantId: message.tenantId,
    threadId: message.threadId,
    sequence: message.sequence,
    runId: message.role === "assistant" ? "rollback-run" : null,
    segmentId: message.role === "assistant" ? "rollback-segment" : null,
    createdAt: message.createdAt,
    type: "message",
    role: message.role,
    source:
      message.role === "assistant" ? "assistant_completion" : "thread_message",
    content: message.content,
    contentDigest: message.contentDigest,
  }));
  return {
    tenantId: "tenant-1",
    idempotency: idempotency("seed-messages"),
    expectedRevision: 1,
    events,
    messages,
    history: { expectedLastSequence: 0, items: history },
  };
}

function rollbackInput(
  seeded: CommitThreadInput,
  requestedTurns: number,
): CommitThreadRollbackInput {
  const artifacts = createThreadRollbackArtifacts(seeded.history.items, {
    tenantId: "tenant-1",
    threadId: "thread-1",
    actorId: "actor-1",
    rollbackId: "rollback-1",
    markerItemId: "rollback-marker-1",
    threadEventId: "rollback-event-1",
    threadEventSequence: 6,
    occurredAt: "2026-08-08T00:00:05Z",
    requestedTurns,
  });
  return {
    tenantId: "tenant-1",
    idempotency: idempotency("rollback-1"),
    expectedThreadRevision: 5,
    expectedHistorySequence: 4,
    event: artifacts.event,
    marker: artifacts.marker,
  };
}

function replacementCommit(): CommitThreadInput {
  const message: MessageRecord = {
    messageId: "rollback-message-5",
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence: 5,
    role: "user",
    content: "replacement content",
    contentDigest: digest(5),
    createdAt: timestamp(6),
    origin: null,
    proposedPlan: null,
  };
  return {
    tenantId: "tenant-1",
    idempotency: idempotency("replacement"),
    expectedRevision: 6,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread-1" },
        eventId: "rollback-thread-event-7",
        sequence: 7,
        occurredAt: message.createdAt,
        type: "thread.message.appended",
        data: {
          messageId: message.messageId,
          messageSequence: message.sequence,
          role: message.role,
          contentDigest: message.contentDigest,
        },
      },
    ],
    messages: [message],
    history: {
      expectedLastSequence: 5,
      items: [
        {
          schemaVersion: "crewon.model-history-item.v0",
          itemId: "rollback-history-6",
          tenantId: "tenant-1",
          threadId: "thread-1",
          sequence: 6,
          runId: null,
          segmentId: null,
          createdAt: message.createdAt,
          type: "message",
          role: "user",
          source: "thread_message",
          content: message.content,
          contentDigest: message.contentDigest,
        },
      ],
    },
  };
}

function providerUserCommit(): CommitThreadInput {
  const message: MessageRecord = {
    messageId: "rollback-provider-user",
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence: 1,
    role: "user",
    content: "provider state user turn",
    contentDigest: digest(6),
    createdAt: "2026-08-08T00:00:01Z",
    origin: null,
    proposedPlan: null,
  };
  return {
    tenantId: "tenant-1",
    idempotency: idempotency("provider-user"),
    expectedRevision: 1,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread-1" },
        eventId: "rollback-provider-user-event",
        sequence: 2,
        occurredAt: message.createdAt,
        type: "thread.message.appended",
        data: {
          messageId: message.messageId,
          messageSequence: 1,
          role: "user",
          contentDigest: message.contentDigest,
        },
      },
    ],
    messages: [message],
    history: {
      expectedLastSequence: 0,
      items: [
        {
          schemaVersion: "crewon.model-history-item.v0",
          itemId: "rollback-provider-user-history",
          tenantId: "tenant-1",
          threadId: "thread-1",
          sequence: 1,
          runId: null,
          segmentId: null,
          createdAt: message.createdAt,
          type: "message",
          role: "user",
          source: "thread_message",
          content: message.content,
          contentDigest: message.contentDigest,
        },
      ],
    },
  };
}

function emptyRollbackInput(): CommitThreadRollbackInput {
  const artifacts = createThreadRollbackArtifacts([], {
    tenantId: "tenant-1",
    threadId: "thread-1",
    actorId: "actor-1",
    rollbackId: "rollback-fenced",
    markerItemId: "rollback-marker-fenced",
    threadEventId: "rollback-event-fenced",
    threadEventSequence: 2,
    occurredAt: "2026-08-08T00:00:04Z",
    requestedTurns: 1,
  });
  return {
    tenantId: "tenant-1",
    idempotency: idempotency("rollback-fenced"),
    expectedThreadRevision: 1,
    expectedHistorySequence: 0,
    event: artifacts.event,
    marker: artifacts.marker,
  };
}

function locator() {
  return { tenantId: "tenant-1", threadId: "thread-1" } as const;
}

function idempotency(key: string) {
  return {
    scope: `thread-rollback-test:${key}`,
    key,
    requestFingerprint: `thread-rollback-fingerprint:${key}`,
  } as const;
}

function digest(sequence: number): string {
  return `sha256:${sequence.toString(16).repeat(64)}`;
}

function timestamp(sequence: number): string {
  return `2026-08-08T00:00:${sequence.toString().padStart(2, "0")}Z`;
}

async function managedStore(
  context: TestContext,
  createStore: (clock: LeaseClock) => DomainStore | Promise<DomainStore>,
): Promise<DomainStore> {
  const store = await createStore({
    nowEpochMilliseconds: () => Date.parse("2026-08-08T00:01:00Z"),
  });
  context.after(() => store.close());
  return store;
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
