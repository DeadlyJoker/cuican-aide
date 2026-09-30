import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  configurationServiceFixture,
  actor,
  activateCommand,
  saveCommand,
} from "../../../packages/store/src/extension-configuration-service.test-support.ts";
import { registerExtensionConfigurationRoutes } from "./extension-configuration-route.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { errorResponse } from "./control-api-errors.ts";

test("extension HTTP configuration uses authenticated scope, exact revisions and receipts before activation", async (t) => {
  const f = await configurationServiceFixture(t, "sqlite");
  await f.seedDeployment();
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });
  registerExtensionConfigurationRoutes(app, {
    extensions: f.service,
    identity: {
      resolveActor: async (context) => {
        if (context.headers.authorization !== "Bearer test-token")
          throw new ControlApiIdentityError("authentication", "token_required");
        return context.headers["x-test-foreign-space"]
          ? { ...actor, spaceId: "other-space" }
          : actor;
      },
    },
  });
  const base = `/api/v1/extensions/${saveCommand.pluginId}`;
  const headers = {
    "authorization": "Bearer test-token",
    "idempotency-key": saveCommand.idempotencyKey,
  };
  const { pluginId: _, idempotencyKey: __, ...saveBody } = saveCommand;
  const {
    pluginId: ___,
    idempotencyKey: ____,
    ...activateBody
  } = activateCommand;
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `${base}/configuration`,
        payload: saveBody,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `${base}/configuration`,
        headers: { authorization: headers.authorization },
        payload: saveBody,
      })
    ).statusCode,
    400,
  );
  assert.deepEqual(
    (
      await app.inject({ method: "GET", url: `${base}/configuration`, headers })
    ).json(),
    { configuration: null },
  );
  const saved = await app.inject({
    method: "PUT",
    url: `${base}/configuration`,
    headers,
    payload: saveBody,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().configuration.tenantId, actor.tenantId);
  assert.equal(saved.json().configuration.spaceId, actor.spaceId);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `${base}/configuration`,
        headers,
        payload: saveBody,
      })
    ).json().disposition,
    "replayed",
  );
  for (const payload of [
    { ...saveBody, tenantId: "other" },
    { ...saveBody, parameters: { format: "mp4", secret: "raw" } },
    { ...saveBody, implementationDigest: "claimed" },
  ])
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `${base}/configuration`,
          headers: { ...headers, "idempotency-key": "invalid-shape" },
          payload,
        })
      ).statusCode,
      400,
    );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `${base}/configuration`,
        headers,
        payload: { ...saveBody, parameters: { format: "webm" } },
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(
    (
      await app.inject({
        method: "GET",
        url: `${base}/configuration?revision=1`,
        headers,
      })
    ).json().configuration,
    saved.json().configuration,
  );
  assert.deepEqual(
    (
      await app.inject({
        method: "GET",
        url: `${base}/configuration`,
        headers: { ...headers, "x-test-foreign-space": "1" },
      })
    ).json(),
    { configuration: null },
  );
  for (const suffix of [
    "?revision=01",
    "?revision=1&revision=2",
    "?tenantId=other",
  ])
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `${base}/configuration${suffix}`,
          headers,
        })
      ).statusCode,
      400,
    );
  const active = await app.inject({
    method: "PUT",
    url: `${base}/activation`,
    headers: { ...headers, "idempotency-key": activateCommand.idempotencyKey },
    payload: activateBody,
  });
  assert.equal(active.statusCode, 200, active.body);
  assert.equal(active.json().activation.state, "enabled");
  f.state.denied = "extension:read";
  assert.equal(
    (await app.inject({ method: "GET", url: `${base}/activation`, headers }))
      .statusCode,
    403,
  );
  f.state.denied = "extension:activate";
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `${base}/activation`,
        headers: {
          ...headers,
          "idempotency-key": activateCommand.idempotencyKey,
        },
        payload: activateBody,
      })
    ).statusCode,
    403,
  );
  assert.equal(await f.count("run_snapshots"), 0);
});
