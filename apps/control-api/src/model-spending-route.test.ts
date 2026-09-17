import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import {
  ModelSpendingApplicationService,
  ThreadApplicationService,
  ThreadGoalApplicationService,
  type ActorContext,
  type AuthorizationAction,
} from "@crewon/application";
import { InMemoryRunStore } from "@crewon/store";
import { registerModelSpendingRoutes } from "./model-spending-route.ts";
import { errorResponse } from "./control-api-errors.ts";

test("spending HTTP routes enforce real Thread scope, exact money, CAS and explicit activation coverage", async (t) => {
  const store = new InMemoryRunStore(),
    app = Fastify();
  t.after(async () => {
    await app.close();
    await store.close();
  });
  const actor: ActorContext = {
    tenantId: "tenant",
    spaceId: "space",
    actorId: "actor",
    principalId: "principal",
  };
  const actions: AuthorizationAction[] = [];
  let id = 0,
    instant = Date.parse("2026-09-15T00:00:00Z");
  const dependencies = {
    store,
    ids: { nextId: (kind: string) => `${kind}-${++id}` },
    clock: { now: () => new Date((instant += 1000)).toISOString() },
    digester: {
      sha256: (value: string) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
    authorization: {
      authorize: async (request: {
        actor: ActorContext;
        action: AuthorizationAction;
      }) => {
        actions.push(request.action);
        return {
          outcome:
            request.actor.principalId === "denied"
              ? ("deny" as const)
              : ("allow" as const),
          reasonCode: "fixture_authorization",
        };
      },
    },
  };
  const thread = (
    await new ThreadApplicationService(dependencies).createThread(actor, {
      kind: "thread.create",
      idempotencyKey: "thread",
      title: null,
    })
  ).state;
  const goals = new ThreadGoalApplicationService({
    ...dependencies,
    routeResolver: {
      resolveRoute: async () => assert.fail("paused Goal cannot start a Run"),
    },
  });
  const goal = (
    await goals.setGoal(actor, {
      kind: "thread.goal.set",
      threadId: thread.threadId,
      idempotencyKey: "goal",
      expectedRevision: null,
      objective: "long task",
      status: "paused",
      tokenBudget: { kind: "set", value: 10000 },
    })
  ).goalState!;
  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });
  registerModelSpendingRoutes(app, {
    modelSpending: new ModelSpendingApplicationService(dependencies),
    identity: {
      resolveActor: async (request) => ({
        ...actor,
        ...(request.headers["x-tenant"] ? { tenantId: "foreign" } : {}),
        ...(request.headers["x-space"] ? { spaceId: "foreign" } : {}),
        ...(request.headers["x-denied"] ? { principalId: "denied" } : {}),
      }),
    },
  });
  const url = `/api/v1/threads/${thread.threadId}/goals/${goal.goalId}/model-spending`;
  const payload = {
    expectedRevision: 0,
    currency: "USD",
    limitPicounits: "9007199254740993",
  };
  assert.deepEqual((await app.inject({ method: "GET", url })).json(), {
    account: null,
  });
  const first = await app.inject({ method: "PUT", url, payload });
  assert.equal(first.statusCode, 200, first.body);
  const account = first.json().account;
  assert.equal(account.limitPicounits, payload.limitPicounits);
  assert.equal(account.coverage, "callsAdmittedAfterActivation");
  assert.equal(account.chargedPicounits, "0");
  assert.equal(account.reservedPicounits, "0");
  assert.deepEqual(
    (await app.inject({ method: "PUT", url, payload })).json().account,
    account,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url,
        payload: { ...payload, limitPicounits: "1" },
      })
    ).statusCode,
    409,
  );
  for (const headers of [
    { "x-tenant": "true" },
    { "x-space": "true" },
    { "x-denied": "true" },
  ]) {
    const expected = "x-denied" in headers ? 403 : 404;
    for (const method of ["GET", "PUT"] as const)
      assert.equal(
        (
          await app.inject({
            method,
            url,
            headers,
            ...(method === "PUT" ? { payload } : {}),
          })
        ).statusCode,
        expected,
      );
  }
  for (const invalid of [
    { ...payload, limitPicounits: 1 },
    { ...payload, limitPicounits: "0.1" },
    { ...payload, limitPicounits: "01" },
    { ...payload, limitPicounits: "-1" },
    { ...payload, limitPicounits: "9".repeat(49) },
    { ...payload, tenantId: "foreign" },
    { ...payload, expectedRevision: -1 },
    { ...payload, currency: "usd" },
    {},
  ])
    assert.equal(
      (await app.inject({ method: "PUT", url, payload: invalid })).statusCode,
      400,
    );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: url.replace(goal.goalId, "missing"),
        payload,
      })
    ).statusCode,
    409,
  );
  await goals.clearGoal(actor, {
    kind: "thread.goal.clear",
    threadId: thread.threadId,
    idempotencyKey: "clear",
    expectedRevision: goal.revision,
  });
  // Clearing the objective does not erase its account or prevent later reconciliation/configuration.
  assert.deepEqual(
    (await app.inject({ method: "GET", url })).json().account,
    account,
  );
  const changed = await app.inject({
    method: "PUT",
    url,
    payload: { ...payload, expectedRevision: 1, limitPicounits: "0" },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().account.activatedAt, account.activatedAt);
  assert.equal(changed.json().account.revision, 2);
  assert.ok(
    actions.includes("thread:goal:read") &&
      actions.includes("thread:goal:write"),
  );
});
