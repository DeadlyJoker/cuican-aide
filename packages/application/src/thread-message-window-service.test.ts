import assert from "node:assert/strict";
import test from "node:test";
import { reduceThreadLifecycleEvent } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { AuthorizationPort } from "./authorization-port.ts";
import { RunStoreError } from "./run-store-port.ts";
import { ThreadApplicationService } from "./thread-application-service.ts";
import type {
  ThreadMessageWindowQuery,
  ThreadMessageWindowStore,
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
  identity: { threadId: "thread-1" },
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

function fixture(
  options: {
    windows?: ThreadMessageWindowStore;
    authorize?: AuthorizationPort["authorize"];
  } = {},
) {
  const reads: ThreadMessageWindowQuery[] = [];
  const access: unknown[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unexpected_store_read");
  };
  const service = new ThreadApplicationService({
    store: {
      ...(options.windows === undefined
        ? {}
        : {
            messageWindows: {
              readWindow: async (input: ThreadMessageWindowQuery) => {
                reads.push(input);
                return options.windows!.readWindow(input);
              },
            },
          }),
      loadThreadInSpace: async (locator) => {
        access.push(locator);
        return locator.tenantId === thread.tenantId &&
          locator.spaceId === thread.spaceId &&
          locator.threadId === thread.threadId
          ? structuredClone(thread)
          : null;
      },
      loadThread: unused,
      listThreads: unused,
      commitThread: unused,
      listThreadEvents: unused,
      listMessages: unused,
      loadModelHistoryHead: unused,
      listModelHistoryItems: unused,
      loadThreadGoal: unused,
    },
    authorization: {
      authorize: options.authorize ?? (async () => ({ outcome: "allow" })),
    },
    clock: { now: () => "2026-09-11T00:00:00Z" },
    ids: {
      nextId: () => {
        throw new Error("unexpected_id");
      },
    },
    digester: {
      sha256: () => {
        throw new Error("unexpected_digest");
      },
    },
  });
  return { service, reads, access };
}

test("message window rejects malformed input before loading or authorizing a Thread", async () => {
  let authorized = 0;
  const f = fixture({
    authorize: async () => {
      authorized++;
      return { outcome: "allow" };
    },
  });
  for (const input of [
    null,
    [],
    {},
    { ...query, limit: 0 },
    { ...query, limit: 101 },
    { ...query, limit: 1.5 },
    { ...query, limit: Infinity },
    { ...query, view: "audit" },
    { ...query, threadId: " " },
    { ...query, position: {} },
    {
      ...query,
      position: { direction: "older", messageSequence: 1, threadRevision: 0 },
    },
  ]) {
    await assert.rejects(
      f.service.readMessageWindow(actor, input as typeof query),
      (error: unknown) =>
        error instanceof ApplicationError && error.category === "validation",
    );
  }
  assert.deepEqual(f.access, []);
  assert.equal(authorized, 0);
});

test("message window keeps authorization and scope fences ahead of body reads", async () => {
  const windows = {
    readWindow: async () => ({
      thread,
      messages: [],
      hasOlder: false,
      hasNewer: false,
    }),
  };
  const denied = fixture({
    windows,
    authorize: async () => ({ outcome: "deny", reasonCode: "denied" }),
  });
  await assert.rejects(
    denied.service.readMessageWindow(actor, query),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  assert.deepEqual(denied.reads, []);
  const scoped = fixture({ windows });
  await assert.rejects(
    scoped.service.readMessageWindow({ ...actor, spaceId: "other" }, query),
    { code: "thread_not_found" },
  );
  assert.deepEqual(scoped.reads, []);
  await scoped.service.readMessageWindow(actor, query);
  assert.deepEqual(scoped.reads, [
    { tenantId: actor.tenantId, spaceId: actor.spaceId, ...query },
  ]);
});

test("message window freezes pagination position before asynchronous authorization", async () => {
  const input = {
    ...query,
    position: {
      direction: "older" as const,
      messageSequence: 3,
      threadRevision: 2,
    },
  };
  const f = fixture({
    authorize: async () => {
      input.position.messageSequence = 999;
      input.position.threadRevision = 99;
      input.limit = 1;
      return { outcome: "allow" };
    },
    windows: {
      readWindow: async () => ({
        thread,
        messages: [],
        hasOlder: false,
        hasNewer: false,
      }),
    },
  });
  await f.service.readMessageWindow(actor, input);
  assert.deepEqual(f.reads[0], {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    ...query,
    position: { direction: "older", messageSequence: 3, threadRevision: 2 },
  });
});

test("message window reports unsupported adapters and concurrent authority changes explicitly", async () => {
  await assert.rejects(fixture().service.readMessageWindow(actor, query), {
    category: "internal",
    code: "message_window_store_unavailable",
  });
  for (const [code, category] of [
    ["thread_message_window_changed", "conflict"],
    ["thread_not_found", "notFound"],
  ]) {
    const f = fixture({
      windows: {
        readWindow: async () => {
          throw new RunStoreError(code!);
        },
      },
    });
    await assert.rejects(f.service.readMessageWindow(actor, query), {
      category,
      code,
    });
  }
});
