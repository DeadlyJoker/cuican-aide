import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import { ControlApiClient } from "@crewon/control-client";
import {
  recoveryFixture,
  recoveryRequest,
} from "../../../packages/application/src/plugin-ui-recovery.test-support.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { errorResponse } from "./control-api-errors.ts";

async function fixture(t: TestContext, configured = true) {
  const f = recoveryFixture({ configured }),
    app = Fastify();
  const credentials = {
    origin: "https://recovery.example.test",
    sessionToken: "recovery-http-session-" + "s".repeat(32),
    csrfToken: "recovery-http-csrf-" + "c".repeat(32),
  };
  const identity = new StandaloneIdentity({
    actor: f.actor,
    ...credentials,
    allowedOrigins: [credentials.origin],
  });
  registerPluginControlRoutes(app, { identity, pluginUi: f.service });
  app.setErrorHandler((error, request, reply) => {
    const value = errorResponse(error, request.id);
    reply.code(value.statusCode).send(value.body);
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const client = new ControlApiClient({
    baseUrl,
    accessToken: credentials.sessionToken,
    csrfToken: credentials.csrfToken,
    origin: credentials.origin,
  });
  const mount = await f.mount();
  const path = `/api/v1/plugins/ui/mounts/${mount.mountRef}/recovery`;
  const headers = {
    "authorization": `Bearer ${credentials.sessionToken}`,
    "origin": credentials.origin,
    "x-csrf-token": credentials.csrfToken,
  };
  return { ...f, app, client, mount, path, headers };
}

test("original Control client stages exact request then reads mount-scoped hint without invoking business", async (t) => {
  const f = await fixture(t),
    request = recoveryRequest();
  assert.deepEqual(
    (await f.client.plugins.getRecovery(f.mount.mountRef)).intents,
    [],
  );
  const stage = await f.client.plugins.stageRecovery(f.mount.mountRef, request);
  assert.equal(stage.disposition, "created");
  assert.equal(stage.intent.phase, "prepared");
  const replay = await f.client.plugins.stageRecovery(
    f.mount.mountRef,
    request,
  );
  assert.equal(replay.disposition, "replayed");
  const get = await f.client.plugins.getRecovery(f.mount.mountRef);
  assert.deepEqual(get.intents[0]!.request, request);
  assert.equal(f.behavior.calls, 0);
  assert.equal(JSON.stringify(get).includes("principalId"), false);
  assert.equal(JSON.stringify(get).includes("profileId"), false);
  assert.equal(
    (await f.app.inject({ url: f.path, headers: f.headers })).headers[
      "cache-control"
    ],
    "no-store",
  );
});

test("recovery route retains original session, Origin and CSRF guards", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { authorization: "Bearer another-session" },
    { origin: "https://foreign.example.test" },
    { "x-csrf-token": "invalid" },
  ]) {
    const result = await f.app.inject({
      method: "POST",
      url: f.path,
      headers: { ...f.headers, ...change },
      payload: recoveryRequest(),
    });
    assert.ok([401, 403].includes(result.statusCode), result.body);
  }
  assert.equal(f.records.size, 0);
  assert.equal(f.behavior.calls, 0);
});

test("recovery rejects body owner/receipt/unknown action/query and GET payload", async (t) => {
  const f = await fixture(t);
  for (const payload of [
    { ...recoveryRequest(), phase: "accepted" },
    { ...recoveryRequest(), receipt: {} },
    { action: "echo", input: null },
    {
      ...recoveryRequest(),
      input: { ...recoveryRequest().input, actor: f.actor },
    },
  ]) {
    const response = await f.app.inject({
      method: "POST",
      url: f.path,
      headers: f.headers,
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(
    (
      await f.app.inject({
        url: `${f.path}?phase=accepted`,
        headers: f.headers,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await f.app.inject({ url: `${f.path}?x=1&x=2`, headers: f.headers }))
      .statusCode,
    400,
  );
  const body = await f.app.inject({
    method: "GET",
    url: f.path,
    headers: { ...f.headers, "content-type": "application/json" },
    payload: { phase: "accepted" },
  });
  assert.equal(body.statusCode, 400, body.body);
  assert.equal(f.records.size, 0);
});

test("default App without recovery port registers no GET/POST recovery route", async (t) => {
  const f = await fixture(t, false);
  for (const method of ["GET", "POST"] as const) {
    const result = await f.app.inject({
      method,
      url: f.path,
      headers: f.headers,
      ...(method === "POST" ? { payload: recoveryRequest() } : {}),
    });
    assert.equal(result.statusCode, 404, result.body);
  }
  assert.equal(f.records.size, 0);
  assert.equal(f.behavior.calls, 0);
});
