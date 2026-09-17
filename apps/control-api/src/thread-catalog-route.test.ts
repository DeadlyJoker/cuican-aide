import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  ThreadApplicationService,
  type ThreadListQuery,
} from "@crewon/application";
import { InMemoryRunStore } from "@crewon/store";
import { ControlApiClient } from "@crewon/control-client";
import {
  ContractValidationError,
  type ThreadCatalogRequest,
} from "@crewon/contracts";
import { registerThreadCatalogRoute } from "./thread-catalog-route.ts";

const actor = {
  principalId: "p",
  actorId: "actor",
  tenantId: "tenant",
  spaceId: "space",
};

async function fixture(context: TestContext) {
  const store = new InMemoryRunStore();
  let next = 0;
  const threads = new ThreadApplicationService({
    store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-09-11T00:00:00.000Z" },
    ids: { nextId: (kind) => `${kind}-${String(++next).padStart(6, "0")}` },
    digester: {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
  });
  const reads: ThreadListQuery[] = [];
  let messageReads = 0;
  const listThreads = store.listThreads.bind(store);
  store.listThreads = async (query) => {
    reads.push(query);
    return listThreads(query);
  };
  const listMessages = store.listMessages.bind(store);
  store.listMessages = async (...args) => {
    messageReads++;
    return listMessages(...args);
  };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof ContractValidationError ? 400 : 500)
      .send({ code: error instanceof Error ? error.message : "unknown_error" }),
  );
  registerThreadCatalogRoute(app, {
    threads,
    identity: { resolveActor: async () => actor },
  });
  await app.ready();
  context.after(async () => {
    await app.close();
    await store.close();
  });
  const client = new ControlApiClient({
    baseUrl: "http://catalog.test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const response = await app.inject({
        method: "GET",
        url: `${url.pathname}${url.search}`,
        headers,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    store,
    threads,
    reads,
    app,
    client,
    messageReads: () => messageReads,
  };
}

test("catalog HTTP/client search reaches beyond 1,000 candidates, preserves empty continuation and limits each read", async (context) => {
  const f = await fixture(context);
  let target = "";
  for (let index = 0; index < 1_205; index++) {
    const created = await f.threads.createThread(actor, {
      kind: "thread.create",
      idempotencyKey: `create-${index}`,
      title: index === 0 ? "缓存 ÉTAT 100%_" : `Task ${index}`,
    });
    if (index === 0) target = created.state.threadId;
  }
  const before = await f.store.loadThread({
    tenantId: actor.tenantId,
    threadId: target,
  });
  const history = await f.store.loadModelHistoryHead({
    tenantId: actor.tenantId,
    threadId: target,
  });
  const query: ThreadCatalogRequest = {
    limit: 100,
    search: "état 100%_",
    excludeForks: true,
  };
  let cursor: string | null = null;
  let requests = 0;
  let scanned = 0;
  const found: string[] = [];
  do {
    const readOffset = f.reads.length;
    const page = await f.client.getThreadCatalog({ ...query, cursor });
    requests++;
    scanned += page.scannedCount;
    assert.ok(f.reads.length - readOffset <= 2);
    assert.ok(
      f.reads.slice(readOffset).reduce((sum, read) => sum + read.limit, 0) <=
        101,
    );
    assert.equal(f.messageReads(), 0);
    if (requests <= 12) assert.deepEqual(page.data, []);
    found.push(...page.data.map((thread) => thread.threadId));
    cursor = page.olderCursor;
    if (cursor === null) {
      assert.ok(page.newerCursor);
      const previous = await f.client.getThreadCatalog({
        ...query,
        cursor: page.newerCursor,
      });
      assert.deepEqual(previous.data, []);
      assert.ok(previous.olderCursor);
      const back = await f.client.getThreadCatalog({
        ...query,
        cursor: previous.olderCursor,
      });
      assert.deepEqual(
        back.data.map((thread) => thread.threadId),
        [target],
      );
    }
  } while (cursor !== null && requests < 20);
  assert.equal(requests, 13);
  assert.equal(scanned, 1_205);
  assert.deepEqual(found, [target]);
  assert.deepEqual(
    await f.store.loadThread({ tenantId: actor.tenantId, threadId: target }),
    before,
  );
  assert.deepEqual(
    await f.store.loadModelHistoryHead({
      tenantId: actor.tenantId,
      threadId: target,
    }),
    history,
  );
});

test("catalog projects and searches legacy display titles without rewriting history or authoritative titles", async (context) => {
  const f = await fixture(context);
  const { state } = await f.threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "legacy",
    title: null,
  });
  const message = {
    messageId: "message",
    tenantId: actor.tenantId,
    threadId: state.threadId,
    sequence: 1,
    role: "user" as const,
    content: "旧会话 ÉTAT\nsecond line",
    contentDigest: `sha256:${"a".repeat(64)}`,
    createdAt: state.createdAt,
  };
  // Legacy read fixture: the bounded compatibility path, not the modern automatic-title write path.
  f.threads.listThreads = async (_actor, query) =>
    query.before === null && query.after == null
      ? [{ ...state, lastMessageSequence: 1 }]
      : [];
  f.threads.listMessages = async (receivedActor, query) => {
    assert.deepEqual(receivedActor, actor);
    assert.deepEqual(query, {
      threadId: state.threadId,
      afterSequence: 0,
      limit: 16,
    });
    return [message];
  };
  const page = await f.client.getThreadCatalog({ limit: 1, search: "état" });
  assert.equal(page.data[0]?.title, null);
  assert.equal(page.data[0]?.displayTitle, "旧会话 ÉTAT");
  assert.equal(page.olderCursor, null);
  assert.deepEqual(
    await f.store.loadThread({
      tenantId: actor.tenantId,
      threadId: state.threadId,
    }),
    state,
  );
});

test("catalog rejects filter/cursor injection before scanning", async (context) => {
  const f = await fixture(context);
  for (const url of [
    "/api/v1/thread-catalog?tenantId=other",
    "/api/v1/thread-catalog?limit=101",
    "/api/v1/thread-catalog?excludeForks=yes",
    "/api/v1/thread-catalog?cursor=abc",
    "/api/v1/thread-catalog?search=one&search=two",
    "/api/v1/thread-catalog?status=deleted",
  ])
    assert.equal((await f.app.inject({ method: "GET", url })).statusCode, 400);
  assert.deepEqual(f.reads, []);
});
