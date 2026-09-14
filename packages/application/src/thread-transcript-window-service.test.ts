import assert from "node:assert/strict";
import test from "node:test";
import { reduceThreadLifecycleEvent } from "@crewon/domain";
import type { AuthorizationPort } from "./authorization-port.ts";
import { RunStoreError } from "./run-store-port.ts";
import { ThreadApplicationService } from "./thread-application-service.ts";
import type {
  ThreadMessageWindow,
  ThreadMessageWindowQuery,
} from "./thread-message-window-store-port.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const query = { threadId: "thread-1", position: null, limit: 100 };
const thread = reduceThreadLifecycleEvent(null, {
  schemaVersion: "crewon.thread-event.v0",
  identity: { threadId: query.threadId },
  eventId: "event-1",
  sequence: 1,
  occurredAt: "2026-09-11T00:00:00Z",
  type: "thread.created",
  data: {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    createdByActorId: actor.actorId,
    title: null,
  },
});
const messages = ["user", "assistant", "user", "user"].map((role, index) => ({
  tenantId: actor.tenantId,
  threadId: query.threadId,
  messageId: `message-${index + 1}`,
  sequence: index + 1,
  role: role as "user" | "assistant",
  content: "hello",
  contentDigest: "sha256:hello",
  createdAt: thread.createdAt,
  origin: null,
  proposedPlan: null,
}));
const window: ThreadMessageWindow = {
  thread,
  messages,
  hasOlder: false,
  hasNewer: false,
  runBindings: [
    { messageId: "message-1", runId: "run-1", source: "turnStartReceipt" },
    { messageId: "message-2", runId: "run-1", source: "messageCompletedEvent" },
    { messageId: "message-3", runId: "run-2", source: "turnStartReceipt" },
    { messageId: "message-4", runId: null, source: "unassociated" },
  ],
};

function fixture(
  options: {
    window?: ThreadMessageWindow;
    unsupported?: boolean;
    storeError?: Error;
    authorize?: AuthorizationPort["authorize"];
  } = {},
) {
  const reads: ThreadMessageWindowQuery[] = [];
  const access: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  const forbidden = async (): Promise<never> => {
    throw new Error("unexpected_full_history_read");
  };
  const store: ConstructorParameters<
    typeof ThreadApplicationService
  >[0]["store"] = {
    ...(options.unsupported
      ? {}
      : {
          messageWindows: {
            readWindow: async (input: ThreadMessageWindowQuery) => {
              reads.push(input);
              if (options.storeError) throw options.storeError;
              return options.window ?? structuredClone(window);
            },
          },
        }),
    loadThreadInSpace: async () => structuredClone(thread),
    loadThread: forbidden,
    listThreads: forbidden,
    commitThread: forbidden,
    listThreadEvents: forbidden,
    listMessages: forbidden,
    loadModelHistoryHead: forbidden,
    listModelHistoryItems: forbidden,
    loadThreadGoal: forbidden,
  };
  const service = new ThreadApplicationService({
    store,
    authorization: {
      authorize: async (input) => {
        access.push(input);
        return options.authorize?.(input) ?? { outcome: "allow" };
      },
    },
    clock: { now: () => thread.createdAt },
    ids: {
      nextId: () => {
        throw new Error("unexpected_write");
      },
    },
    digester: {
      sha256: () => {
        throw new Error("unexpected_write");
      },
    },
  });
  return { service, reads, access };
}

test("transcript authorizes each distinct Run once and keeps legacy absence explicit without loading history", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.readTranscriptWindow(actor, query), window);
  assert.deepEqual(f.reads, [
    {
      ...query,
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      view: "transcript",
    },
  ]);
  assert.deepEqual(
    f.access.map(({ action, resource }) => [
      action,
      resource.kind === "run"
        ? resource.runId
        : resource.kind === "thread"
          ? resource.threadId
          : null,
    ]),
    [
      ["thread:read", "thread-1"],
      ["run:read", "run-1"],
      ["run:read", "run-2"],
    ],
  );
});

test("transcript rejects missing, misplaced and wrong-scope or wrong-role evidence before Run authorization", async () => {
  const malformed: ThreadMessageWindow[] = [
    { ...window, runBindings: undefined },
    { ...window, runBindings: [] },
    { ...window, thread: { ...thread, spaceId: "other" } },
    {
      ...window,
      messages: [{ ...messages[0]!, tenantId: "other" }, ...messages.slice(1)],
    },
    {
      ...window,
      messages: [{ ...messages[0]!, threadId: "other" }, ...messages.slice(1)],
    },
    ...[
      { messageId: "message-2" },
      { source: "messageCompletedEvent" },
      { source: "unassociated" },
      { runId: null },
      { runId: "run\nunsafe" },
    ].map(
      (patch) =>
        ({
          ...window,
          runBindings: [
            { ...window.runBindings![0], ...patch },
            ...window.runBindings!.slice(1),
          ],
        }) as ThreadMessageWindow,
    ),
  ];
  for (const value of malformed) {
    const f = fixture({ window: value });
    await assert.rejects(f.service.readTranscriptWindow(actor, query), {
      code: "thread_transcript_window_invalid",
    });
    assert.deepEqual(
      f.access.map(({ action }) => action),
      ["thread:read"],
    );
  }
});

test("transcript fails closed on denied and unavailable Run authorization without a partial response", async () => {
  for (const mode of ["deny", "unavailable"] as const) {
    const f = fixture({
      authorize: async ({ action }) => {
        if (action !== "run:read") return { outcome: "allow" };
        if (mode === "unavailable") throw new Error("authority_offline");
        return { outcome: "deny", reasonCode: "fixture_denied" };
      },
    });
    await assert.rejects(f.service.readTranscriptWindow(actor, query), {
      category: "authorization",
      code:
        mode === "deny" ? "authorization_denied" : "authorization_unavailable",
    });
    assert.equal(f.reads.length, 1);
  }
  const deniedThread = fixture({
    authorize: async () => ({ outcome: "deny", reasonCode: "fixture_denied" }),
  });
  await assert.rejects(
    deniedThread.service.readTranscriptWindow(actor, query),
    { category: "authorization" },
  );
  assert.equal(deniedThread.reads.length, 0);
});

test("transcript preserves explicit unsupported, stale, hidden and unavailable Store outcomes", async () => {
  await assert.rejects(
    fixture({ unsupported: true }).service.readTranscriptWindow(actor, query),
    { code: "message_window_store_unavailable" },
  );
  for (const [storeError, category, code] of [
    [
      new RunStoreError("thread_message_window_changed"),
      "conflict",
      "thread_message_window_changed",
    ],
    [new RunStoreError("thread_not_found"), "notFound", "thread_not_found"],
    [
      new RunStoreError("message_run_evidence_ambiguous"),
      "internal",
      "thread_transcript_window_unavailable",
    ],
  ] as const) {
    await assert.rejects(
      fixture({ storeError }).service.readTranscriptWindow(actor, query),
      { category, code },
    );
  }
});

test("transcript validates and freezes its bounded query before asynchronous authorization", async () => {
  const invalid = fixture();
  for (const input of [
    { ...query, limit: 101 },
    { ...query, view: "audit" },
    { ...query, position: {} },
  ]) {
    await assert.rejects(
      invalid.service.readTranscriptWindow(actor, input as typeof query),
      { category: "validation" },
    );
  }
  assert.deepEqual(invalid.access, []);
  assert.deepEqual(invalid.reads, []);
  const input = {
    ...query,
    position: {
      direction: "older" as const,
      messageSequence: 5,
      threadRevision: 1,
    },
  };
  const f = fixture({
    authorize: async () => {
      input.limit = 1;
      input.position.messageSequence = 99;
      return { outcome: "allow" };
    },
  });
  await f.service.readTranscriptWindow(actor, input);
  assert.equal(f.reads[0]!.limit, 100);
  assert.equal(f.reads[0]!.position!.messageSequence, 5);
});
