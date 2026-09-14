import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  RunApplicationService,
  ThreadApplicationService,
  type ApplicationIdKind,
  type AuthorizationPort,
} from "@crewon/application";
import { InMemoryRunStore } from "@crewon/store";
import { parseBrowserExecutionAuthorityResponse } from "@crewon/contracts";
import { registerBrowserExecutionAuthorityRoute } from "./browser-execution-authority-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import {
  StandaloneIdentity,
  StandaloneAuthorization,
  NodeSha256ContentDigester,
} from "./standalone-adapters.ts";

const actor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};
const sessionToken = "browser-control-session-with-32-bytes-minimum";
const origin = "http://crewon.localhost";
const headers = { authorization: `Bearer ${sessionToken}`, origin };

test("C05 authority returns only uncached authenticated Run facts and observes cancellation revisions", async (t) => {
  const f = await fixture(t);
  const initial = await f.app.inject({ method: "GET", url: f.url, headers });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.headers["cache-control"], "no-store");
  const facts = parseBrowserExecutionAuthorityResponse(initial.json(), f.runId);
  assert.deepEqual(facts, {
    schemaVersion: "crewon.browser-execution-authority.v1",
    runId: f.runId,
    threadId: "thread-1",
    workspaceBindingId: "workspace-1",
    status: "queued",
    cancelRequested: false,
    revision: 1,
  });
  assert.equal(initial.body.includes("policy-1"), false);
  assert.equal(initial.body.includes("authority-1"), false);
  assert.equal(initial.body.includes("actor-1"), false);
  assert.equal(f.actions.at(-1), "run:read");
  await f.application.transitionRun(actor, {
    kind: "run.start",
    idempotencyKey: "start",
    runId: f.runId,
    expectedRevision: 1,
  });
  await f.application.transitionRun(actor, {
    kind: "run.requestCancel",
    idempotencyKey: "cancel",
    runId: f.runId,
    expectedRevision: 2,
  });
  const after = (
    await f.app.inject({ method: "GET", url: f.url, headers })
  ).json();
  assert.equal(after.status, "running");
  assert.equal(after.cancelRequested, true);
  assert.equal(after.revision, 3);
});

test("C05 authority rejects unauthenticated, forbidden, cross-space, invalid ID and authority query overrides", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.app.inject({ method: "GET", url: f.url })).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: f.url,
        headers: { ...headers, origin: "https://other.test" },
      })
    ).statusCode,
    403,
  );
  for (const suffix of [
    "?workspaceBindingId=forged",
    "?scope=all",
    "?revision=1",
  ])
    assert.equal(
      (await f.app.inject({ method: "GET", url: f.url + suffix, headers }))
        .statusCode,
      400,
    );
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: "/api/v1/runs/%00/browser-execution-authority",
        headers,
      })
    ).statusCode,
    400,
  );
  f.deny();
  assert.equal(
    (await f.app.inject({ method: "GET", url: f.url, headers })).statusCode,
    403,
  );
  const foreignActor = { ...actor, spaceId: "foreign-space" };
  const foreignThreads = new ThreadApplicationService({
    store: f.store,
    authorization: new StandaloneAuthorization(foreignActor),
    clock: { now: () => "2026-09-14T00:00:00Z" },
    ids: {
      nextId: (kind) =>
        kind === "thread" ? "foreign-thread" : `foreign-thread-${kind}`,
    },
    digester: new NodeSha256ContentDigester(),
  });
  await foreignThreads.createThread(foreignActor, {
    kind: "thread.create",
    idempotencyKey: "foreign-thread",
    title: "Private",
  });
  const foreign = new RunApplicationService({
    store: f.store,
    authorization: new StandaloneAuthorization(foreignActor),
    clock: { now: () => "2026-09-14T00:00:00Z" },
    ids: { nextId: (kind) => `foreign-${kind}` },
  });
  const created = await foreign.createRun(foreignActor, {
    kind: "run.create",
    idempotencyKey: "foreign",
    threadId: "foreign-thread",
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
    },
  });
  const response = await f.app.inject({
    method: "GET",
    url: `/api/v1/runs/${created.state.runId}/browser-execution-authority`,
    headers,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.includes("foreign-thread"), false);
});

async function fixture(t: TestContext) {
  const store = new InMemoryRunStore();
  const actions: string[] = [];
  const standalone = new StandaloneAuthorization(actor);
  const threads = new ThreadApplicationService({
    store,
    authorization: standalone,
    clock: { now: () => "2026-09-14T00:00:00Z" },
    ids: {
      nextId: (kind) => (kind === "thread" ? "thread-1" : `thread-${kind}`),
    },
    digester: new NodeSha256ContentDigester(),
  });
  await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "thread",
    title: "Browser",
  });
  let denied = false;
  const authorization: AuthorizationPort = {
    authorize: async (request) => {
      actions.push(request.action);
      return denied
        ? { outcome: "deny", reasonCode: "revoked" }
        : standalone.authorize(request);
    },
  };
  let id = 0;
  const application = new RunApplicationService({
    store,
    authorization,
    clock: { now: () => "2026-09-14T00:00:00Z" },
    ids: { nextId: (kind: ApplicationIdKind) => `${kind}-${++id}` },
  });
  const created = await application.createRun(actor, {
    kind: "run.create",
    idempotencyKey: "create",
    threadId: "thread-1",
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
  });
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    return reply.code(result.statusCode).send(result.body);
  });
  registerBrowserExecutionAuthorityRoute(app, {
    application,
    identity: new StandaloneIdentity({
      actor,
      sessionToken,
      csrfToken: sessionToken,
      allowedOrigins: [origin],
    }),
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });
  return {
    app,
    store,
    application,
    runId: created.state.runId,
    url: `/api/v1/runs/${created.state.runId}/browser-execution-authority`,
    actions,
    deny: () => {
      denied = true;
    },
  };
}
