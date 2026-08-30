import {
  ThreadLifecycleError,
  type MessageRole,
  type ThreadLifecycleEvent,
  type ThreadState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  ActorContext,
  AuthorizationPort,
  ThreadAuthorizationAction,
  ThreadAuthorizationResource,
} from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import { RunStoreError, type IdempotencyDescriptor } from "./run-store-port.ts";
import type {
  ArchiveThreadCommand,
  AppendThreadMessageCommand,
  CreateThreadCommand,
  DeleteThreadCommand,
  ForkThreadCommand,
  RenameThreadCommand,
  UnarchiveThreadCommand,
} from "./thread-commands.ts";
import type {
  CommitThreadInput,
  CommitThreadResult,
  MessageRecord,
  ThreadListCursor,
  ThreadLocator,
  ThreadStore,
} from "./thread-store-port.ts";
import type { ModelHistoryStore } from "./model-history-store-port.ts";
import {
  projectThreadForkHistory,
  rebaseThreadForkHistory,
  selectThreadForkMessages,
  type ThreadForkHistoryProjection,
} from "./thread-fork-history.ts";
import type { ThreadGoalStore } from "./thread-goal-store-port.ts";

const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_FORK_HISTORY_ITEMS = 10_000;
const MAX_FORK_HISTORY_BYTES = 64 * 1024 * 1024;
const FORK_PAGE_SIZE = 100;

export class ThreadApplicationService {
  readonly #store: ThreadStore &
    ModelHistoryStore &
    Pick<ThreadGoalStore, "loadThreadGoal">;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;
  readonly #digester: ContentDigester;

  constructor(dependencies: {
    store: ThreadStore &
      ModelHistoryStore &
      Pick<ThreadGoalStore, "loadThreadGoal">;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
    digester: ContentDigester;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#digester = dependencies.digester;
  }

  async createThread(
    actor: ActorContext,
    command: CreateThreadCommand,
  ): Promise<CommitThreadResult> {
    validateActor(actor);
    validateCreateCommand(command);
    await this.#authorize(actor, "thread:create", {
      kind: "thread",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: null,
    });
    const threadId = this.#nextId("thread");
    const occurredAt = this.#now();
    const event: ThreadLifecycleEvent = {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId },
      eventId: this.#nextId("threadEvent"),
      sequence: 1,
      occurredAt,
      type: "thread.created",
      data: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        createdByActorId: actor.actorId,
        title: command.title,
      },
    };
    const result = await this.#commit({
      tenantId: actor.tenantId,
      idempotency: idempotencyDescriptor(actor, command),
      expectedRevision: 0,
      events: [event],
      messages: [],
      history: { expectedLastSequence: 0, items: [] },
    });
    return result;
  }

  async appendMessage(
    actor: ActorContext,
    command: AppendThreadMessageCommand,
  ): Promise<CommitThreadResult> {
    validateActor(actor);
    validateAppendCommand(command);
    const state = await this.#loadAuthorizedThread(
      actor,
      command.threadId,
      "thread:message:append",
    );
    const occurredAt = this.#now();
    const historyHead = await this.#loadHistoryHead(actor, state.threadId);
    const messageId = this.#nextId("message");
    const contentDigest = this.#digest(command.content);
    const message: MessageRecord = {
      messageId,
      tenantId: actor.tenantId,
      threadId: state.threadId,
      sequence: state.lastMessageSequence + 1,
      role: command.role,
      content: command.content,
      contentDigest,
      createdAt: occurredAt,
      origin: null,
      proposedPlan: null,
    };
    const event: ThreadLifecycleEvent = {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: state.threadId },
      eventId: this.#nextId("threadEvent"),
      sequence: state.lastEventSequence + 1,
      occurredAt,
      type: "thread.message.appended",
      data: {
        messageId,
        messageSequence: message.sequence,
        role: message.role,
        contentDigest,
      },
    };
    const result = await this.#commit({
      tenantId: actor.tenantId,
      idempotency: idempotencyDescriptor(actor, command),
      expectedRevision: command.expectedRevision,
      events: [event],
      messages: [message],
      history: {
        expectedLastSequence: historyHead.lastSequence,
        items: [
          {
            schemaVersion: "crewon.model-history-item.v0",
            itemId: this.#nextId("modelHistoryItem"),
            tenantId: actor.tenantId,
            threadId: state.threadId,
            sequence: historyHead.lastSequence + 1,
            runId: null,
            segmentId: null,
            createdAt: occurredAt,
            type: "message",
            role: message.role,
            source: "thread_message",
            content: message.content,
            contentDigest,
          },
        ],
      },
    });
    return result;
  }

  async forkThread(
    actor: ActorContext,
    command: ForkThreadCommand,
  ): Promise<CommitThreadResult> {
    validateActor(actor);
    validateForkCommand(command);
    const source = await this.#loadAuthorizedThread(
      actor,
      command.sourceThreadId,
      "thread:fork",
    );
    const sourceHistory = await this.#loadForkHistory(
      actor,
      source.threadId,
      command.throughHistorySequence,
    );
    const throughHistorySequence = sourceHistory.items.length;
    const boundary = sourceHistory.items.at(-1);
    if (
      boundary !== undefined &&
      !(
        (boundary.type === "message" && boundary.role === "assistant") ||
        boundary.type === "compaction"
      )
    ) {
      throw new ApplicationError("conflict", "thread_fork_boundary_incomplete");
    }
    const sourceMessages = await this.#loadForkMessages(
      actor,
      source.threadId,
      sourceHistory,
    );
    const targetThreadId = this.#nextId("thread");
    const occurredAt = this.#now();
    const createdEvent: ThreadLifecycleEvent = {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: targetThreadId },
      eventId: this.#nextId("threadEvent"),
      sequence: 1,
      occurredAt,
      type: "thread.created",
      data: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        createdByActorId: actor.actorId,
        title: source.title,
      },
    };
    const messages: MessageRecord[] = sourceMessages.map((message, index) => ({
      messageId: this.#nextId("message"),
      tenantId: actor.tenantId,
      threadId: targetThreadId,
      sequence: index + 1,
      role: message.role,
      content: message.content,
      contentDigest: message.contentDigest,
      createdAt: occurredAt,
      origin: message.origin ?? null,
      proposedPlan: null,
    }));
    const messageEvents: ThreadLifecycleEvent[] = messages.map(
      (message, index) => ({
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: targetThreadId },
        eventId: this.#nextId("threadEvent"),
        sequence: index + 2,
        occurredAt,
        type: "thread.message.appended",
        data: {
          messageId: message.messageId,
          messageSequence: message.sequence,
          role: message.role,
          contentDigest: message.contentDigest,
        },
      }),
    );
    const forkedEvent: ThreadLifecycleEvent = {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: targetThreadId },
      eventId: this.#nextId("threadEvent"),
      sequence: messageEvents.length + 2,
      occurredAt,
      type: "thread.forked",
      data: {
        sourceThreadId: source.threadId,
        throughHistorySequence,
        throughMessageSequence: messages.length,
        actorId: actor.actorId,
      },
    };
    const historyItems = rebaseThreadForkHistory(sourceHistory.items, {
      tenantId: actor.tenantId,
      threadId: targetThreadId,
      createdAt: occurredAt,
      itemIds: sourceHistory.items.map(() => this.#nextId("modelHistoryItem")),
    });
    return this.#commit({
      tenantId: actor.tenantId,
      idempotency: idempotencyDescriptor(actor, command),
      expectedRevision: 0,
      events: [createdEvent, ...messageEvents, forkedEvent],
      messages,
      history: { expectedLastSequence: 0, items: historyItems },
      sourceFence: {
        threadId: source.threadId,
        spaceId: source.spaceId,
        expectedRevision: command.expectedSourceRevision,
      },
    });
  }

  async archiveThread(
    actor: ActorContext,
    command: ArchiveThreadCommand,
  ): Promise<CommitThreadResult> {
    validateActor(actor);
    validateArchiveCommand(command);
    const state = await this.#loadAuthorizedThread(
      actor,
      command.threadId,
      "thread:archive",
    );
    const historyHead = await this.#loadHistoryHead(actor, state.threadId);
    const event: ThreadLifecycleEvent = {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: state.threadId },
      eventId: this.#nextId("threadEvent"),
      sequence: state.lastEventSequence + 1,
      occurredAt: this.#now(),
      type: "thread.archived",
      data: { actorId: actor.actorId },
    };
    const result = await this.#commit({
      tenantId: actor.tenantId,
      idempotency: idempotencyDescriptor(actor, command),
      expectedRevision: command.expectedRevision,
      events: [event],
      messages: [],
      history: { expectedLastSequence: historyHead.lastSequence, items: [] },
    });
    const committedEvent = result.events[0];
    if (
      result.state.tenantId !== actor.tenantId ||
      result.state.spaceId !== actor.spaceId ||
      result.state.threadId !== command.threadId ||
      result.state.status !== "archived" ||
      result.state.revision !== command.expectedRevision + 1 ||
      result.state.archivedAt === null ||
      result.events.length !== 1 ||
      committedEvent?.type !== "thread.archived" ||
      committedEvent.identity.threadId !== command.threadId ||
      committedEvent.sequence !== result.state.lastEventSequence ||
      committedEvent.occurredAt !== result.state.archivedAt ||
      committedEvent.data.actorId !== actor.actorId ||
      result.messages.length !== 0 ||
      result.historyItems.length !== 0
    ) {
      throw new ApplicationError("internal", "thread_archive_result_invalid");
    }
    return result;
  }

  async unarchiveThread(
    actor: ActorContext,
    command: UnarchiveThreadCommand,
  ): Promise<CommitThreadResult> {
    validateActor(actor);
    validateLifecycleCommand(command, "thread.unarchive");
    const state = await this.#loadAuthorizedThread(
      actor,
      command.threadId,
      "thread:unarchive",
    );
    const occurredAt = this.#now();
    const result = await this.#commitLifecycleEvent(actor, command, state, {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: state.threadId },
      eventId: this.#nextId("threadEvent"),
      sequence: state.lastEventSequence + 1,
      occurredAt,
      type: "thread.unarchived",
      data: { actorId: actor.actorId },
    });
    validateLifecycleMutationResult(result, actor, command, {
      type: "thread.unarchived",
      status: "active",
      archivedAt: null,
      deletedAt: null,
    });
    return result;
  }

  async renameThread(
    actor: ActorContext,
    command: RenameThreadCommand,
  ): Promise<CommitThreadResult> {
    validateActor(actor);
    validateRenameCommand(command);
    const state = await this.#loadAuthorizedThread(
      actor,
      command.threadId,
      "thread:rename",
    );
    const result = await this.#commitLifecycleEvent(actor, command, state, {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: state.threadId },
      eventId: this.#nextId("threadEvent"),
      sequence: state.lastEventSequence + 1,
      occurredAt: this.#now(),
      type: "thread.renamed",
      data: { actorId: actor.actorId, title: command.title },
    });
    validateLifecycleMutationResult(result, actor, command, {
      type: "thread.renamed",
      status: "notDeleted",
      deletedAt: null,
      title: command.title,
    });
    return result;
  }

  async deleteThread(
    actor: ActorContext,
    command: DeleteThreadCommand,
  ): Promise<CommitThreadResult> {
    validateActor(actor);
    validateLifecycleCommand(command, "thread.delete");
    const state = await this.#loadThread(actor, command.threadId);
    await this.#authorize(actor, "thread:delete", threadResource(state));
    const occurredAt = this.#now();
    const goal = await this.#loadGoal(actor, state.threadId);
    let result: CommitThreadResult;
    try {
      result = await this.#commitLifecycleEvent(
        actor,
        command,
        state,
        {
          schemaVersion: "crewon.thread-event.v0",
          identity: { threadId: state.threadId },
          eventId: this.#nextId("threadEvent"),
          sequence: state.lastEventSequence + 1,
          occurredAt,
          type: "thread.deleted",
          data: { actorId: actor.actorId },
        },
        {
          expectedActiveRunId: null,
          expectedGoalRevision: goal?.revision ?? null,
          occurredAt,
        },
      );
    } catch (error) {
      if (
        state.status === "deleted" &&
        error instanceof ApplicationError &&
        error.code === "thread_deleted"
      ) {
        throw new ApplicationError("notFound", "thread_not_found", {
          cause: error,
        });
      }
      throw error;
    }
    validateLifecycleMutationResult(result, actor, command, {
      type: "thread.deleted",
      status: "deleted",
      archivedAt: null,
      deletedAt: "event",
      title: null,
    });
    if (result.state.deletedByActorId !== actor.actorId) {
      throw new ApplicationError("internal", "thread_delete_result_invalid");
    }
    return result;
  }

  async #commitLifecycleEvent(
    actor: ActorContext,
    command: UnarchiveThreadCommand | RenameThreadCommand | DeleteThreadCommand,
    state: ThreadState,
    event: ThreadLifecycleEvent,
    tombstone?: CommitThreadInput["tombstone"],
  ): Promise<CommitThreadResult> {
    const historyHead = await this.#loadHistoryHead(actor, state.threadId);
    return this.#commit({
      tenantId: actor.tenantId,
      idempotency: idempotencyDescriptor(actor, command),
      expectedRevision: command.expectedRevision,
      events: [event],
      messages: [],
      history: { expectedLastSequence: historyHead.lastSequence, items: [] },
      ...(tombstone === undefined ? {} : { tombstone }),
    });
  }

  async #loadForkHistory(
    actor: ActorContext,
    threadId: string,
    requestedThroughSequence: number | null,
  ): Promise<ThreadForkHistoryProjection> {
    const head = await this.#loadHistoryHead(actor, threadId);
    if (
      requestedThroughSequence !== null &&
      requestedThroughSequence > head.lastSequence
    ) {
      throw new ApplicationError(
        "conflict",
        "thread_fork_history_sequence_conflict",
      );
    }
    const items: import("@crewon/domain").ModelHistoryItem[] = [];
    let cursor = 0;
    while (cursor < head.lastSequence) {
      const previousCursor = cursor;
      const page = await this.#store.listModelHistoryItems(
        locator(actor, threadId),
        cursor,
        Math.min(FORK_PAGE_SIZE, head.lastSequence - cursor),
      );
      if (page.length === 0) {
        throw new ApplicationError("internal", "model_history_incomplete");
      }
      for (const item of page) {
        if (item.sequence > head.lastSequence) {
          break;
        }
        items.push(item);
        cursor = item.sequence;
      }
      if (cursor <= previousCursor) {
        throw new ApplicationError("internal", "model_history_incomplete");
      }
      if (items.length > MAX_FORK_HISTORY_ITEMS) {
        throw new ApplicationError("validation", "thread_fork_too_large");
      }
    }
    if (items.length !== head.lastSequence) {
      throw new ApplicationError("internal", "model_history_incomplete");
    }
    if (
      new TextEncoder().encode(canonicalJson(items)).byteLength >
      MAX_FORK_HISTORY_BYTES
    ) {
      throw new ApplicationError("validation", "thread_fork_too_large");
    }
    return projectThreadForkHistory(items, requestedThroughSequence);
  }

  async #loadForkMessages(
    actor: ActorContext,
    threadId: string,
    history: ThreadForkHistoryProjection,
  ): Promise<readonly MessageRecord[]> {
    const expected = history.rawMessageItems;
    const messages: MessageRecord[] = [];
    let cursor = 0;
    while (messages.length < expected.length) {
      const page = await this.#store.listMessages(
        locator(actor, threadId),
        cursor,
        Math.min(FORK_PAGE_SIZE, expected.length - messages.length),
        "audit",
      );
      if (page.length === 0) {
        throw new ApplicationError(
          "internal",
          "thread_message_history_incomplete",
        );
      }
      messages.push(...page);
      cursor = page.at(-1)!.sequence;
    }
    return selectThreadForkMessages(history, messages);
  }

  async #loadHistoryHead(
    actor: ActorContext,
    threadId: string,
  ): Promise<import("@crewon/domain").ModelHistoryHead> {
    try {
      const head = await this.#store.loadModelHistoryHead(
        locator(actor, threadId),
      );
      if (head === null) {
        throw new ApplicationError("notFound", "model_history_not_found");
      }
      return head;
    } catch (error) {
      throw mapThreadApplicationError(error);
    }
  }

  async getThread(actor: ActorContext, threadId: string): Promise<ThreadState> {
    validateActor(actor);
    requireNonEmpty(threadId, "thread_id_invalid");
    const state = await this.#loadAuthorizedThread(
      actor,
      threadId,
      "thread:read",
    );
    if (state.status === "deleted") {
      throw new ApplicationError("notFound", "thread_not_found");
    }
    return state;
  }

  async listThreads(
    actor: ActorContext,
    query: { before: ThreadListCursor | null; limit: number },
  ): Promise<readonly ThreadState[]> {
    validateActor(actor);
    validateResourceListQuery(query, "thread_cursor_invalid");
    await this.#authorize(actor, "thread:read", {
      kind: "thread",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: null,
    });
    try {
      return await this.#store.listThreads({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        before: query.before,
        limit: query.limit,
      });
    } catch (error) {
      throw mapThreadApplicationError(error);
    }
  }

  async listMessages(
    actor: ActorContext,
    query: {
      threadId: string;
      afterSequence: number;
      limit: number;
      view?: "standard" | "audit";
    },
  ): Promise<readonly MessageRecord[]> {
    validateActor(actor);
    if (!isPlainObject(query)) {
      throw new ApplicationError("validation", "message_query_invalid");
    }
    requireNonEmpty(query.threadId, "thread_id_invalid");
    const state = await this.#loadThread(actor, query.threadId);
    const view = validateHistoryView(query.view);
    if (state.status === "deleted" && view !== "audit") {
      throw new ApplicationError("notFound", "thread_not_found");
    }
    await this.#authorize(
      actor,
      view === "audit" ? "thread:audit:read" : "thread:read",
      threadResource(state),
    );
    try {
      return await this.#store.listMessages(
        locator(actor, query.threadId),
        query.afterSequence,
        query.limit,
      );
    } catch (error) {
      throw mapThreadApplicationError(error);
    }
  }

  async listThreadEvents(
    actor: ActorContext,
    query: {
      threadId: string;
      afterSequence: number;
      limit: number;
      view?: "standard" | "audit";
    },
  ): Promise<readonly ThreadLifecycleEvent[]> {
    validateActor(actor);
    if (!isPlainObject(query)) {
      throw new ApplicationError("validation", "thread_event_query_invalid");
    }
    requireNonEmpty(query.threadId, "thread_id_invalid");
    const view = validateHistoryView(query.view);
    if (
      !Number.isSafeInteger(query.afterSequence) ||
      query.afterSequence < 0 ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 1_000
    ) {
      throw new ApplicationError("validation", "thread_event_query_invalid");
    }
    const state = await this.#loadThread(actor, query.threadId);
    await this.#authorize(
      actor,
      view === "audit" ? "thread:audit:read" : "thread:read",
      threadResource(state),
    );
    try {
      if (
        state.status === "deleted" &&
        view === "standard" &&
        query.afterSequence < state.lastEventSequence
      ) {
        const tombstone = await this.#store.listThreadEvents(
          locator(actor, query.threadId),
          state.lastEventSequence - 1,
          1,
        );
        return tombstone.filter((event) => event.type === "thread.deleted");
      }
      if (state.status === "deleted" && view === "standard") {
        return [];
      }
      return await this.#store.listThreadEvents(
        locator(actor, query.threadId),
        query.afterSequence,
        query.limit,
      );
    } catch (error) {
      throw mapThreadApplicationError(error);
    }
  }

  async #loadAuthorizedThread(
    actor: ActorContext,
    threadId: string,
    action: ThreadAuthorizationAction,
  ): Promise<ThreadState> {
    const state = await this.#loadThread(actor, threadId);
    if (state.status === "deleted") {
      throw new ApplicationError("notFound", "thread_not_found");
    }
    await this.#authorize(actor, action, threadResource(state));
    return state;
  }

  async #loadThread(
    actor: ActorContext,
    threadId: string,
  ): Promise<ThreadState> {
    let state: ThreadState | null;
    try {
      state = await this.#store.loadThreadInSpace({
        ...locator(actor, threadId),
        spaceId: actor.spaceId,
      });
    } catch (error) {
      throw mapThreadApplicationError(error);
    }
    if (state === null || state.spaceId !== actor.spaceId) {
      throw new ApplicationError("notFound", "thread_not_found");
    }
    return state;
  }

  async #loadGoal(
    actor: ActorContext,
    threadId: string,
  ): Promise<import("@crewon/domain").ThreadGoal | null> {
    try {
      return await this.#store.loadThreadGoal(locator(actor, threadId));
    } catch (error) {
      throw mapThreadApplicationError(error);
    }
  }

  async #authorize(
    actor: ActorContext,
    action: ThreadAuthorizationAction,
    resource: ThreadAuthorizationResource,
  ): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action,
        resource,
      });
      if (decision.outcome === "allow") {
        return;
      }
      throw new ApplicationError("authorization", "authorization_denied");
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }

  async #commit(input: CommitThreadInput): Promise<CommitThreadResult> {
    try {
      return await this.#store.commitThread(input);
    } catch (error) {
      throw mapThreadApplicationError(error);
    }
  }

  #nextId(kind: ApplicationIdKind): string {
    const id = this.#ids.nextId(kind);
    requireNonEmpty(id, `${kind}_id_invalid`);
    return id;
  }

  #now(): string {
    const timestamp = this.#clock.now();
    if (!isRfc3339Utc(timestamp)) {
      throw new ApplicationError("internal", "clock_timestamp_invalid");
    }
    return timestamp;
  }

  #digest(content: string): string {
    const digest = this.#digester.sha256(content);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new ApplicationError("internal", "content_digest_invalid");
    }
    return digest;
  }
}

function validateHistoryView(
  view: "standard" | "audit" | undefined,
): "standard" | "audit" {
  if (view === undefined || view === "standard") return "standard";
  if (view === "audit") return "audit";
  throw new ApplicationError("validation", "thread_history_view_invalid");
}

function idempotencyDescriptor(
  actor: ActorContext,
  command:
    | CreateThreadCommand
    | AppendThreadMessageCommand
    | ForkThreadCommand
    | ArchiveThreadCommand
    | UnarchiveThreadCommand
    | RenameThreadCommand
    | DeleteThreadCommand,
): IdempotencyDescriptor {
  const { idempotencyKey: _idempotencyKey, ...semanticCommand } = command;
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      namespace: "thread-command",
    }),
    key: command.idempotencyKey,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.thread-command-fingerprint.v0",
      actor: {
        actorId: actor.actorId,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
      },
      command: semanticCommand,
    }),
  };
}

function locator(actor: ActorContext, threadId: string): ThreadLocator {
  return { tenantId: actor.tenantId, threadId };
}

function validateCreateCommand(command: CreateThreadCommand): void {
  if (!isPlainObject(command) || command.kind !== "thread.create") {
    throw new ApplicationError("validation", "thread_command_kind_unsupported");
  }
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  if (
    command.title !== null &&
    (typeof command.title !== "string" ||
      command.title.trim().length === 0 ||
      command.title.length > 256)
  ) {
    throw new ApplicationError("validation", "thread_title_invalid");
  }
}

function validateAppendCommand(command: AppendThreadMessageCommand): void {
  if (!isPlainObject(command) || command.kind !== "thread.message.append") {
    throw new ApplicationError("validation", "thread_command_kind_unsupported");
  }
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  requireNonEmpty(command.threadId, "thread_id_invalid");
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1
  ) {
    throw new ApplicationError("validation", "expected_revision_invalid");
  }
  if (!isMessageRole(command.role)) {
    throw new ApplicationError("validation", "message_role_invalid");
  }
  requireNonEmpty(command.content, "message_content_invalid");
  if (
    new TextEncoder().encode(command.content).byteLength > MAX_MESSAGE_BYTES
  ) {
    throw new ApplicationError("validation", "message_content_too_large");
  }
}

function validateForkCommand(command: ForkThreadCommand): void {
  if (!isPlainObject(command) || command.kind !== "thread.fork") {
    throw new ApplicationError("validation", "thread_command_kind_unsupported");
  }
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  requireNonEmpty(command.sourceThreadId, "thread_id_invalid");
  if (
    !Number.isSafeInteger(command.expectedSourceRevision) ||
    command.expectedSourceRevision < 1 ||
    (command.throughHistorySequence !== null &&
      (!Number.isSafeInteger(command.throughHistorySequence) ||
        command.throughHistorySequence < 0))
  ) {
    throw new ApplicationError("validation", "thread_fork_boundary_invalid");
  }
}

function validateArchiveCommand(command: ArchiveThreadCommand): void {
  if (!isPlainObject(command) || command.kind !== "thread.archive") {
    throw new ApplicationError("validation", "thread_command_kind_unsupported");
  }
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  requireNonEmpty(command.threadId, "thread_id_invalid");
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1
  ) {
    throw new ApplicationError("validation", "expected_revision_invalid");
  }
}

function validateLifecycleCommand(
  command: UnarchiveThreadCommand | DeleteThreadCommand,
  kind: "thread.unarchive" | "thread.delete",
): void {
  if (!isPlainObject(command) || command.kind !== kind) {
    throw new ApplicationError("validation", "thread_command_kind_unsupported");
  }
  validateLifecycleCommandBase(command);
}

function validateRenameCommand(command: RenameThreadCommand): void {
  if (!isPlainObject(command) || command.kind !== "thread.rename") {
    throw new ApplicationError("validation", "thread_command_kind_unsupported");
  }
  validateLifecycleCommandBase(command);
  if (
    command.title !== null &&
    (typeof command.title !== "string" ||
      command.title.trim().length === 0 ||
      command.title.length > 256)
  ) {
    throw new ApplicationError("validation", "thread_title_invalid");
  }
}

function validateLifecycleCommandBase(command: {
  idempotencyKey: unknown;
  threadId: unknown;
  expectedRevision: unknown;
}): void {
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  requireNonEmpty(command.threadId, "thread_id_invalid");
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    Number(command.expectedRevision) < 1
  ) {
    throw new ApplicationError("validation", "expected_revision_invalid");
  }
}

function validateLifecycleMutationResult(
  result: CommitThreadResult,
  actor: ActorContext,
  command: UnarchiveThreadCommand | RenameThreadCommand | DeleteThreadCommand,
  expected: {
    type: "thread.unarchived" | "thread.renamed" | "thread.deleted";
    status: ThreadState["status"] | "notDeleted";
    archivedAt?: string | null;
    deletedAt: string | null | "event";
    title?: string | null;
  },
): void {
  const event = result.events[0];
  if (
    result.state.tenantId !== actor.tenantId ||
    result.state.spaceId !== actor.spaceId ||
    result.state.threadId !== command.threadId ||
    (expected.status === "notDeleted"
      ? result.state.status === "deleted"
      : result.state.status !== expected.status) ||
    result.state.revision !== command.expectedRevision + 1 ||
    (expected.archivedAt !== undefined &&
      result.state.archivedAt !== expected.archivedAt) ||
    (expected.deletedAt === "event"
      ? result.state.deletedAt === null
      : result.state.deletedAt !== expected.deletedAt) ||
    (expected.title !== undefined && result.state.title !== expected.title) ||
    result.events.length !== 1 ||
    event?.type !== expected.type ||
    event.identity.threadId !== command.threadId ||
    event.sequence !== result.state.lastEventSequence ||
    event.occurredAt !== result.state.updatedAt ||
    (expected.deletedAt === "event" &&
      result.state.deletedAt !== event.occurredAt) ||
    event.data.actorId !== actor.actorId ||
    (event.type === "thread.renamed" &&
      (command.kind !== "thread.rename" ||
        event.data.title !== command.title)) ||
    result.messages.length !== 0 ||
    result.historyItems.length !== 0
  ) {
    throw new ApplicationError(
      "internal",
      `thread_${command.kind.slice("thread.".length)}_result_invalid`,
    );
  }
}

function threadResource(state: ThreadState): ThreadAuthorizationResource {
  return {
    kind: "thread",
    tenantId: state.tenantId,
    spaceId: state.spaceId,
    threadId: state.threadId,
  };
}

function validateResourceListQuery(
  query: { before: ThreadListCursor | null; limit: number },
  cursorCode: string,
): void {
  if (
    !isPlainObject(query) ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100
  ) {
    throw new ApplicationError("validation", "page_limit_invalid");
  }
  if (
    query.before !== null &&
    (!isPlainObject(query.before) ||
      !isRfc3339Utc(query.before.updatedAt) ||
      typeof query.before.threadId !== "string" ||
      query.before.threadId.trim().length === 0)
  ) {
    throw new ApplicationError("validation", cursorCode);
  }
}

function validateActor(actor: ActorContext): void {
  if (!isPlainObject(actor)) {
    throw new ApplicationError("validation", "actor_context_invalid");
  }
  requireNonEmpty(actor.principalId, "principal_id_invalid");
  requireNonEmpty(actor.actorId, "actor_id_invalid");
  requireNonEmpty(actor.tenantId, "tenant_id_invalid");
  requireNonEmpty(actor.spaceId, "space_id_invalid");
}

function isMessageRole(value: unknown): value is MessageRole {
  return (
    value === "user" ||
    value === "assistant" ||
    value === "system" ||
    value === "tool"
  );
}

function requireNonEmpty(
  value: unknown,
  code: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApplicationError("validation", code);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRfc3339Utc(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function mapThreadApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }
  if (error instanceof RunStoreError) {
    if (
      error.code === "idempotency_conflict" ||
      error.code === "revision_conflict" ||
      error.code === "thread_event_id_conflict" ||
      error.code === "message_id_conflict" ||
      error.code === "message_sequence_conflict" ||
      error.code.endsWith("_conflict")
    ) {
      return new ApplicationError("conflict", error.code, { cause: error });
    }
    if (
      error.code.endsWith("_invalid") ||
      error.code.endsWith("_too_large") ||
      error.code === "non_json_value"
    ) {
      return new ApplicationError("validation", error.code, { cause: error });
    }
    return new ApplicationError("internal", "store_unavailable", {
      cause: error,
    });
  }
  if (error instanceof ThreadLifecycleError) {
    const category = error.code.endsWith("_invalid")
      ? "validation"
      : "conflict";
    return new ApplicationError(category, error.code, { cause: error });
  }
  return new ApplicationError("internal", "application_internal", {
    cause: error,
  });
}
