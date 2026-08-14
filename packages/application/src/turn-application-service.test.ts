import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_THREAD_GOAL_TOKEN_BUDGET,
  reduceRunLifecycleEvent,
  reduceThreadLifecycleEvent,
  type ThreadState,
  type KnowledgeRecord,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationIdGenerator,
  ApplicationIdKind,
} from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type { ModelHistoryStore } from "./model-history-store-port.ts";
import type { ThreadStore } from "./thread-store-port.ts";
import type { ThreadGoalStore } from "./thread-goal-store-port.ts";
import { TurnApplicationService } from "./turn-application-service.ts";
import type {
  CommitTurnStartInput,
  CommitTurnStartResult,
  TurnStartReceiptQuery,
  TurnStartStore,
} from "./turn-start-store-port.ts";

test("authorizes and prepares one atomic Message, history item, Run and queue handoff", async () => {
  const store = new RecordingTurnStore();
  const authorization = new RecordingAuthorization();
  const service = createService(store, authorization);

  const result = await service.startTurn(actor(), command());

  assert.equal(result.disposition, "committed");
  assert.equal(result.threadState.revision, 2);
  assert.equal(result.runState.status, "queued");
  assert.deepEqual(
    authorization.requests.map(({ action, resource }) => ({
      action,
      resource,
    })),
    [
      {
        action: "thread:message:append",
        resource: {
          kind: "thread",
          tenantId: "tenant-1",
          spaceId: "space-1",
          threadId: "thread-1",
        },
      },
      {
        action: "run:create",
        resource: {
          kind: "run",
          tenantId: "tenant-1",
          spaceId: "space-1",
          threadId: "thread-1",
          runId: null,
        },
      },
    ],
  );
  const committed = store.commits[0]!;
  assert.equal(committed.thread.messages[0]?.content, "do the work");
  const historyItem = committed.thread.history.items[0];
  assert.ok(historyItem?.type === "message");
  assert.equal(historyItem.role, "user");
  assert.equal(committed.run.events[0]?.type, "run.created");
  assert.equal(committed.run.outbox.length, 1);
  assert.equal(committed.run.workItems.length, 1);
});

test("freezes authorized Knowledge before the user message in the atomic Turn", async () => {
  const store = new RecordingTurnStore();
  const authorization = new RecordingAuthorization();

  await createService(store, authorization).startTurn(actor(), {
    ...command(),
    knowledgeReferences: [knowledgeReference()],
  });

  assert.equal(store.knowledgeReads, 1);
  assert.deepEqual(
    authorization.requests.map(({ action }) => action),
    ["thread:message:append", "run:create", "knowledge:read"],
  );
  assert.deepEqual(store.commits[0]?.thread.history.items, [
    {
      schemaVersion: "crewon.model-history-item.v0",
      itemId: "modelHistoryItem-1",
      tenantId: "tenant-1",
      threadId: "thread-1",
      sequence: 1,
      runId: null,
      segmentId: null,
      createdAt: "2026-08-09T00:00:01Z",
      type: "message",
      role: "user",
      source: "knowledge_context",
      content: "durable reference",
      contentDigest: `sha256:${"a".repeat(64)}`,
      knowledge: {
        schemaVersion: "crewon.knowledge-context.v0",
        knowledgeId: "knowledge-1",
        kind: "source",
        sourceId: "source-1",
        title: "Reference",
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
    },
    {
      schemaVersion: "crewon.model-history-item.v0",
      itemId: "modelHistoryItem-2",
      tenantId: "tenant-1",
      threadId: "thread-1",
      sequence: 2,
      runId: null,
      segmentId: null,
      createdAt: "2026-08-09T00:00:01Z",
      type: "message",
      role: "user",
      source: "thread_message",
      content: "do the work",
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
  ]);
});

test("replays a Knowledge-bound Turn without re-reading Knowledge", async () => {
  const store = new RecordingTurnStore();
  const request = {
    ...command(),
    knowledgeReferences: [knowledgeReference()],
  };
  const service = createService(store);
  await service.startTurn(actor(), request);
  const readsAfterCommit = store.knowledgeReads;
  const { route: _route, ...replayCommand } = request;

  const replay = await service.replayTurn(actor(), replayCommand);

  assert.equal(replay?.disposition, "replayed");
  assert.equal(store.knowledgeReads, readsAfterCommit);
});

test("rejects duplicate Knowledge IDs before authorization or Store access", async () => {
  const store = new RecordingTurnStore();
  const authorization = new RecordingAuthorization();

  await assert.rejects(
    createService(store, authorization).startTurn(actor(), {
      ...command(),
      knowledgeReferences: [knowledgeReference(), knowledgeReference()],
    }),
    hasApplicationError("validation", "knowledge_reference_invalid"),
  );
  assert.deepEqual(authorization.requests, []);
  assert.equal(store.knowledgeReads, 0);
  assert.deepEqual(store.commits, []);
});

test("rejects Knowledge digest drift before the atomic Turn write", async () => {
  const store = new RecordingTurnStore();

  await assert.rejects(
    createService(store).startTurn(actor(), {
      ...command(),
      knowledgeReferences: [
        {
          ...knowledgeReference(),
          contentDigest: `sha256:${"b".repeat(64)}`,
        },
      ],
    }),
    hasApplicationError("conflict", "knowledge_reference_stale"),
  );
  assert.equal(store.knowledgeReads, 1);
  assert.deepEqual(store.commits, []);
});

test("keeps the idempotency fingerprint stable across a changed derived route", async () => {
  const firstStore = new RecordingTurnStore();
  const secondStore = new RecordingTurnStore();
  await createService(firstStore).startTurn(actor(), command());
  await createService(secondStore).startTurn(actor(), {
    ...command(),
    route: {
      ...command().route,
      authorityId: "authority-after-release-change",
      agentVersionId: "resolved-version-after-release-change",
    },
  });

  assert.equal(
    firstStore.commits[0]?.idempotency.requestFingerprint,
    secondStore.commits[0]?.idempotency.requestFingerprint,
  );
  assert.equal(
    firstStore.commits[0]?.idempotency.requestFingerprint.includes(
      "authority-after-release-change",
    ),
    false,
  );
});

test("applies a finite server safety budget to a newly admitted Goal", async () => {
  const store = new RecordingTurnStore();
  await createService(store).startTurn(actor(), {
    ...command(),
    executionIntent: "goal",
  });

  const mutation = store.commits[0]?.goal;
  assert.equal(mutation?.kind, "set");
  if (mutation?.kind !== "set") assert.fail("expected Goal creation");
  assert.equal(mutation.goal.tokenBudget, DEFAULT_THREAD_GOAL_TOKEN_BUDGET);
});

test("returns an authorized receipt replay without preparing another Run", async () => {
  const store = new RecordingTurnStore();
  await createService(store).startTurn(actor(), command());
  const authorization = new RecordingAuthorization();
  const replay = await createService(store, authorization).replayTurn(
    actor(),
    requestCommand(),
  );

  assert.ok(replay !== null);
  assert.equal(replay.disposition, "replayed");
  assert.equal(store.commits.length, 1);
  assert.deepEqual(
    authorization.requests.map(({ action }) => action),
    ["thread:message:append", "run:create"],
  );
});

test("fails closed before Store mutation when either authorization is denied", async () => {
  const store = new RecordingTurnStore();
  const authorization = new RecordingAuthorization("run:create");
  const service = createService(store, authorization);

  await assert.rejects(
    service.startTurn(actor(), command()),
    (error) =>
      error instanceof ApplicationError &&
      error.category === "authorization" &&
      error.code === "authorization_denied",
  );
  assert.equal(store.commits.length, 0);
});

test("rejects an explicit AgentVersion that does not match the admitted route", async () => {
  const store = new RecordingTurnStore();
  const service = createService(store);

  await assert.rejects(
    service.startTurn(actor(), {
      ...command(),
      requestedAgentVersionId: "requested-version",
    }),
    (error) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.code === "agent_version_selection_mismatch",
  );
  assert.equal(store.commits.length, 0);
});

test("hides a tombstoned Thread before authorization, receipt lookup or Turn writes", async () => {
  const store = new RecordingTurnStore({
    ...threadState(),
    status: "deleted",
    title: null,
    deletedAt: "2026-08-09T00:00:02Z",
    deletedByActorId: "actor-1",
  });
  const authorization = new RecordingAuthorization();
  const service = createService(store, authorization);

  await assert.rejects(
    service.startTurn(actor(), command()),
    hasApplicationError("notFound", "thread_not_found"),
  );
  await assert.rejects(
    service.replayTurn(actor(), requestCommand()),
    hasApplicationError("notFound", "thread_not_found"),
  );
  assert.deepEqual(authorization.requests, []);
  assert.equal(store.receiptReads, 0);
  assert.deepEqual(store.commits, []);
});

function createService(
  store: RecordingTurnStore,
  authorization: AuthorizationPort = new RecordingAuthorization(),
) {
  return new TurnApplicationService({
    store,
    knowledge: store,
    authorization,
    clock: { now: () => "2026-08-09T00:00:01Z" },
    ids: new IncrementingIds(),
    digester: { sha256: () => `sha256:${"a".repeat(64)}` },
  });
}

function actor(): ActorContext {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
}

function command() {
  return {
    kind: "turn.start" as const,
    idempotencyKey: "turn-key-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    content: "do the work",
    knowledgeReferences: [],
    requestedAgentVersionId: null,
    executionIntent: "none" as const,
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
  };
}

function requestCommand() {
  const { route: _route, ...request } = command();
  return request;
}

class RecordingAuthorization implements AuthorizationPort {
  readonly requests: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  readonly #deniedAction:
    | Parameters<AuthorizationPort["authorize"]>[0]["action"]
    | null;

  constructor(
    deniedAction:
      | Parameters<AuthorizationPort["authorize"]>[0]["action"]
      | null = null,
  ) {
    this.#deniedAction = deniedAction;
  }

  async authorize(request: Parameters<AuthorizationPort["authorize"]>[0]) {
    this.requests.push(structuredClone(request));
    return request.action === this.#deniedAction
      ? ({ outcome: "deny", reasonCode: "denied" } as const)
      : ({ outcome: "allow" } as const);
  }
}

class IncrementingIds implements ApplicationIdGenerator {
  readonly #counts = new Map<ApplicationIdKind, number>();

  nextId(kind: ApplicationIdKind): string {
    const next = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, next);
    return `${kind}-${next}`;
  }
}

class RecordingTurnStore
  implements ThreadStore, ThreadGoalStore, ModelHistoryStore, TurnStartStore
{
  readonly commits: CommitTurnStartInput[] = [];
  readonly #thread: ThreadState;
  receiptReads = 0;
  knowledgeReads = 0;
  #result: CommitTurnStartResult | null = null;

  constructor(thread: ThreadState = threadState()) {
    this.#thread = thread;
  }

  async loadThread() {
    return structuredClone(this.#thread);
  }

  async listThreads() {
    return [structuredClone(this.#thread)];
  }

  async loadThreadGoal() {
    return null;
  }

  async commitThread(): Promise<never> {
    throw new Error("not used");
  }

  async listThreadEvents() {
    return [];
  }

  async listMessages() {
    return [];
  }

  async loadModelHistoryHead() {
    return { tenantId: "tenant-1", threadId: "thread-1", lastSequence: 0 };
  }

  async listModelHistoryItems() {
    return [];
  }

  async loadKnowledge({ knowledgeId }: { knowledgeId: string }) {
    this.knowledgeReads += 1;
    return knowledgeId === "knowledge-1" ? knowledgeRecord() : null;
  }

  async loadTurnStartReceipt(
    query: TurnStartReceiptQuery,
  ): Promise<CommitTurnStartResult | null> {
    this.receiptReads += 1;
    const input = this.commits[0];
    if (input === undefined || this.#result === null) return null;
    if (
      query.tenantId !== input.tenantId ||
      query.threadId !== this.#result.threadState.threadId ||
      query.idempotency.scope !== input.idempotency.scope ||
      query.idempotency.key !== input.idempotency.key ||
      query.idempotency.requestFingerprint !==
        input.idempotency.requestFingerprint
    ) {
      return null;
    }
    return { ...structuredClone(this.#result), disposition: "replayed" };
  }

  async commitTurnStart(
    input: CommitTurnStartInput,
  ): Promise<CommitTurnStartResult> {
    this.commits.push(structuredClone(input));
    let nextThread: ThreadState | null = this.#thread;
    for (const event of input.thread.events) {
      nextThread = reduceThreadLifecycleEvent(nextThread, event);
    }
    let nextRun = null;
    for (const event of input.run.events) {
      nextRun = reduceRunLifecycleEvent(nextRun, event);
    }
    assert.ok(nextThread !== null);
    assert.ok(nextRun !== null);
    const result: CommitTurnStartResult = {
      disposition: "committed",
      threadState: nextThread,
      runState: nextRun,
      goalState: input.goal.kind === "set" ? input.goal.goal : null,
      threadEvents: input.thread.events,
      messages: input.thread.messages,
      historyItems: input.thread.history.items,
      runEvents: input.run.events,
      outbox: input.run.outbox,
      workItems: input.run.workItems,
    };
    this.#result = structuredClone(result);
    return result;
  }
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

function threadState(): ThreadState {
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
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
    archivedAt: null,
    deletedAt: null,
    deletedByActorId: null,
  };
}

function knowledgeRecord(): KnowledgeRecord {
  return {
    schemaVersion: "crewon.knowledge.v0",
    knowledgeId: "knowledge-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    ownerActorId: "actor-1",
    kind: "source",
    sourceId: "source-1",
    title: "Reference",
    content: "durable reference",
    contentDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-09T00:00:00.000Z",
  };
}

function knowledgeReference() {
  return {
    knowledgeId: "knowledge-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
  };
}
