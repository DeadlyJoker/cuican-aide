import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import { ExtensionTaskApplicationService } from "@crewon/application";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "../../../packages/store/src/extension-configuration-service.test-support.ts";
import {
  digest,
  timestamp,
} from "../../../packages/store/src/extension-store.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { errorResponse } from "./control-api-errors.ts";
import { registerExtensionTaskRoutes } from "./extension-task-route.ts";

const body = {
  threadId: "task-thread",
  expectedThreadRevision: 1,
  intent: {
    kind: "generate",
    input: { prompt: "A short drama concept image." },
  },
};
const url = `/api/v1/extensions/${saveCommand.pluginId}/tasks`;
const headers = {
  "authorization": "Bearer test-token",
  "idempotency-key": "task-1",
};

async function fixture(t: TestContext) {
  const f = await configurationServiceFixture(t, "sqlite");
  await f.seedDeployment();
  await f.service.saveConfiguration(actor, saveCommand);
  await f.service.setActivation(actor, activateCommand);
  await seedThread(f.first.parent, { ...actor, threadId: body.threadId });
  const tasks = new ExtensionTaskApplicationService({
    ...f.dependencies,
    store: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    ids: { nextId: () => randomUUID() },
  });
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });
  const wake = { count: 0, fail: false };
  registerExtensionTaskRoutes(app, {
    extensionTasks: tasks,
    identity: {
      async resolveActor(context) {
        if (context.headers.authorization !== headers.authorization)
          throw new ControlApiIdentityError("authentication", "token_required");
        return context.headers["x-test-foreign-space"]
          ? { ...actor, spaceId: "other-space" }
          : actor;
      },
    },
    outboxWakeup: {
      async wake() {
        wake.count++;
        if (wake.fail) throw new Error("wake unavailable");
      },
    },
  });
  return { ...f, app, tasks, wake };
}

test("extension HTTP task admission authenticates scope and atomically creates one Turn on concurrent retry", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.app.inject({ method: "POST", url, payload: body })).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url,
        headers: { authorization: headers.authorization },
        payload: body,
      })
    ).statusCode,
    400,
  );
  for (const payload of [
    { ...body, tenantId: "other" },
    { ...body, agentVersionId: "other-agent" },
    { ...body, expectedThreadRevision: -1 },
    { ...body, intent: { ...body.intent, configurationRevision: 1 } },
    {
      ...body,
      intent: { kind: "generate", input: { prompt: "x".repeat(16_384) } },
    },
    {
      ...body,
      intent: { kind: "generate", input: { model: "client-selected" } },
    },
  ]) {
    const response = await f.app.inject({
      method: "POST",
      url,
      headers,
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `${url}?spaceId=other`,
        headers,
        payload: body,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url,
        headers: { ...headers, "x-test-foreign-space": "1" },
        payload: body,
      })
    ).statusCode,
    404,
  );
  f.state.denied = "extension:run";
  assert.equal(
    (await f.app.inject({ method: "POST", url, headers, payload: body }))
      .statusCode,
    403,
  );
  f.state.denied = "thread:message:append";
  assert.equal(
    (await f.app.inject({ method: "POST", url, headers, payload: body }))
      .statusCode,
    403,
  );
  assert.equal(await f.count("messages"), 0);
  f.state.denied = null;
  f.wake.fail = true;
  const results = await Promise.all(
    [1, 2].map(() =>
      f.app.inject({ method: "POST", url, headers, payload: body }),
    ),
  );
  for (const result of results)
    assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(results.map((value) => value.json().disposition).sort(), [
    "committed",
    "replayed",
  ]);
  const saved = results
    .find((value) => value.json().disposition === "committed")!
    .json();
  assert.deepEqual(Object.keys(saved).sort(), [
    "configurationRevision",
    "disposition",
    "messageId",
    "runId",
    "threadId",
    "threadRevision",
  ]);
  assert.equal(saved.threadId, body.threadId);
  assert.equal(saved.threadRevision, 2);
  assert.equal(saved.configurationRevision, 1);
  assert.equal(await f.count("messages"), 1);
  assert.equal(await f.count("extension_run_bindings"), 1);
  assert.equal(await f.count("work_items"), 1);
  assert.equal(f.wake.count, 2);
  const binding = await f.first.store.loadExtensionRunBinding({
    ...actor,
    runId: saved.runId,
  });
  assert.equal(binding?.actorId, actor.actorId);
  f.state.catalogAvailable = false;
  const replay = await f.app.inject({
    method: "POST",
    url,
    headers,
    payload: body,
  });
  assert.deepEqual(replay.json(), { ...saved, disposition: "replayed" });
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url,
        headers,
        payload: {
          ...body,
          intent: { kind: "generate", input: { prompt: "changed" } },
        },
      })
    ).statusCode,
    409,
  );
  f.state.denied = "extension:run";
  assert.equal(
    (await f.app.inject({ method: "POST", url, headers, payload: body }))
      .statusCode,
    403,
  );
});

test("extension HTTP query pins the original operation and rechecks original Run access on every retry", async (t) => {
  const f = await fixture(t);
  const original = await f.tasks.createTask(actor, {
    ...body,
    intent: { kind: "generate", input: body.intent.input },
    pluginId: saveCommand.pluginId,
    idempotencyKey: "original",
  });
  const operationId = randomUUID();
  await f.operations.reserveExternalOperation({
    tenantId: actor.tenantId,
    runId: original.binding.runId,
    bindingDigest: original.binding.bindingDigest,
    operationId,
    correlationId: operationId,
    executionId: "execution-1",
    idempotencyKey: "operation-1",
    actionDigest: digest,
    requestDigest: digest,
    createdAt: timestamp,
  });
  await f.service.setActivation(actor, {
    ...activateCommand,
    expectedRevision: 1,
    state: "disabled",
    agentVersionId: null,
    idempotencyKey: "disable",
  });
  await seedThread(f.first.parent, { ...actor, threadId: "query-thread" });
  const query = {
    ...body,
    threadId: "query-thread",
    intent: { kind: "query", sourceRunId: original.binding.runId, operationId },
  };
  f.state.denied = "run:read";
  assert.equal(
    (await f.app.inject({ method: "POST", url, headers, payload: query }))
      .statusCode,
    403,
  );
  f.state.denied = null;
  const saved = await f.app.inject({
    method: "POST",
    url,
    headers,
    payload: query,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const binding = await f.first.store.loadExtensionRunBinding({
    ...actor,
    runId: saved.json().runId,
  });
  assert.deepEqual(binding?.source, {
    runId: original.binding.runId,
    bindingDigest: original.binding.bindingDigest,
    operationId,
  });
  assert.equal(
    binding?.configurationDigest,
    original.binding.configurationDigest,
  );
  assert.equal(
    (
      await f.app.inject({ method: "POST", url, headers, payload: query })
    ).json().disposition,
    "replayed",
  );
  f.state.denied = "run:read";
  assert.equal(
    (await f.app.inject({ method: "POST", url, headers, payload: query }))
      .statusCode,
    403,
  );
  f.state.denied = null;
  const missing = await f.app.inject({
    method: "POST",
    url,
    headers: { ...headers, "idempotency-key": "missing-op" },
    payload: {
      ...query,
      intent: { ...query.intent, operationId: randomUUID() },
    },
  });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(await f.count("messages"), 2);
});
