import assert from "node:assert/strict";
import test from "node:test";

import {
  createThreadRollbackArtifacts,
  projectEffectiveModelHistory,
  reduceThreadLifecycleEvent,
  type ModelHistoryItem,
  type ThreadLifecycleEvent,
  type ThreadState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
} from "./application-runtime-ports.ts";
import type { AuthorizationPort } from "./authorization-port.ts";
import { RunStoreError } from "./run-store-port.ts";
import { ThreadRollbackApplicationService } from "./thread-rollback-application-service.ts";
import type {
  CommitThreadRollbackInput,
  CommitThreadRollbackResult,
  ThreadRollbackReceiptQuery,
  ThreadRollbackStore,
} from "./thread-rollback-store-port.ts";
import type {
  CommitThreadInput,
  CommitThreadResult,
  MessageRecord,
  ThreadListQuery,
  ThreadLocator,
  ThreadStore,
} from "./thread-store-port.ts";

test("commits an overshoot rollback from bounded raw history", async () => {
  const fixture = threadFixture([
    historyMessage(1, "user", "thread_message", "first"),
    historyMessage(2, "assistant", "assistant_completion", "answer one"),
    historyMessage(3, "user", "thread_message", "second"),
    historyMessage(4, "assistant", "assistant_completion", "answer two"),
  ]);
  const store = new RecordingRollbackStore(fixture);
  const authorization = new RecordingAuthorization();
  const runtime = recordingRuntime();
  const service = rollbackService(store, authorization, runtime);

  const result = await service.rollbackThread(actor(), {
    kind: "thread.rollback",
    idempotencyKey: "rollback-overshoot",
    threadId: "thread-1",
    expectedRevision: fixture.state.revision,
    numTurns: 10,
  });

  assert.deepEqual(
    {
      disposition: result.disposition,
      requestedTurns: result.marker.requestedTurns,
      removedTurns: result.marker.removedTurns,
      historyFromSequence: result.marker.historyFromSequence,
      historyThroughSequence: result.marker.historyThroughSequence,
      markerHistorySequence: result.marker.sequence,
      invalidatedHistorySequences: result.invalidatedMessages.map(
        ({ invalidation }) => invalidation.historySequence,
      ),
      goalMethodsCalled: store.goalMethodsCalled,
    },
    {
      disposition: "committed",
      requestedTurns: 10,
      removedTurns: 2,
      historyFromSequence: 1,
      historyThroughSequence: 4,
      markerHistorySequence: 5,
      invalidatedHistorySequences: [1, 2, 3, 4],
      goalMethodsCalled: 0,
    },
  );
  assert.deepEqual(store.commits[0], {
    tenantId: "tenant-1",
    idempotency: store.receiptQueries[0]!.idempotency,
    expectedThreadRevision: fixture.state.revision,
    expectedHistorySequence: 4,
    event: result.event,
    marker: result.marker,
  });
  assert.deepEqual(authorization.actions, ["thread:rollback"]);
  assert.deepEqual(runtime.ids.kinds, [
    "rollback",
    "modelHistoryItem",
    "threadEvent",
  ]);
  assert.equal(runtime.clock.calls, 1);
});

test("persists an auditable no-turn rollback without changing Goal", async () => {
  const fixture = threadFixture([
    historyMessage(1, "assistant", "assistant_completion", "assistant only"),
    historyMessage(2, "user", "goal_continuation", "continue goal"),
  ]);
  const store = new RecordingRollbackStore(fixture);
  const runtime = recordingRuntime();
  const result = await rollbackService(
    store,
    new RecordingAuthorization(),
    runtime,
  ).rollbackThread(actor(), {
    kind: "thread.rollback",
    idempotencyKey: "rollback-no-turn",
    threadId: "thread-1",
    expectedRevision: fixture.state.revision,
    numTurns: 3,
  });

  assert.deepEqual(
    {
      removedTurns: result.marker.removedTurns,
      historyFromSequence: result.marker.historyFromSequence,
      invalidatedMessages: result.invalidatedMessages,
      beforeRevision: fixture.state.revision,
      afterRevision: result.state.revision,
      beforeMessageSequence: fixture.state.lastMessageSequence,
      afterMessageSequence: result.state.lastMessageSequence,
      goalMethodsCalled: store.goalMethodsCalled,
    },
    {
      removedTurns: 0,
      historyFromSequence: null,
      invalidatedMessages: [],
      beforeRevision: fixture.state.revision,
      afterRevision: fixture.state.revision + 1,
      beforeMessageSequence: fixture.state.lastMessageSequence,
      afterMessageSequence: fixture.state.lastMessageSequence,
      goalMethodsCalled: 0,
    },
  );
});

test("replays the same key before later state/history fences or ID generation", async () => {
  const initial = threadFixture([]);
  const receipt = rollbackResult(
    initial,
    createThreadRollbackArtifacts(initial.history, {
      tenantId: "tenant-1",
      threadId: "thread-1",
      actorId: "actor-1",
      rollbackId: "rollback-receipt",
      markerItemId: "marker-receipt",
      threadEventId: "event-receipt",
      threadEventSequence: initial.state.lastEventSequence + 1,
      occurredAt: "2026-08-08T00:01:00Z",
      requestedTurns: 1,
    }),
    "replayed",
  );
  const laterState = reduceThreadLifecycleEvent(receipt.state, {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: "event-later-rename",
    sequence: receipt.state.lastEventSequence + 1,
    occurredAt: "2026-08-08T00:02:00Z",
    type: "thread.renamed",
    data: { actorId: "actor-1", title: "later" },
  });
  const store = new RecordingRollbackStore({
    ...initial,
    state: laterState,
    history: [...initial.history, receipt.marker],
  });
  store.receipt = receipt;
  const runtime = recordingRuntime();

  const replay = await rollbackService(
    store,
    new RecordingAuthorization(),
    runtime,
  ).rollbackThread(actor(), {
    kind: "thread.rollback",
    idempotencyKey: "rollback-replay",
    threadId: "thread-1",
    expectedRevision: initial.state.revision,
    numTurns: 1,
  });

  assert.deepEqual(replay, receipt);
  assert.equal(store.historyHeadReads, 0);
  assert.equal(store.historyPageReads, 0);
  assert.equal(store.commits.length, 0);
  assert.deepEqual(runtime.ids.kinds, []);
  assert.equal(runtime.clock.calls, 0);
});

test("accepts a receipt-first replay won by a concurrent commit", async () => {
  const fixture = threadFixture([]);
  const concurrent = rollbackResult(
    fixture,
    createThreadRollbackArtifacts(fixture.history, {
      tenantId: "tenant-1",
      threadId: "thread-1",
      actorId: "actor-1",
      rollbackId: "rollback-concurrent",
      markerItemId: "marker-concurrent",
      threadEventId: "event-concurrent",
      threadEventSequence: 2,
      occurredAt: "2026-08-08T00:09:00Z",
      requestedTurns: 1,
    }),
    "replayed",
  );
  const store = new RecordingRollbackStore(fixture);
  store.concurrentCommitReplay = concurrent;

  const result = await rollbackService(
    store,
    new RecordingAuthorization(),
    recordingRuntime(),
  ).rollbackThread(actor(), {
    kind: "thread.rollback",
    idempotencyKey: "rollback-concurrent",
    threadId: "thread-1",
    expectedRevision: 1,
    numTurns: 1,
  });

  assert.deepEqual(result, concurrent);
  assert.equal(store.commits.length, 1);
});

test("maps an idempotency fingerprint conflict before mutation fences", async () => {
  const fixture = threadFixture([]);
  const store = new RecordingRollbackStore({
    ...fixture,
    state: { ...fixture.state, revision: 99, lastEventSequence: 99 },
  });
  store.receiptError = new RunStoreError("idempotency_conflict");
  const runtime = recordingRuntime();

  await assert.rejects(
    rollbackService(
      store,
      new RecordingAuthorization(),
      runtime,
    ).rollbackThread(actor(), {
      kind: "thread.rollback",
      idempotencyKey: "rollback-conflict",
      threadId: "thread-1",
      expectedRevision: 1,
      numTurns: 2,
    }),
    hasApplicationError("conflict", "idempotency_conflict"),
  );
  assert.match(
    store.receiptQueries[0]!.idempotency.requestFingerprint,
    /"numTurns":2/,
  );
  assert.equal(store.historyHeadReads, 0);
  assert.deepEqual(runtime.ids.kinds, []);
  assert.equal(runtime.clock.calls, 0);
});

test("checks the Thread revision only after an authorized receipt miss", async () => {
  const fixture = threadFixture([]);
  const laterState = reduceThreadLifecycleEvent(fixture.state, {
    schemaVersion: "crewon.thread-event.v0",
    identity: { threadId: "thread-1" },
    eventId: "event-later",
    sequence: 2,
    occurredAt: "2026-08-08T00:03:00Z",
    type: "thread.renamed",
    data: { actorId: "actor-1", title: "later" },
  });
  const store = new RecordingRollbackStore({ ...fixture, state: laterState });
  const runtime = recordingRuntime();

  await assert.rejects(
    rollbackService(
      store,
      new RecordingAuthorization(),
      runtime,
    ).rollbackThread(actor(), {
      kind: "thread.rollback",
      idempotencyKey: "rollback-stale",
      threadId: "thread-1",
      expectedRevision: 1,
      numTurns: 1,
    }),
    hasApplicationError("conflict", "revision_conflict"),
  );
  assert.equal(store.receiptQueries.length, 1);
  assert.equal(store.historyHeadReads, 0);
  assert.deepEqual(runtime.ids.kinds, []);
  assert.equal(runtime.clock.calls, 0);
});

test("denies or fails unavailable authorization before receipt access", async () => {
  for (const authorization of [
    new RecordingAuthorization("deny"),
    new RecordingAuthorization("unavailable"),
  ]) {
    const store = new RecordingRollbackStore(threadFixture([]));
    await assert.rejects(
      rollbackService(store, authorization, recordingRuntime()).rollbackThread(
        actor(),
        {
          kind: "thread.rollback",
          idempotencyKey: `rollback-${authorization.mode}`,
          threadId: "thread-1",
          expectedRevision: 1,
          numTurns: 1,
        },
      ),
      hasApplicationError(
        "authorization",
        authorization.mode === "deny"
          ? "authorization_denied"
          : "authorization_unavailable",
      ),
    );
    assert.equal(store.receiptQueries.length, 0);
    assert.equal(store.historyHeadReads, 0);
    assert.equal(store.commits.length, 0);
  }
});

test("hides cross-space Thread existence before authorization", async () => {
  const fixture = threadFixture([]);
  const store = new RecordingRollbackStore({
    ...fixture,
    state: { ...fixture.state, spaceId: "space-2" },
  });
  const authorization = new RecordingAuthorization();

  await assert.rejects(
    rollbackService(store, authorization, recordingRuntime()).rollbackThread(
      actor(),
      {
        kind: "thread.rollback",
        idempotencyKey: "rollback-hidden",
        threadId: "thread-1",
        expectedRevision: 1,
        numTurns: 1,
      },
    ),
    hasApplicationError("notFound", "thread_not_found"),
  );
  assert.deepEqual(authorization.actions, []);
  assert.equal(store.receiptQueries.length, 0);
});

test("fails closed on a forged replay or corrupt committed effects", async () => {
  const empty = threadFixture([]);
  const artifacts = createThreadRollbackArtifacts(empty.history, {
    tenantId: "tenant-1",
    threadId: "thread-1",
    actorId: "actor-1",
    rollbackId: "rollback-forged",
    markerItemId: "marker-forged",
    threadEventId: "event-forged",
    threadEventSequence: 2,
    occurredAt: "2026-08-08T00:01:00Z",
    requestedTurns: 1,
  });
  const forgedStore = new RecordingRollbackStore(empty);
  const validReplay = rollbackResult(empty, artifacts, "replayed");
  forgedStore.receipt = {
    ...validReplay,
    event: {
      ...validReplay.event,
      data: { ...validReplay.event.data, actorId: "attacker" },
    },
  };
  await assert.rejects(
    rollbackService(
      forgedStore,
      new RecordingAuthorization(),
      recordingRuntime(),
    ).rollbackThread(actor(), {
      kind: "thread.rollback",
      idempotencyKey: "rollback-forged",
      threadId: "thread-1",
      expectedRevision: 1,
      numTurns: 1,
    }),
    hasApplicationError("internal", "thread_rollback_receipt_invalid"),
  );

  const withTurn = threadFixture([
    historyMessage(1, "user", "thread_message", "one"),
    historyMessage(2, "assistant", "assistant_completion", "answer"),
  ]);
  const corruptStore = new RecordingRollbackStore(withTurn);
  corruptStore.corruptCommittedEffects = true;
  await assert.rejects(
    rollbackService(
      corruptStore,
      new RecordingAuthorization(),
      recordingRuntime(),
    ).rollbackThread(actor(), {
      kind: "thread.rollback",
      idempotencyKey: "rollback-corrupt",
      threadId: "thread-1",
      expectedRevision: withTurn.state.revision,
      numTurns: 1,
    }),
    hasApplicationError("internal", "thread_rollback_receipt_invalid"),
  );
  assert.equal(corruptStore.commits.length, 1);
});

class RecordingRollbackStore implements ThreadStore, ThreadRollbackStore {
  readonly commits: CommitThreadRollbackInput[] = [];
  readonly receiptQueries: ThreadRollbackReceiptQuery[] = [];
  historyHeadReads = 0;
  historyPageReads = 0;
  goalMethodsCalled = 0;
  receipt: CommitThreadRollbackResult | null = null;
  concurrentCommitReplay: CommitThreadRollbackResult | null = null;
  receiptError: Error | null = null;
  corruptCommittedEffects = false;
  readonly #fixture: ThreadFixture;

  constructor(fixture: ThreadFixture) {
    this.#fixture = fixture;
  }

  async loadThread(locator: ThreadLocator): Promise<ThreadState | null> {
    return locator.tenantId === this.#fixture.state.tenantId &&
      locator.threadId === this.#fixture.state.threadId
      ? structuredClone(this.#fixture.state)
      : null;
  }

  async listThreads(_query: ThreadListQuery): Promise<readonly ThreadState[]> {
    return [];
  }

  async commitThread(_input: CommitThreadInput): Promise<CommitThreadResult> {
    throw new Error("commitThread is outside this fixture");
  }

  async listThreadEvents(): Promise<readonly ThreadLifecycleEvent[]> {
    return [];
  }

  async listMessages(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly MessageRecord[]> {
    return this.#fixture.messages
      .filter(
        (message) =>
          message.tenantId === locator.tenantId &&
          message.threadId === locator.threadId &&
          message.sequence > afterSequence,
      )
      .slice(0, limit);
  }

  async loadModelHistoryHead(locator: ThreadLocator) {
    this.historyHeadReads += 1;
    return locator.tenantId === this.#fixture.state.tenantId &&
      locator.threadId === this.#fixture.state.threadId
      ? {
          tenantId: locator.tenantId,
          threadId: locator.threadId,
          lastSequence: this.#fixture.history.at(-1)?.sequence ?? 0,
        }
      : null;
  }

  async listModelHistoryItems(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ) {
    this.historyPageReads += 1;
    return this.#fixture.history
      .filter(
        (item) =>
          item.tenantId === locator.tenantId &&
          item.threadId === locator.threadId &&
          item.sequence > afterSequence,
      )
      .slice(0, limit);
  }

  async loadThreadRollbackReceipt(query: ThreadRollbackReceiptQuery) {
    this.receiptQueries.push(structuredClone(query));
    if (this.receiptError !== null) throw this.receiptError;
    return this.receipt === null ? null : structuredClone(this.receipt);
  }

  async commitThreadRollback(input: CommitThreadRollbackInput) {
    this.commits.push(structuredClone(input));
    if (this.concurrentCommitReplay !== null) {
      return structuredClone(this.concurrentCommitReplay);
    }
    const artifacts = {
      boundary: {
        requestedTurns: input.event.data.requestedTurns,
        removedTurns: input.event.data.removedTurns,
        historyFromSequence: input.event.data.historyFromSequence,
        historyThroughSequence: input.event.data.historyThroughSequence,
        markerHistorySequence: input.event.data.markerHistorySequence,
      },
      event: input.event,
      marker: input.marker,
    };
    const result = rollbackResult(this.#fixture, artifacts, "committed");
    return this.corruptCommittedEffects
      ? { ...result, invalidatedMessages: [] }
      : result;
  }
}

class RecordingAuthorization implements AuthorizationPort {
  readonly actions: string[] = [];
  readonly mode: "allow" | "deny" | "unavailable";

  constructor(mode: "allow" | "deny" | "unavailable" = "allow") {
    this.mode = mode;
  }

  async authorize(request: Parameters<AuthorizationPort["authorize"]>[0]) {
    this.actions.push(request.action);
    if (this.mode === "unavailable") throw new Error("policy unavailable");
    return this.mode === "deny"
      ? ({ outcome: "deny", reasonCode: "forbidden" } as const)
      : ({ outcome: "allow" } as const);
  }
}

class RecordingIds implements ApplicationIdGenerator {
  readonly kinds: ApplicationIdKind[] = [];

  nextId(kind: ApplicationIdKind): string {
    this.kinds.push(kind);
    return `${kind}-${this.kinds.length}`;
  }
}

class RecordingClock implements ApplicationClock {
  calls = 0;

  now(): string {
    this.calls += 1;
    return "2026-08-08T00:10:00Z";
  }
}

type ThreadFixture = Readonly<{
  state: ThreadState;
  history: readonly ModelHistoryItem[];
  messages: readonly MessageRecord[];
}>;

function threadFixture(history: readonly ModelHistoryItem[]): ThreadFixture {
  let state = reduceThreadLifecycleEvent(null, {
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
      title: null,
    },
  });
  const messageItems = history.filter(isMessageBackedHistoryItem);
  const messages = messageItems.map((item, index): MessageRecord => {
    const message = {
      messageId: `message-${index + 1}`,
      tenantId: item.tenantId,
      threadId: item.threadId,
      sequence: index + 1,
      role: item.role,
      content: item.content,
      contentDigest: item.contentDigest,
      createdAt: item.createdAt,
      proposedPlan: null,
    };
    state = reduceThreadLifecycleEvent(state, {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: state.threadId },
      eventId: `thread-message-${index + 1}`,
      sequence: state.lastEventSequence + 1,
      occurredAt: message.createdAt,
      type: "thread.message.appended",
      data: {
        messageId: message.messageId,
        messageSequence: message.sequence,
        role: message.role,
        contentDigest: message.contentDigest,
      },
    });
    return message;
  });
  return { state, history, messages };
}

function rollbackResult(
  fixture: ThreadFixture,
  artifacts: ReturnType<typeof createThreadRollbackArtifacts>,
  disposition: CommitThreadRollbackResult["disposition"],
): CommitThreadRollbackResult {
  return {
    disposition,
    state: reduceThreadLifecycleEvent(fixture.state, artifacts.event),
    event: artifacts.event,
    marker: artifacts.marker,
    invalidatedMessages: invalidatedMessages(fixture, artifacts),
    invalidatedContinuationCount: 2,
    invalidatedModelState: true,
  };
}

function invalidatedMessages(
  fixture: ThreadFixture,
  artifacts: ReturnType<typeof createThreadRollbackArtifacts>,
): CommitThreadRollbackResult["invalidatedMessages"] {
  const fromSequence = artifacts.marker.historyFromSequence;
  if (fromSequence === null) return [];
  const effectiveTargets = new Set(
    projectEffectiveModelHistory(fixture.history)
      .items.filter(
        (item) =>
          isMessageBackedHistoryItem(item) &&
          item.sequence >= fromSequence &&
          item.sequence <= artifacts.marker.historyThroughSequence,
      )
      .map(({ sequence }) => sequence),
  );
  const historyMessages = fixture.history.filter(isMessageBackedHistoryItem);
  return historyMessages.flatMap((item, index) => {
    const message = fixture.messages[index]!;
    return effectiveTargets.has(item.sequence)
      ? [
          {
            messageId: message.messageId,
            messageSequence: message.sequence,
            invalidation: {
              rollbackId: artifacts.marker.rollbackId,
              markerItemId: artifacts.marker.itemId,
              historySequence: item.sequence,
              invalidatedAt: artifacts.event.occurredAt,
            },
          },
        ]
      : [];
  });
}

function historyMessage(
  sequence: number,
  role: "user" | "assistant",
  source: "thread_message" | "assistant_completion" | "goal_continuation",
  content: string,
): Extract<ModelHistoryItem, { type: "message" }> {
  return {
    schemaVersion: "crewon.model-history-item.v0",
    type: "message",
    itemId: `history-${sequence}`,
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence,
    runId: null,
    segmentId: null,
    createdAt: `2026-08-08T00:00:${sequence.toString().padStart(2, "0")}Z`,
    role,
    source,
    content,
    contentDigest: `sha256:${"a".repeat(64)}`,
  };
}

function isMessageBackedHistoryItem(
  item: ModelHistoryItem,
): item is Extract<ModelHistoryItem, { type: "message" }> &
  Readonly<{ source: "thread_message" | "assistant_completion" }> {
  return (
    item.type === "message" &&
    (item.source === "thread_message" || item.source === "assistant_completion")
  );
}

function rollbackService(
  store: RecordingRollbackStore,
  authorization: AuthorizationPort,
  runtime: ReturnType<typeof recordingRuntime>,
): ThreadRollbackApplicationService {
  return new ThreadRollbackApplicationService({
    store,
    authorization,
    ids: runtime.ids,
    clock: runtime.clock,
  });
}

function recordingRuntime() {
  return { ids: new RecordingIds(), clock: new RecordingClock() };
}

function actor() {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  } as const;
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
