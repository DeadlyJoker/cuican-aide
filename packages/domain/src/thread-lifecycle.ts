import { MAX_MODEL_HISTORY_ROLLBACK_TURNS } from "./model-history.ts";

export const THREAD_STATUSES = ["active", "archived", "deleted"] as const;
export const MESSAGE_ROLES = ["user", "assistant", "system", "tool"] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export type MessageRole = (typeof MESSAGE_ROLES)[number];

type ThreadEventBase = Readonly<{
  schemaVersion: "crewon.thread-event.v0";
  identity: Readonly<{ threadId: string }>;
  eventId: string;
  sequence: number;
  occurredAt: string;
}>;

export type ThreadLifecycleEvent =
  | (ThreadEventBase & {
      type: "thread.created";
      data: Readonly<{
        tenantId: string;
        spaceId: string;
        createdByActorId: string;
        title: string | null;
      }>;
    })
  | (ThreadEventBase & {
      type: "thread.message.appended";
      data: Readonly<{
        messageId: string;
        messageSequence: number;
        role: MessageRole;
        contentDigest: string;
      }>;
    })
  | (ThreadEventBase & {
      type: "thread.forked";
      data: Readonly<{
        sourceThreadId: string;
        throughHistorySequence: number;
        throughMessageSequence: number;
        actorId: string;
      }>;
    })
  | (ThreadEventBase & {
      type: "thread.archived";
      data: Readonly<{ actorId: string }>;
    })
  | (ThreadEventBase & {
      type: "thread.unarchived";
      data: Readonly<{ actorId: string }>;
    })
  | (ThreadEventBase & {
      type: "thread.renamed";
      data: Readonly<{ actorId: string; title: string | null }>;
    })
  | (ThreadEventBase & {
      type: "thread.rolled_back";
      data: Readonly<{
        actorId: string;
        rollbackId: string;
        markerItemId: string;
        requestedTurns: number;
        removedTurns: number;
        historyFromSequence: number | null;
        historyThroughSequence: number;
        markerHistorySequence: number;
      }>;
    })
  | (ThreadEventBase & {
      type: "thread.deleted";
      data: Readonly<{ actorId: string }>;
    });

export type ThreadState = Readonly<{
  threadId: string;
  tenantId: string;
  spaceId: string;
  createdByActorId: string;
  title: string | null;
  status: ThreadStatus;
  revision: number;
  lastEventSequence: number;
  lastMessageSequence: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  deletedByActorId: string | null;
  forkedFromThreadId: string | null;
  forkedThroughHistorySequence: number | null;
}>;

export class ThreadLifecycleError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ThreadLifecycleError";
    this.code = code;
  }
}

export function reduceThreadLifecycleEvent(
  state: ThreadState | null,
  event: ThreadLifecycleEvent,
): ThreadState {
  validateThreadLifecycleEvent(event);
  if (state === null) {
    return createThread(event);
  }
  validateThreadState(state);
  if (event.identity.threadId !== state.threadId) {
    throw new ThreadLifecycleError("thread_id_mismatch");
  }
  if (event.sequence !== state.lastEventSequence + 1) {
    throw new ThreadLifecycleError("thread_event_sequence_gap");
  }
  if (state.status === "deleted") {
    throw new ThreadLifecycleError("thread_deleted");
  }
  if (Date.parse(event.occurredAt) < Date.parse(state.updatedAt)) {
    throw new ThreadLifecycleError("thread_event_time_regression");
  }

  const next = {
    ...state,
    revision: state.revision + 1,
    lastEventSequence: event.sequence,
    updatedAt: event.occurredAt,
  };
  switch (event.type) {
    case "thread.created":
      throw new ThreadLifecycleError("thread_already_created");
    case "thread.message.appended":
      requireActive(state);
      requireNonEmpty(event.data.messageId, "message_id_invalid");
      if (event.data.messageSequence !== state.lastMessageSequence + 1) {
        throw new ThreadLifecycleError("message_sequence_gap");
      }
      if (!MESSAGE_ROLES.includes(event.data.role)) {
        throw new ThreadLifecycleError("message_role_invalid");
      }
      requireDigest(event.data.contentDigest);
      return {
        ...next,
        lastMessageSequence: event.data.messageSequence,
      };
    case "thread.forked":
      requireActive(state);
      requireNonEmpty(
        event.data.sourceThreadId,
        "fork_source_thread_id_invalid",
      );
      requireNonEmpty(event.data.actorId, "fork_actor_id_invalid");
      if (
        state.forkedFromThreadId !== null ||
        event.data.sourceThreadId === state.threadId ||
        !Number.isSafeInteger(event.data.throughHistorySequence) ||
        event.data.throughHistorySequence < 0 ||
        !Number.isSafeInteger(event.data.throughMessageSequence) ||
        event.data.throughMessageSequence < 0 ||
        event.data.throughMessageSequence !== state.lastMessageSequence ||
        event.data.throughMessageSequence > event.data.throughHistorySequence
      ) {
        throw new ThreadLifecycleError("thread_fork_invalid");
      }
      return {
        ...next,
        forkedFromThreadId: event.data.sourceThreadId,
        forkedThroughHistorySequence: event.data.throughHistorySequence,
      };
    case "thread.archived":
      if (state.status === "archived") {
        throw new ThreadLifecycleError("thread_archived");
      }
      return {
        ...next,
        status: "archived",
        archivedAt: event.occurredAt,
      };
    case "thread.unarchived":
      if (state.status !== "archived") {
        throw new ThreadLifecycleError("thread_not_archived");
      }
      return {
        ...next,
        status: "active",
        archivedAt: null,
      };
    case "thread.renamed":
      return { ...next, title: event.data.title };
    case "thread.rolled_back":
      requireActive(state);
      return next;
    case "thread.deleted":
      return {
        ...next,
        title: null,
        status: "deleted",
        archivedAt: null,
        deletedAt: event.occurredAt,
        deletedByActorId: event.data.actorId,
      };
  }
}

export function replayThreadLifecycle(
  events: readonly ThreadLifecycleEvent[],
): ThreadState {
  let state: ThreadState | null = null;
  for (const event of events) {
    state = reduceThreadLifecycleEvent(state, event);
  }
  if (state === null) {
    throw new ThreadLifecycleError("thread_events_empty");
  }
  return state;
}

function createThread(event: ThreadLifecycleEvent): ThreadState {
  if (event.type !== "thread.created") {
    throw new ThreadLifecycleError("thread_not_created");
  }
  if (event.sequence !== 1) {
    throw new ThreadLifecycleError("thread_event_sequence_gap");
  }
  requireNonEmpty(event.identity.threadId, "thread_id_invalid");
  requireNonEmpty(event.data.tenantId, "tenant_id_invalid");
  requireNonEmpty(event.data.spaceId, "space_id_invalid");
  requireNonEmpty(event.data.createdByActorId, "created_by_actor_id_invalid");
  requireNullableTitle(event.data.title);
  return {
    threadId: event.identity.threadId,
    tenantId: event.data.tenantId,
    spaceId: event.data.spaceId,
    createdByActorId: event.data.createdByActorId,
    title: event.data.title,
    status: "active",
    revision: 1,
    lastEventSequence: 1,
    lastMessageSequence: 0,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
    archivedAt: null,
    deletedAt: null,
    deletedByActorId: null,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
  };
}

export function validateThreadLifecycleEvent(
  event: ThreadLifecycleEvent,
): void {
  if (event.schemaVersion !== "crewon.thread-event.v0") {
    throw new ThreadLifecycleError("thread_event_schema_version_unsupported");
  }
  requireNonEmpty(event.eventId, "thread_event_id_invalid");
  requireNonEmpty(event.identity.threadId, "thread_id_invalid");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new ThreadLifecycleError("thread_event_sequence_invalid");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
      event.occurredAt,
    ) ||
    Number.isNaN(Date.parse(event.occurredAt))
  ) {
    throw new ThreadLifecycleError("thread_event_occurred_at_invalid");
  }
  switch (event.type) {
    case "thread.created":
      requireNonEmpty(event.data.tenantId, "tenant_id_invalid");
      requireNonEmpty(event.data.spaceId, "space_id_invalid");
      requireNonEmpty(
        event.data.createdByActorId,
        "created_by_actor_id_invalid",
      );
      requireNullableTitle(event.data.title);
      return;
    case "thread.message.appended":
      requireNonEmpty(event.data.messageId, "message_id_invalid");
      if (
        !Number.isSafeInteger(event.data.messageSequence) ||
        event.data.messageSequence < 1
      ) {
        throw new ThreadLifecycleError("message_sequence_invalid");
      }
      if (!MESSAGE_ROLES.includes(event.data.role)) {
        throw new ThreadLifecycleError("message_role_invalid");
      }
      requireDigest(event.data.contentDigest);
      return;
    case "thread.forked":
      requireNonEmpty(
        event.data.sourceThreadId,
        "fork_source_thread_id_invalid",
      );
      requireNonEmpty(event.data.actorId, "fork_actor_id_invalid");
      if (
        !Number.isSafeInteger(event.data.throughHistorySequence) ||
        event.data.throughHistorySequence < 0 ||
        !Number.isSafeInteger(event.data.throughMessageSequence) ||
        event.data.throughMessageSequence < 0
      ) {
        throw new ThreadLifecycleError("thread_fork_invalid");
      }
      return;
    case "thread.archived":
      requireNonEmpty(event.data.actorId, "archive_actor_id_invalid");
      return;
    case "thread.unarchived":
      requireNonEmpty(event.data.actorId, "unarchive_actor_id_invalid");
      return;
    case "thread.renamed":
      requireNonEmpty(event.data.actorId, "rename_actor_id_invalid");
      requireNullableTitle(event.data.title);
      return;
    case "thread.rolled_back":
      requireNonEmpty(event.data.actorId, "rollback_actor_id_invalid");
      requireNonEmpty(event.data.rollbackId, "rollback_id_invalid");
      requireNonEmpty(event.data.markerItemId, "rollback_marker_id_invalid");
      if (
        !Number.isSafeInteger(event.data.requestedTurns) ||
        event.data.requestedTurns < 1 ||
        event.data.requestedTurns > MAX_MODEL_HISTORY_ROLLBACK_TURNS ||
        !Number.isSafeInteger(event.data.removedTurns) ||
        event.data.removedTurns < 0 ||
        event.data.removedTurns > event.data.requestedTurns ||
        !Number.isSafeInteger(event.data.historyThroughSequence) ||
        event.data.historyThroughSequence < 0 ||
        event.data.markerHistorySequence !==
          event.data.historyThroughSequence + 1 ||
        (event.data.historyFromSequence === null) !==
          (event.data.removedTurns === 0) ||
        (event.data.historyFromSequence !== null &&
          (!Number.isSafeInteger(event.data.historyFromSequence) ||
            event.data.historyFromSequence < 1 ||
            event.data.historyFromSequence > event.data.historyThroughSequence))
      ) {
        throw new ThreadLifecycleError("thread_rollback_invalid");
      }
      return;
    case "thread.deleted":
      requireNonEmpty(event.data.actorId, "delete_actor_id_invalid");
      return;
  }
}

export function validateThreadState(state: ThreadState): void {
  if (!isPlainObject(state)) {
    throw new ThreadLifecycleError("thread_state_invalid");
  }
  requireNonEmpty(state.threadId, "thread_id_invalid");
  requireNonEmpty(state.tenantId, "tenant_id_invalid");
  requireNonEmpty(state.spaceId, "space_id_invalid");
  requireNonEmpty(state.createdByActorId, "created_by_actor_id_invalid");
  requireNullableTitle(state.title);
  if (
    !THREAD_STATUSES.includes(state.status) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1 ||
    !Number.isSafeInteger(state.lastEventSequence) ||
    state.lastEventSequence !== state.revision ||
    !Number.isSafeInteger(state.lastMessageSequence) ||
    state.lastMessageSequence < 0 ||
    !isTimestamp(state.createdAt) ||
    !isTimestamp(state.updatedAt) ||
    Date.parse(state.updatedAt) < Date.parse(state.createdAt)
  ) {
    throw new ThreadLifecycleError("thread_state_invalid");
  }
  if (
    (state.status === "active" &&
      (state.archivedAt !== null ||
        state.deletedAt !== null ||
        state.deletedByActorId !== null)) ||
    (state.status === "archived" &&
      (!isTimestamp(state.archivedAt) ||
        state.deletedAt !== null ||
        state.deletedByActorId !== null)) ||
    (state.status === "deleted" &&
      (state.title !== null ||
        state.archivedAt !== null ||
        !isTimestamp(state.deletedAt) ||
        typeof state.deletedByActorId !== "string" ||
        state.deletedByActorId.trim().length === 0))
  ) {
    throw new ThreadLifecycleError("thread_state_invalid");
  }
  if (
    (state.forkedFromThreadId === null) !==
      (state.forkedThroughHistorySequence === null) ||
    (state.forkedFromThreadId !== null &&
      (state.forkedFromThreadId.trim().length === 0 ||
        state.forkedFromThreadId === state.threadId ||
        !Number.isSafeInteger(state.forkedThroughHistorySequence) ||
        (state.forkedThroughHistorySequence ?? -1) < 0))
  ) {
    throw new ThreadLifecycleError("thread_state_invalid");
  }
}

function requireActive(state: ThreadState): void {
  if (state.status === "archived") {
    throw new ThreadLifecycleError("thread_archived");
  }
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireNonEmpty(value: string, code: string): void {
  if (value.trim().length === 0) {
    throw new ThreadLifecycleError(code);
  }
}

function requireNullableTitle(value: string | null): void {
  if (value !== null && (value.trim().length === 0 || value.length > 256)) {
    throw new ThreadLifecycleError("thread_title_invalid");
  }
}

function requireDigest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ThreadLifecycleError("message_content_digest_invalid");
  }
}
