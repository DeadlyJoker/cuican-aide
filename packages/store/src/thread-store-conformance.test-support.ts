import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";

import {
  ThreadLifecycleError,
  type ThreadLifecycleEvent,
  type ThreadState,
} from "@crewon/domain";

import {
  RunStoreError,
  type CommitThreadInput,
  type MessageRecord,
  type ModelHistoryStore,
  type ThreadStore,
} from "@crewon/application";
import type { LeaseClock } from "./lease-clock.ts";

const MESSAGE_DIGEST = `sha256:${"a".repeat(64)}`;

/** Registers the behavioral contract every ThreadStore adapter must satisfy. */
export function registerThreadStoreConformance(
  name: string,
  createStore: (
    clock: LeaseClock,
  ) => ThreadConformanceStore | Promise<ThreadConformanceStore>,
): void {
  describe(name, () => {
    test("atomically commits and replays a Thread snapshot", async (context) => {
      const store = await managedStore(context, createStore);
      const input = createThreadCommitFixture();

      const committed = await store.commitThread(input);

      assert.deepEqual(committed, {
        disposition: "committed",
        state: threadStateFixture(),
        events: input.events,
        messages: [],
        historyItems: [],
      });
      assert.deepEqual(
        await store.loadThread(threadLocator()),
        committed.state,
      );
      assert.deepEqual(await store.commitThread(input), {
        ...committed,
        disposition: "replayed",
      });
    });

    test("appends correlated messages with stable pagination", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const first = appendMessageCommit(1, 2);
      const second = appendMessageCommit(2, 3);

      await store.commitThread(first);
      await store.commitThread(second);

      assert.deepEqual(await store.listMessages(threadLocator(), 0, 1), [
        first.messages[0],
      ]);
      assert.deepEqual(await store.listMessages(threadLocator(), 1, 100), [
        second.messages[0],
      ]);
      assert.deepEqual(
        await store.listModelHistoryItems(threadLocator(), 0, 100),
        [...first.history.items, ...second.history.items],
      );
      assert.deepEqual(await store.loadModelHistoryHead(threadLocator()), {
        tenantId: "tenant-1",
        threadId: "thread-1",
        lastSequence: 2,
      });
      assert.equal((await store.loadThread(threadLocator()))?.revision, 3);
      assert.equal(
        (await store.loadThread(threadLocator()))?.lastMessageSequence,
        2,
      );
    });

    test("lists same-space Threads with a stable newest-first cursor", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store, {
        threadId: "thread-1",
        occurredAt: "2026-08-08T00:00:00Z",
      });
      await seedThread(store, {
        threadId: "thread-2",
        occurredAt: "2026-08-08T00:00:01Z",
      });
      await seedThread(store, {
        threadId: "thread-other-space",
        spaceId: "space-2",
        occurredAt: "2026-08-08T00:00:03Z",
      });
      await store.commitThread(appendMessageCommit(1, 2));

      const first = await store.listThreads({
        tenantId: "tenant-1",
        spaceId: "space-1",
        before: null,
        limit: 1,
      });
      assert.deepEqual(
        first.map(({ threadId, updatedAt }) => ({ threadId, updatedAt })),
        [{ threadId: "thread-1", updatedAt: "2026-08-08T00:00:02Z" }],
      );
      const second = await store.listThreads({
        tenantId: "tenant-1",
        spaceId: "space-1",
        before: {
          threadId: first[0]!.threadId,
          updatedAt: first[0]!.updatedAt,
        },
        limit: 100,
      });
      assert.deepEqual(
        second.map(({ threadId }) => threadId),
        ["thread-2"],
      );
    });

    test("rejects stale revisions and message/event mismatches atomically", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const input = appendMessageCommit(1, 2);

      await assert.rejects(
        store.commitThread({
          ...input,
          expectedRevision: 0,
        }),
        hasStoreCode("revision_conflict"),
      );
      await assert.rejects(
        store.commitThread({
          ...input,
          idempotency: idempotency("mismatch"),
          messages: [
            {
              ...input.messages[0],
              contentDigest: `sha256:${"b".repeat(64)}`,
            },
          ],
        }),
        hasStoreCode("message_event_mismatch"),
      );
      await assert.rejects(
        store.commitThread({
          ...input,
          idempotency: idempotency("orphan-history-result"),
          history: {
            expectedLastSequence: 0,
            items: [
              {
                schemaVersion: "crewon.model-history-item.v0",
                itemId: "history-orphan-result",
                tenantId: "tenant-1",
                threadId: "thread-1",
                sequence: 1,
                runId: "run-orphan",
                segmentId: "segment-orphan",
                createdAt: "2026-08-08T00:00:02Z",
                type: "tool_result",
                kind: "function",
                callId: "call-orphan",
                output: "orphan",
                isError: true,
                status: "completed",
              },
            ],
          },
        }),
        hasStoreCode("model_history_tool_result_orphaned"),
      );
      assert.deepEqual(await store.listMessages(threadLocator(), 0, 100), []);
      assert.deepEqual(
        await store.listModelHistoryItems(threadLocator(), 0, 100),
        [],
      );
      assert.equal((await store.loadThread(threadLocator()))?.revision, 1);
    });

    test("hides Thread and Message state across tenant boundaries", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      await store.commitThread(appendMessageCommit(1, 2));

      assert.equal(
        await store.loadThread({ tenantId: "tenant-2", threadId: "thread-1" }),
        null,
      );
      assert.deepEqual(
        await store.listMessages(
          { tenantId: "tenant-2", threadId: "thread-1" },
          0,
          100,
        ),
        [],
      );
      assert.equal(
        await store.loadModelHistoryHead({
          tenantId: "tenant-2",
          threadId: "thread-1",
        }),
        null,
      );
      assert.deepEqual(
        await store.listModelHistoryItems(
          { tenantId: "tenant-2", threadId: "thread-1" },
          0,
          100,
        ),
        [],
      );
    });

    test("atomically archives, renames, restores and terminally tombstones", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const archive = archiveThreadCommit();

      const committed = await store.commitThread(archive);

      assert.equal(committed.state.status, "archived");
      assert.equal(committed.state.revision, 2);
      assert.deepEqual(await store.commitThread(archive), {
        ...committed,
        disposition: "replayed",
      });
      assert.deepEqual(
        await store.listThreadEvents(threadLocator(), 1, 100),
        archive.events,
      );
      assert.deepEqual(
        await store.listThreadEvents(
          { tenantId: "tenant-2", threadId: "thread-1" },
          0,
          100,
        ),
        [],
      );
      const renamed = renameThreadCommit();
      assert.equal((await store.commitThread(renamed)).state.title, "Renamed");
      const unarchive = unarchiveThreadCommit();
      assert.equal(
        (await store.commitThread(unarchive)).state.status,
        "active",
      );
      const tombstone = createDeleteThreadCommitFixture();
      const deleted = await store.commitThread(tombstone);
      assert.deepEqual(
        {
          status: deleted.state.status,
          title: deleted.state.title,
          archivedAt: deleted.state.archivedAt,
          deletedAt: deleted.state.deletedAt,
          deletedByActorId: deleted.state.deletedByActorId,
        },
        {
          status: "deleted",
          title: null,
          archivedAt: null,
          deletedAt: "2026-08-08T00:00:05Z",
          deletedByActorId: "actor-1",
        },
      );
      assert.deepEqual(await store.commitThread(tombstone), {
        ...deleted,
        disposition: "replayed",
      });
      assert.deepEqual(
        await store.listThreads({
          tenantId: "tenant-1",
          spaceId: "space-1",
          before: null,
          limit: 100,
        }),
        [],
      );
      assert.deepEqual(
        (await store.listThreadEvents(threadLocator(), 0, 100)).map(
          (event) => event.type,
        ),
        [
          "thread.created",
          "thread.archived",
          "thread.renamed",
          "thread.unarchived",
          "thread.deleted",
        ],
      );
      await assert.rejects(
        store.commitThread({
          ...renameThreadCommit(5, 6, "rename-deleted"),
          idempotency: idempotency("rename-deleted"),
        }),
        (error) =>
          error instanceof ThreadLifecycleError &&
          error.code === "thread_deleted",
      );
    });

    test("fences a fork source revision but replays an already committed fork", async (context) => {
      const store = await managedStore(context, createStore);
      await seedThread(store);
      const fork = emptyForkCommit();

      const committed = await store.commitThread(fork);
      await store.commitThread(appendMessageCommit(1, 2));

      assert.equal(committed.state.forkedFromThreadId, "thread-1");
      assert.deepEqual(await store.commitThread(fork), {
        ...committed,
        disposition: "replayed",
      });
      await assert.rejects(
        store.commitThread({
          ...emptyForkCommit("thread-3", "fork-stale"),
          sourceFence: {
            threadId: "thread-1",
            spaceId: "space-1",
            expectedRevision: 1,
          },
        }),
        hasStoreCode("thread_fork_source_revision_conflict"),
      );
      assert.equal(
        await store.loadThread({ tenantId: "tenant-1", threadId: "thread-3" }),
        null,
      );
    });
  });
}

export async function seedThread(
  store: ThreadStore,
  options: {
    tenantId?: string;
    spaceId?: string;
    threadId?: string;
    actorId?: string;
    occurredAt?: string;
  } = {},
): Promise<ThreadState> {
  const input = createThreadCommitFixture(options);
  return (await store.commitThread(input)).state;
}

export function createThreadCommitFixture(
  options: {
    tenantId?: string;
    spaceId?: string;
    threadId?: string;
    actorId?: string;
    occurredAt?: string;
  } = {},
): CommitThreadInput {
  const tenantId = options.tenantId ?? "tenant-1";
  const spaceId = options.spaceId ?? "space-1";
  const threadId = options.threadId ?? "thread-1";
  const actorId = options.actorId ?? "actor-1";
  const occurredAt = options.occurredAt ?? "2026-08-08T00:00:00Z";
  const event: ThreadLifecycleEvent = {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId },
    eventId: `thread-event-created:${tenantId}:${threadId}`,
    sequence: 1,
    occurredAt,
    type: "thread.created",
    data: {
      tenantId,
      spaceId,
      createdByActorId: actorId,
      title: null,
    },
  };
  return {
    tenantId,
    idempotency: idempotency(`create:${tenantId}:${threadId}`),
    expectedRevision: 0,
    events: [event],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
  };
}

export function threadStateFixture(): ThreadState {
  return {
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    title: null,
    status: "active",
    revision: 1,
    lastEventSequence: 1,
    lastMessageSequence: 0,
    createdAt: "2026-08-08T00:00:00Z",
    updatedAt: "2026-08-08T00:00:00Z",
    archivedAt: null,
    deletedAt: null,
    deletedByActorId: null,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
  };
}

function appendMessageCommit(
  messageSequence: number,
  eventSequence: number,
): CommitThreadInput {
  const createdAt = `2026-08-08T00:00:${eventSequence.toString().padStart(2, "0")}Z`;
  const message: MessageRecord = {
    messageId: `message-${messageSequence}`,
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence: messageSequence,
    role: "user",
    content: `message ${messageSequence}`,
    contentDigest: MESSAGE_DIGEST,
    createdAt,
    origin: null,
  };
  const event: ThreadLifecycleEvent = {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: `thread-event-${eventSequence}`,
    sequence: eventSequence,
    occurredAt: createdAt,
    type: "thread.message.appended",
    data: {
      messageId: message.messageId,
      messageSequence,
      role: message.role,
      contentDigest: message.contentDigest,
    },
  };
  return {
    tenantId: "tenant-1",
    idempotency: idempotency(`append-${messageSequence}`),
    expectedRevision: eventSequence - 1,
    events: [event],
    messages: [message],
    history: {
      expectedLastSequence: messageSequence - 1,
      items: [
        {
          schemaVersion: "crewon.model-history-item.v0",
          itemId: `history-${messageSequence}`,
          tenantId: message.tenantId,
          threadId: message.threadId,
          sequence: messageSequence,
          runId: null,
          segmentId: null,
          createdAt,
          type: "message",
          role: message.role,
          source: "thread_message",
          content: message.content,
          contentDigest: message.contentDigest,
        },
      ],
    },
  };
}

function emptyForkCommit(
  targetThreadId = "thread-2",
  idempotencyKey = "fork-thread-2",
): CommitThreadInput {
  const occurredAt = "2026-08-08T00:00:02Z";
  return {
    tenantId: "tenant-1",
    idempotency: idempotency(idempotencyKey),
    expectedRevision: 0,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: targetThreadId },
        eventId: `event-created-${targetThreadId}`,
        sequence: 1,
        occurredAt,
        type: "thread.created",
        data: {
          tenantId: "tenant-1",
          spaceId: "space-1",
          createdByActorId: "actor-1",
          title: null,
        },
      },
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: targetThreadId },
        eventId: `event-forked-${targetThreadId}`,
        sequence: 2,
        occurredAt,
        type: "thread.forked",
        data: {
          sourceThreadId: "thread-1",
          throughHistorySequence: 0,
          throughMessageSequence: 0,
          actorId: "actor-1",
        },
      },
    ],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
    sourceFence: {
      threadId: "thread-1",
      spaceId: "space-1",
      expectedRevision: 1,
    },
  };
}

function archiveThreadCommit(): CommitThreadInput {
  return {
    tenantId: "tenant-1",
    idempotency: idempotency("archive-thread-1"),
    expectedRevision: 1,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread-1" },
        eventId: "thread-event-archive:tenant-1:thread-1",
        sequence: 2,
        occurredAt: "2026-08-08T00:00:02Z",
        type: "thread.archived",
        data: { actorId: "actor-1" },
      },
    ],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
  };
}

function renameThreadCommit(
  expectedRevision = 2,
  sequence = 3,
  key = "rename-thread-1",
): CommitThreadInput {
  return lifecycleThreadCommit(key, expectedRevision, sequence, {
    type: "thread.renamed",
    data: { actorId: "actor-1", title: "Renamed" },
  });
}

function unarchiveThreadCommit(): CommitThreadInput {
  return lifecycleThreadCommit("unarchive-thread-1", 3, 4, {
    type: "thread.unarchived",
    data: { actorId: "actor-1" },
  });
}

export function createDeleteThreadCommitFixture(
  expectedRevision = 4,
  sequence = 5,
  expectedGoalRevision: number | null = null,
): CommitThreadInput {
  const occurredAt = `2026-08-08T00:00:${sequence
    .toString()
    .padStart(2, "0")}Z`;
  return {
    ...lifecycleThreadCommit("delete-thread-1", expectedRevision, sequence, {
      type: "thread.deleted",
      data: { actorId: "actor-1" },
    }),
    tombstone: {
      expectedActiveRunId: null,
      expectedGoalRevision,
      occurredAt,
    },
  };
}

function lifecycleThreadCommit(
  key: string,
  expectedRevision: number,
  sequence: number,
  event: Pick<
    Extract<
      ThreadLifecycleEvent,
      {
        type: "thread.renamed" | "thread.unarchived" | "thread.deleted";
      }
    >,
    "type" | "data"
  >,
): CommitThreadInput {
  const occurredAt = `2026-08-08T00:00:${sequence
    .toString()
    .padStart(2, "0")}Z`;
  return {
    tenantId: "tenant-1",
    idempotency: idempotency(key),
    expectedRevision,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread-1" },
        eventId: `thread-event-${key}`,
        sequence,
        occurredAt,
        ...event,
      } as ThreadLifecycleEvent,
    ],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
  };
}

function idempotency(key: string) {
  return {
    scope: `thread-store-test:${key}`,
    key,
    requestFingerprint: `fingerprint:${key}`,
  } as const;
}

function threadLocator() {
  return { tenantId: "tenant-1", threadId: "thread-1" } as const;
}

type ThreadConformanceStore = ThreadStore &
  ModelHistoryStore & { close(): Promise<void> };

async function managedStore(
  context: TestContext,
  createStore: (
    clock: LeaseClock,
  ) => ThreadConformanceStore | Promise<ThreadConformanceStore>,
): Promise<ThreadConformanceStore> {
  const store = await createStore({
    nowEpochMilliseconds: () => Date.parse("2026-08-08T00:01:00Z"),
  });
  context.after(() => store.close());
  return store;
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
