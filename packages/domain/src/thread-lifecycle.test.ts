import assert from "node:assert/strict";
import test from "node:test";

import {
  ThreadLifecycleError,
  reduceThreadLifecycleEvent,
  replayThreadLifecycle,
  type ThreadLifecycleEvent,
} from "./thread-lifecycle.ts";

test("creates a tenant-scoped active Thread", () => {
  assert.deepEqual(reduceThreadLifecycleEvent(null, createdEvent()), {
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    title: "First thread",
    status: "active",
    revision: 1,
    lastEventSequence: 1,
    lastMessageSequence: 0,
    createdAt: "2026-08-08T00:00:01Z",
    updatedAt: "2026-08-08T00:00:01Z",
    archivedAt: null,
    deletedAt: null,
    deletedByActorId: null,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
  });
});

test("appends Messages with independent contiguous sequence", () => {
  const state = replayThreadLifecycle([
    createdEvent(),
    messageEvent(2, 1, "message-1"),
    messageEvent(3, 2, "message-2", "assistant"),
  ]);
  assert.equal(state.revision, 3);
  assert.equal(state.lastEventSequence, 3);
  assert.equal(state.lastMessageSequence, 2);
});

test("rejects gaps, malformed digests and cross-thread events", () => {
  const state = reduceThreadLifecycleEvent(null, createdEvent());
  assert.throws(
    () => reduceThreadLifecycleEvent(state, messageEvent(2, 2, "message-1")),
    hasCode("message_sequence_gap"),
  );
  assert.throws(
    () =>
      reduceThreadLifecycleEvent(state, {
        ...messageEvent(2, 1, "message-1"),
        data: { ...messageEvent(2, 1, "message-1").data, contentDigest: "bad" },
      }),
    hasCode("message_content_digest_invalid"),
  );
  assert.throws(
    () =>
      reduceThreadLifecycleEvent(state, {
        ...messageEvent(2, 1, "message-1"),
        identity: { threadId: "thread-2" },
      }),
    hasCode("thread_id_mismatch"),
  );
});

test("archives, renames while archived, and restores through unarchive", () => {
  const archived = replayThreadLifecycle([
    createdEvent(),
    {
      ...envelope(2),
      type: "thread.archived",
      data: { actorId: "actor-1" },
    },
  ]);
  assert.equal(archived.status, "archived");
  assert.equal(archived.archivedAt, "2026-08-08T00:00:02Z");
  const renamed = reduceThreadLifecycleEvent(archived, {
    ...envelope(3),
    type: "thread.renamed",
    data: { actorId: "actor-1", title: "Archived title" },
  });
  const restored = reduceThreadLifecycleEvent(renamed, {
    ...envelope(4),
    type: "thread.unarchived",
    data: { actorId: "actor-1" },
  });
  assert.equal(restored.status, "active");
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.title, "Archived title");
  assert.throws(
    () => reduceThreadLifecycleEvent(archived, messageEvent(3, 1, "message-1")),
    hasCode("thread_archived"),
  );
});

test("soft-deletes to a terminal metadata-cleared tombstone", () => {
  const deleted = replayThreadLifecycle([
    createdEvent(),
    {
      ...envelope(2),
      type: "thread.deleted",
      data: { actorId: "actor-delete" },
    },
  ]);

  assert.deepEqual(deleted, {
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    title: null,
    status: "deleted",
    revision: 2,
    lastEventSequence: 2,
    lastMessageSequence: 0,
    createdAt: "2026-08-08T00:00:01Z",
    updatedAt: "2026-08-08T00:00:02Z",
    archivedAt: null,
    deletedAt: "2026-08-08T00:00:02Z",
    deletedByActorId: "actor-delete",
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
  });
  assert.throws(
    () =>
      reduceThreadLifecycleEvent(deleted, {
        ...envelope(3),
        type: "thread.unarchived",
        data: { actorId: "actor-1" },
      }),
    hasCode("thread_deleted"),
  );
});

test("records immutable fork lineage after the imported Message prefix", () => {
  const forked = replayThreadLifecycle([
    createdEvent(),
    messageEvent(2, 1, "message-1"),
    {
      ...envelope(3),
      type: "thread.forked",
      data: {
        sourceThreadId: "thread-source",
        throughHistorySequence: 2,
        throughMessageSequence: 1,
        actorId: "actor-1",
      },
    },
  ]);

  assert.equal(forked.forkedFromThreadId, "thread-source");
  assert.equal(forked.forkedThroughHistorySequence, 2);
  assert.throws(
    () =>
      reduceThreadLifecycleEvent(forked, {
        ...envelope(4),
        type: "thread.forked",
        data: {
          sourceThreadId: "thread-other",
          throughHistorySequence: 2,
          throughMessageSequence: 1,
          actorId: "actor-1",
        },
      }),
    hasCode("thread_fork_invalid"),
  );
});

function createdEvent(): ThreadLifecycleEvent {
  return {
    ...envelope(1),
    type: "thread.created",
    data: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      createdByActorId: "actor-1",
      title: "First thread",
    },
  };
}

function messageEvent(
  sequence: number,
  messageSequence: number,
  messageId: string,
  role: "user" | "assistant" = "user",
): Extract<ThreadLifecycleEvent, { type: "thread.message.appended" }> {
  return {
    ...envelope(sequence),
    type: "thread.message.appended",
    data: {
      messageId,
      messageSequence,
      role,
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
  };
}

function envelope(sequence: number) {
  return {
    schemaVersion: "crewon.thread-event.v0" as const,
    identity: { threadId: "thread-1" },
    eventId: `thread-event-${sequence}`,
    sequence,
    occurredAt: `2026-08-08T00:00:${sequence.toString().padStart(2, "0")}Z`,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof ThreadLifecycleError && error.code === code;
}
