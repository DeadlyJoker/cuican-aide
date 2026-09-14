import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  ThreadApplicationService,
  type ApplicationIdKind,
} from "@crewon/application";
import { InMemoryRunStore } from "@crewon/store";
import {
  parseThreadMessageWindowResponse,
  type GetThreadMessageWindowResponse,
} from "@crewon/contracts";
import { registerThreadMessageWindowRoute } from "./thread-message-window-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import {
  NodeSha256ContentDigester,
  StandaloneAuthorization,
  StandaloneIdentity,
} from "./standalone-adapters.ts";

const actor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};
const sessionToken = "window-session-token-with-32-bytes-minimum";
const origin = "http://127.0.0.1:5175";
const headers = { authorization: `Bearer ${sessionToken}`, origin };

test("message-window HTTP cursor roundtrips, scopes identity and rejects an append-raced cursor", async (context) => {
  const fixture = await setup(context);
  const latestResponse = await fixture.get("?limit=2");
  assert.equal(latestResponse.statusCode, 200, latestResponse.body);
  const latest = latestResponse.json<GetThreadMessageWindowResponse>();
  assert.deepEqual(
    latest.data.map((message) => message.sequence),
    [3, 4],
  );
  assert.equal(latest.newerCursor, null);
  assert.ok(latest.olderCursor);
  assert.deepEqual(
    parseThreadMessageWindowResponse(latest, fixture.threadId, {
      position: null,
      limit: 2,
    }),
    latest,
  );
  const olderResponse = await fixture.get(
    `?limit=2&cursor=${latest.olderCursor}`,
  );
  const older = olderResponse.json<GetThreadMessageWindowResponse>();
  assert.equal(olderResponse.statusCode, 200, olderResponse.body);
  assert.deepEqual(
    older.data.map((message) => message.sequence),
    [1, 2],
  );
  assert.equal(older.olderCursor, null);
  assert.ok(older.newerCursor);
  const forward = await fixture.get(`?limit=2&cursor=${older.newerCursor}`);
  assert.deepEqual(forward.json(), latest);
  await fixture.append();
  const conflict = await fixture.get(`?cursor=${latest.olderCursor}`);
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().error.code, "thread_message_window_changed");
  assert.deepEqual(
    (await fixture.get("?limit=2"))
      .json<GetThreadMessageWindowResponse>()
      .data.map((message) => message.sequence),
    [4, 5],
  );
});

test("message-window HTTP preserves authentication, authorization and strict query validation", async (context) => {
  const fixture = await setup(context);
  assert.equal(
    (await fixture.app.inject({ method: "GET", url: fixture.url })).statusCode,
    401,
  );
  assert.equal(
    (
      await fixture.app.inject({
        method: "GET",
        url: fixture.url,
        headers: { ...headers, origin: "https://wrong.example" },
      })
    ).statusCode,
    403,
  );
  for (const suffix of [
    "?limit=101",
    "?limit=0",
    "?view=audit",
    "?cursor=invalid",
    "?unexpected=true",
  ]) {
    assert.equal((await fixture.get(suffix)).statusCode, 400, suffix);
  }
  const own = (
    await fixture.get("?limit=1")
  ).json<GetThreadMessageWindowResponse>();
  const other = await fixture.threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "another-thread",
    title: "Another",
  });
  const wrongCursor = await fixture.app.inject({
    method: "GET",
    url: `/api/v1/threads/${other.state.threadId}/message-window?cursor=${own.olderCursor}`,
    headers,
  });
  assert.equal(wrongCursor.statusCode, 400);
  const foreignService = new ThreadApplicationService({
    store: fixture.store,
    authorization: new StandaloneAuthorization({ ...actor, spaceId: "other" }),
    clock: { now: () => "2026-09-10T00:00:00Z" },
    ids: { nextId: () => "foreign-id" },
    digester: new NodeSha256ContentDigester(),
  });
  const foreign = await foreignService.createThread(
    { ...actor, spaceId: "other" },
    {
      kind: "thread.create",
      idempotencyKey: "foreign-thread",
      title: "Private",
    },
  );
  const wrongSpace = await fixture.app.inject({
    method: "GET",
    url: `/api/v1/threads/${foreign.state.threadId}/message-window`,
    headers,
  });
  assert.equal(wrongSpace.statusCode, 404);
  assert.equal(wrongSpace.body.includes("Private"), false);
});

async function setup(context: TestContext) {
  const store = new InMemoryRunStore();
  let next = 0;
  const threads = new ThreadApplicationService({
    store,
    authorization: new StandaloneAuthorization(actor),
    clock: { now: () => "2026-09-10T00:00:00Z" },
    ids: { nextId: (kind: ApplicationIdKind) => `${kind}-${++next}` },
    digester: new NodeSha256ContentDigester(),
  });
  const created = await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "create",
    title: "Window",
  });
  const threadId = created.state.threadId;
  let revision = created.state.revision;
  const append = async () => {
    const result = await threads.appendMessage(actor, {
      kind: "thread.message.append",
      idempotencyKey: `append-${revision}`,
      threadId,
      expectedRevision: revision,
      role: "user",
      content: `message ${revision}`,
    });
    revision = result.state.revision;
  };
  for (let index = 0; index < 4; index++) await append();
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    return reply.code(result.statusCode).send(result.body);
  });
  registerThreadMessageWindowRoute(app, {
    threads,
    identity: new StandaloneIdentity({
      actor,
      sessionToken,
      csrfToken: sessionToken,
      allowedOrigins: [origin],
    }),
  });
  context.after(async () => {
    await app.close();
    await store.close();
  });
  const url = `/api/v1/threads/${threadId}/message-window`;
  return {
    store,
    threads,
    threadId,
    app,
    append,
    url,
    get: (suffix: string) =>
      app.inject({ method: "GET", url: url + suffix, headers }),
  };
}
