import assert from "node:assert/strict";
import test from "node:test";

import {
  createThreadRollbackArtifacts,
  isModelHistoryMessageBacked,
  reduceThreadLifecycleEvent,
  type ModelHistoryItem,
  type ThreadLifecycleEvent,
  type ThreadState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationIdGenerator,
  ApplicationIdKind,
  AuthorizationPort,
} from "./index.ts";
import { RunStoreError } from "./run-store-port.ts";
import { ThreadApplicationService } from "./thread-application-service.ts";
import type {
  CommitThreadInput,
  CommitThreadResult,
  MessageRecord,
  ThreadLocator,
  ThreadStore,
} from "./thread-store-port.ts";

test("creates a scoped Thread then appends a digest-bound Message", async () => {
  const store = new RecordingThreadStore();
  const service = threadService(store, [
    "thread-1",
    "thread-event-1",
    "message-1",
    "thread-event-2",
    "history-1",
  ]);
  const created = await service.createThread(actor(), {
    kind: "thread.create",
    idempotencyKey: "thread-create-1",
    title: "First thread",
  });
  const appended = await service.appendMessage(actor(), {
    kind: "thread.message.append",
    idempotencyKey: "message-append-1",
    threadId: created.state.threadId,
    expectedRevision: 1,
    role: "user",
    content: "hello",
  });

  assert.equal(appended.state.revision, 2);
  assert.equal(appended.state.lastMessageSequence, 1);
  assert.deepEqual(appended.messages, [
    {
      messageId: "message-1",
      tenantId: "tenant-1",
      threadId: "thread-1",
      sequence: 1,
      role: "user",
      content: "hello",
      contentDigest: `sha256:${"a".repeat(64)}`,
      createdAt: "2026-08-08T00:00:02Z",
      origin: null,
      proposedPlan: null,
    },
  ]);
  assert.deepEqual(
    await service.listMessages(actor(), {
      threadId: "thread-1",
      afterSequence: 0,
      limit: 100,
    }),
    appended.messages,
  );
});

test("forks only effective history with contiguous target ledgers and a source CAS", async () => {
  const fixture = forkSourceFixture();
  const store = new ForkRecordingThreadStore(
    { ...threadState(), revision: 9, title: "Fork source" },
    fixture.history,
    fixture.messages,
  );
  const service = threadService(
    store,
    Array.from({ length: 16 }, (_, index) => `fork-id-${index + 1}`),
  );

  const forked = await service.forkThread(actor(), {
    kind: "thread.fork",
    idempotencyKey: "fork-effective-1",
    sourceThreadId: "thread-1",
    expectedSourceRevision: 9,
    throughHistorySequence: null,
  });
  const commit = store.commits[0]!;

  assert.deepEqual(commit.sourceFence, {
    threadId: "thread-1",
    spaceId: "space-1",
    expectedRevision: 9,
  });
  assert.deepEqual(
    forked.messages.map(({ sequence, content }) => ({ sequence, content })),
    [
      { sequence: 1, content: "first" },
      { sequence: 2, content: "answer one" },
      { sequence: 3, content: "third" },
      { sequence: 4, content: "answer three" },
    ],
  );
  assert.equal(
    forked.messages.some((message) => Object.hasOwn(message, "invalidation")),
    false,
  );
  assert.deepEqual(
    forked.messages.find(({ content }) => content === "third")?.origin,
    forkAutomationOrigin("automation-run-surviving", "invocation-surviving"),
  );
  assert.deepEqual(
    forked.historyItems.map((item) => ({
      sequence: item.sequence,
      type: item.type,
      source: item.type === "message" ? item.source : null,
    })),
    [
      { sequence: 1, type: "message", source: "thread_message" },
      { sequence: 2, type: "message", source: "assistant_completion" },
      { sequence: 3, type: "message", source: "goal_continuation" },
      { sequence: 4, type: "message", source: "automation_invocation" },
      { sequence: 5, type: "message", source: "assistant_completion" },
    ],
  );
  assert.deepEqual(
    {
      forkedFromThreadId: forked.state.forkedFromThreadId,
      forkedThroughHistorySequence: forked.state.forkedThroughHistorySequence,
      lastMessageSequence: forked.state.lastMessageSequence,
    },
    {
      forkedFromThreadId: "thread-1",
      forkedThroughHistorySequence: 5,
      lastMessageSequence: 4,
    },
  );
  assert.deepEqual(store.messageViews, ["audit"]);
});

test("hides cross-tenant and cross-space Thread existence", async () => {
  const store = new RecordingThreadStore(threadState());
  const service = threadService(store, []);
  await assert.rejects(
    service.getThread({ ...actor(), tenantId: "tenant-2" }, "thread-1"),
    hasApplicationError("notFound", "thread_not_found"),
  );
  await assert.rejects(
    service.getThread({ ...actor(), spaceId: "space-2" }, "thread-1"),
    hasApplicationError("notFound", "thread_not_found"),
  );
});

test("archives with the visible revision and exposes the durable event", async () => {
  const store = new RecordingThreadStore(threadState());
  const service = threadService(store, ["thread-event-2"]);

  const archived = await service.archiveThread(actor(), {
    kind: "thread.archive",
    idempotencyKey: "thread-archive-1",
    threadId: "thread-1",
    expectedRevision: 1,
  });

  assert.equal(archived.state.status, "archived");
  assert.equal(archived.state.revision, 2);
  assert.deepEqual(archived.events, [
    {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: "thread-1" },
      eventId: "thread-event-2",
      sequence: 2,
      occurredAt: "2026-08-08T00:00:01Z",
      type: "thread.archived",
      data: { actorId: "actor-1" },
    },
  ]);
  assert.deepEqual(
    await service.listThreadEvents(actor(), {
      threadId: "thread-1",
      afterSequence: 1,
      limit: 100,
    }),
    archived.events,
  );
});

test("fails closed on a corrupted archive receipt", async () => {
  const service = threadService(new CorruptingArchiveStore(threadState()), [
    "thread-event-2",
  ]);

  await assert.rejects(
    service.archiveThread(actor(), {
      kind: "thread.archive",
      idempotencyKey: "thread-archive-corrupt",
      threadId: "thread-1",
      expectedRevision: 1,
    }),
    hasApplicationError("internal", "thread_archive_result_invalid"),
  );
});

test("renames an archived Thread, restores it, then writes a terminal tombstone", async () => {
  const store = new RecordingThreadStore(threadState());
  const authorization = new RecordingAuthorization();
  const service = threadService(
    store,
    ["thread-event-2", "thread-event-3", "thread-event-4", "thread-event-5"],
    authorization,
  );
  await service.archiveThread(actor(), {
    kind: "thread.archive",
    idempotencyKey: "archive-lifecycle",
    threadId: "thread-1",
    expectedRevision: 1,
  });
  const renamed = await service.renameThread(actor(), {
    kind: "thread.rename",
    idempotencyKey: "rename-lifecycle",
    threadId: "thread-1",
    expectedRevision: 2,
    title: "Restorable title",
  });
  assert.equal(renamed.state.status, "archived");
  const restored = await service.unarchiveThread(actor(), {
    kind: "thread.unarchive",
    idempotencyKey: "unarchive-lifecycle",
    threadId: "thread-1",
    expectedRevision: 3,
  });
  assert.equal(restored.state.status, "active");
  const deleted = await service.deleteThread(actor(), {
    kind: "thread.delete",
    idempotencyKey: "delete-lifecycle",
    threadId: "thread-1",
    expectedRevision: 4,
  });

  assert.deepEqual(
    {
      status: deleted.state.status,
      title: deleted.state.title,
      archivedAt: deleted.state.archivedAt,
      deletedAt: deleted.state.deletedAt,
      deletedByActorId: deleted.state.deletedByActorId,
      tombstone: store.commits.at(-1)?.tombstone,
    },
    {
      status: "deleted",
      title: null,
      archivedAt: null,
      deletedAt: "2026-08-08T00:00:04Z",
      deletedByActorId: "actor-1",
      tombstone: {
        expectedActiveRunId: null,
        expectedGoalRevision: null,
        occurredAt: "2026-08-08T00:00:04Z",
      },
    },
  );
  await assert.rejects(
    service.getThread(actor(), "thread-1"),
    hasApplicationError("notFound", "thread_not_found"),
  );
  const commitCount = store.commits.length;
  await assert.rejects(
    service.appendMessage(actor(), {
      kind: "thread.message.append",
      idempotencyKey: "append-after-delete",
      threadId: "thread-1",
      expectedRevision: 5,
      role: "user",
      content: "must stay hidden",
    }),
    hasApplicationError("notFound", "thread_not_found"),
  );
  await assert.rejects(
    service.listMessages(actor(), {
      threadId: "thread-1",
      afterSequence: 0,
      limit: 100,
    }),
    hasApplicationError("notFound", "thread_not_found"),
  );
  assert.deepEqual(
    await service.listMessages(actor(), {
      threadId: "thread-1",
      afterSequence: 0,
      limit: 100,
      view: "audit",
    }),
    [],
  );
  assert.deepEqual(
    (
      await service.listThreadEvents(actor(), {
        threadId: "thread-1",
        afterSequence: 0,
        limit: 100,
      })
    ).map((event) => event.type),
    ["thread.deleted"],
  );
  assert.deepEqual(
    (
      await service.listThreadEvents(actor(), {
        threadId: "thread-1",
        afterSequence: 0,
        limit: 100,
        view: "audit",
      })
    ).map((event) => event.type),
    [
      "thread.archived",
      "thread.renamed",
      "thread.unarchived",
      "thread.deleted",
    ],
  );
  assert.equal(store.commits.length, commitCount);
  assert.deepEqual(authorization.actions.slice(-3), [
    "thread:audit:read",
    "thread:read",
    "thread:audit:read",
  ]);
});

test("fails closed on authorization and malformed Message content", async () => {
  const store = new RecordingThreadStore(threadState());
  const authorization: AuthorizationPort = {
    authorize: async () => ({
      outcome: "deny",
      reasonCode: "membership_revoked",
    }),
  };
  const denied = new ThreadApplicationService({
    store,
    authorization,
    clock: new IncrementingClock(),
    ids: new ScriptedIds([]),
    digester: { sha256: () => `sha256:${"a".repeat(64)}` },
  });
  await assert.rejects(
    denied.getThread(actor(), "thread-1"),
    hasApplicationError("authorization", "authorization_denied"),
  );

  const service = threadService(store, []);
  await assert.rejects(
    service.appendMessage(actor(), {
      kind: "thread.message.append",
      idempotencyKey: "bad-message",
      threadId: "thread-1",
      expectedRevision: 1,
      role: "user",
      content: "x".repeat(32 * 1024 + 1),
    }),
    hasApplicationError("validation", "message_content_too_large"),
  );
});

class RecordingThreadStore implements ThreadStore {
  readonly commits: CommitThreadInput[] = [];
  readonly events: ThreadLifecycleEvent[] = [];
  readonly messages: MessageRecord[] = [];
  readonly history: ModelHistoryItem[] = [];
  state: ThreadState | null;

  constructor(state: ThreadState | null = null) {
    this.state = state;
  }

  async listThreadEvents(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ThreadLifecycleEvent[]> {
    if (
      this.state?.tenantId !== locator.tenantId ||
      this.state.threadId !== locator.threadId
    ) {
      return [];
    }
    return this.events
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit);
  }

  async loadThread(locator: ThreadLocator): Promise<ThreadState | null> {
    return this.state?.tenantId === locator.tenantId &&
      this.state.threadId === locator.threadId
      ? structuredClone(this.state)
      : null;
  }

  async loadThreadInSpace(
    locator: Parameters<ThreadStore["loadThreadInSpace"]>[0],
  ): Promise<ThreadState | null> {
    const state = await this.loadThread(locator);
    return state?.spaceId === locator.spaceId ? state : null;
  }

  async listThreads(
    query: Parameters<ThreadStore["listThreads"]>[0],
  ): Promise<readonly ThreadState[]> {
    return this.state?.tenantId === query.tenantId &&
      this.state.spaceId === query.spaceId
      ? this.state.status === "deleted"
        ? []
        : [structuredClone(this.state)]
      : [];
  }

  async loadThreadGoal(): Promise<null> {
    return null;
  }

  async commitThread(input: CommitThreadInput): Promise<CommitThreadResult> {
    this.commits.push(structuredClone(input));
    let state = this.state;
    for (const event of input.events) {
      state = reduceThreadLifecycleEvent(state, event);
    }
    if (state === null) {
      throw new Error("test Thread store did not produce state");
    }
    this.state = state;
    this.events.push(...structuredClone(input.events));
    this.messages.push(...structuredClone(input.messages));
    this.history.push(...structuredClone(input.history.items));
    return {
      disposition: "committed",
      state,
      events: structuredClone(input.events),
      messages: structuredClone(input.messages),
      historyItems: structuredClone(input.history.items),
    };
  }

  async listMessages(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly MessageRecord[]> {
    return this.messages
      .filter(
        (message) =>
          message.tenantId === locator.tenantId &&
          message.threadId === locator.threadId &&
          message.sequence > afterSequence,
      )
      .slice(0, limit);
  }

  async loadModelHistoryHead(locator: ThreadLocator) {
    if (
      this.state?.tenantId !== locator.tenantId ||
      this.state.threadId !== locator.threadId
    ) {
      return null;
    }
    return {
      tenantId: locator.tenantId,
      threadId: locator.threadId,
      lastSequence: this.history.at(-1)?.sequence ?? 0,
    };
  }

  async listModelHistoryItems(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ) {
    return this.history
      .filter(
        (item) =>
          item.tenantId === locator.tenantId &&
          item.threadId === locator.threadId &&
          item.sequence > afterSequence,
      )
      .slice(0, limit);
  }
}

class ForkRecordingThreadStore implements ThreadStore {
  readonly commits: CommitThreadInput[] = [];
  readonly messageViews: Array<"standard" | "audit" | undefined> = [];
  readonly #source: ThreadState;
  readonly #history: readonly ModelHistoryItem[];
  readonly #messages: readonly MessageRecord[];

  constructor(
    source: ThreadState,
    history: readonly ModelHistoryItem[],
    messages: readonly MessageRecord[],
  ) {
    this.#source = source;
    this.#history = history;
    this.#messages = messages;
  }

  async loadThread(locator: ThreadLocator): Promise<ThreadState | null> {
    return locator.tenantId === this.#source.tenantId &&
      locator.threadId === this.#source.threadId
      ? structuredClone(this.#source)
      : null;
  }

  async loadThreadInSpace(
    locator: Parameters<ThreadStore["loadThreadInSpace"]>[0],
  ): Promise<ThreadState | null> {
    const state = await this.loadThread(locator);
    return state?.spaceId === locator.spaceId ? state : null;
  }

  async listThreads(): Promise<readonly ThreadState[]> {
    return [structuredClone(this.#source)];
  }

  async listThreadEvents(): Promise<readonly ThreadLifecycleEvent[]> {
    return [];
  }

  async listMessages(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
    view?: "standard" | "audit",
  ): Promise<readonly MessageRecord[]> {
    this.messageViews.push(view);
    return this.#messages
      .filter(
        (message) =>
          message.tenantId === locator.tenantId &&
          message.threadId === locator.threadId &&
          message.sequence > afterSequence,
      )
      .slice(0, limit);
  }

  async loadModelHistoryHead(locator: ThreadLocator) {
    return locator.tenantId === this.#source.tenantId &&
      locator.threadId === this.#source.threadId
      ? {
          tenantId: locator.tenantId,
          threadId: locator.threadId,
          lastSequence: this.#history.at(-1)?.sequence ?? 0,
        }
      : null;
  }

  async listModelHistoryItems(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ) {
    return this.#history
      .filter(
        (item) =>
          item.tenantId === locator.tenantId &&
          item.threadId === locator.threadId &&
          item.sequence > afterSequence,
      )
      .slice(0, limit);
  }

  async loadThreadGoal(): Promise<null> {
    return null;
  }

  async commitThread(input: CommitThreadInput): Promise<CommitThreadResult> {
    this.commits.push(structuredClone(input));
    if (
      input.sourceFence?.threadId !== this.#source.threadId ||
      input.sourceFence.spaceId !== this.#source.spaceId ||
      input.sourceFence.expectedRevision !== this.#source.revision
    ) {
      throw new RunStoreError("revision_conflict");
    }
    let state: ThreadState | null = null;
    for (const event of input.events) {
      state = reduceThreadLifecycleEvent(state, event);
    }
    assert.ok(state !== null);
    return {
      disposition: "committed",
      state,
      events: structuredClone(input.events),
      messages: structuredClone(input.messages),
      historyItems: structuredClone(input.history.items),
    };
  }
}

class CorruptingArchiveStore extends RecordingThreadStore {
  override async commitThread(
    input: CommitThreadInput,
  ): Promise<CommitThreadResult> {
    const result = await super.commitThread(input);
    return {
      ...result,
      state: { ...result.state, revision: result.state.revision + 1 },
    };
  }
}

function threadService(
  store: ThreadStore &
    import("./model-history-store-port.ts").ModelHistoryStore &
    Pick<
      import("./thread-goal-store-port.ts").ThreadGoalStore,
      "loadThreadGoal"
    >,
  ids: string[],
  authorization: AuthorizationPort = {
    authorize: async () => ({ outcome: "allow" }),
  },
): ThreadApplicationService {
  return new ThreadApplicationService({
    store,
    authorization,
    clock: new IncrementingClock(),
    ids: new ScriptedIds(ids),
    digester: { sha256: () => `sha256:${"a".repeat(64)}` },
  });
}

class RecordingAuthorization implements AuthorizationPort {
  readonly actions: Parameters<AuthorizationPort["authorize"]>[0]["action"][] =
    [];

  async authorize(request: Parameters<AuthorizationPort["authorize"]>[0]) {
    this.actions.push(request.action);
    return { outcome: "allow" } as const;
  }
}

class ScriptedIds implements ApplicationIdGenerator {
  readonly #ids: string[];

  constructor(ids: string[]) {
    this.#ids = [...ids];
  }

  nextId(_kind: ApplicationIdKind): string {
    const id = this.#ids.shift();
    if (id === undefined) {
      throw new Error("scripted id exhausted");
    }
    return id;
  }
}

class IncrementingClock {
  #second = 0;

  now(): string {
    this.#second += 1;
    return `2026-08-08T00:00:${this.#second.toString().padStart(2, "0")}Z`;
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

function threadState(): ThreadState {
  return reduceThreadLifecycleEvent(null, {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: "thread-event-1",
    sequence: 1,
    occurredAt: "2026-08-08T00:00:01Z",
    type: "thread.created",
    data: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      createdByActorId: "actor-1",
      title: null,
    },
  });
}

function forkSourceFixture(): Readonly<{
  history: readonly ModelHistoryItem[];
  messages: readonly MessageRecord[];
}> {
  const beforeRollback = [
    forkHistoryMessage(1, "user", "thread_message", "first"),
    forkHistoryMessage(2, "assistant", "assistant_completion", "answer one"),
    forkAutomationHistoryMessage(
      3,
      "second",
      "automation-run-rolled",
      "invocation-rolled",
    ),
    forkHistoryMessage(4, "assistant", "assistant_completion", "answer two"),
  ] satisfies readonly ModelHistoryItem[];
  const marker = createThreadRollbackArtifacts(beforeRollback, {
    tenantId: "tenant-1",
    threadId: "thread-1",
    actorId: "actor-1",
    rollbackId: "rollback-1",
    markerItemId: "rollback-marker-1",
    threadEventId: "thread-event-rollback-1",
    threadEventSequence: 9,
    occurredAt: forkTimestamp(5),
    requestedTurns: 1,
  }).marker;
  const history = [
    ...beforeRollback,
    marker,
    forkHistoryMessage(6, "user", "goal_continuation", "continue objective"),
    forkAutomationHistoryMessage(
      7,
      "third",
      "automation-run-surviving",
      "invocation-surviving",
    ),
    forkHistoryMessage(8, "assistant", "assistant_completion", "answer three"),
  ] satisfies readonly ModelHistoryItem[];
  const messageItems = history.filter(isModelHistoryMessageBacked);
  return {
    history,
    messages: messageItems.map((item, index) => ({
      messageId: `source-message-${index + 1}`,
      tenantId: item.tenantId,
      threadId: item.threadId,
      sequence: index + 1,
      role: item.role,
      content: item.content,
      contentDigest: item.contentDigest,
      createdAt: item.createdAt,
      origin: item.source === "automation_invocation" ? item.origin : null,
      proposedPlan: null,
      ...(item.sequence === 3 || item.sequence === 4
        ? {
            invalidation: {
              rollbackId: "rollback-1",
              markerItemId: "rollback-marker-1",
              historySequence: item.sequence,
              invalidatedAt: forkTimestamp(5),
            },
          }
        : { invalidation: null }),
    })),
  };
}

function forkHistoryMessage(
  sequence: number,
  role: "user" | "assistant",
  source: "thread_message" | "assistant_completion" | "goal_continuation",
  content: string,
): Extract<ModelHistoryItem, { type: "message" }> {
  return {
    schemaVersion: "crewon.model-history-item.v0",
    type: "message",
    itemId: `source-history-${sequence}`,
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence,
    runId: null,
    segmentId: null,
    createdAt: forkTimestamp(sequence),
    role,
    source,
    content,
    contentDigest: `sha256:${"a".repeat(64)}`,
  };
}

function forkAutomationHistoryMessage(
  sequence: number,
  content: string,
  runId: string,
  invocationId: string,
): Extract<
  ModelHistoryItem,
  { type: "message"; source: "automation_invocation" }
> {
  return {
    schemaVersion: "crewon.model-history-item.v0",
    type: "message",
    itemId: `source-history-${sequence}`,
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence,
    runId,
    segmentId: null,
    createdAt: forkTimestamp(sequence),
    role: "user",
    source: "automation_invocation",
    content,
    contentDigest: `sha256:${"a".repeat(64)}`,
    origin: forkAutomationOrigin(runId, invocationId),
  };
}

function forkAutomationOrigin(runId: string, invocationId: string) {
  return {
    kind: "automation" as const,
    binding: {
      automationId: "automation-1",
      automationRevision: 1 as const,
      definitionDigest: `sha256:${"b".repeat(64)}`,
      instructionDigest: `sha256:${"a".repeat(64)}`,
      invocationId,
      runId,
      routeDigest: `sha256:${"c".repeat(64)}`,
    },
  };
}

function forkTimestamp(sequence: number): string {
  return `2026-08-07T00:00:${sequence.toString().padStart(2, "0")}Z`;
}

function hasApplicationError(
  category: ApplicationError["category"],
  code: string,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
