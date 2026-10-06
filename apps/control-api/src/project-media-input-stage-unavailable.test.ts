import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { conversationFixture } from "../../../packages/store/src/project-conversation-store.test-support.ts";
import { errorResponse } from "./control-api-errors.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { registerProjectMediaInputStageRoutes } from "./project-media-input-stage-route.ts";
import { ProjectMediaInputStageControlOwner } from "./project-media-input-stage-control-owner.ts";

const origin = "crewon://desktop",
  token = "media-stage-route-session-32-byte-minimum",
  csrf = "media-stage-route-csrf-32-byte-minimum";
function http() {
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const r = errorResponse(error, request.id);
    return reply.code(r.statusCode).send(r.body);
  });
  return app;
}
const headers = (key = "media-stage-original") => ({
  "authorization": `Bearer ${token}`,
  origin,
  "x-csrf-token": csrf,
  "idempotency-key": key,
});
const stage = {
  kind: "media-input" as const,
  workflowId: "krea2-reference-four-view" as const,
  configurationRevision: 2,
  briefRevision: 1,
  script: null,
};

test("media input stage unavailable opt-in still authenticates actual Thread access, accepts no execution and strictly validates requests", async (t) => {
  const f = await conversationFixture(t, "sqlite"),
    p = await f.prepare();
  await f.store.commitBinding(p, { authority: f.authority });
  const app = http(),
    identity = new StandaloneIdentity({
      actor: f.actor,
      sessionToken: token,
      csrfToken: csrf,
      allowedOrigins: [origin],
    });
  let wakes = 0;
  registerProjectMediaInputStageRoutes(app, {
    identity,
    owner: null,
    threads: f.threads,
    outboxWakeup: {
      wake: async () => {
        wakes++;
      },
    },
  });
  t.after(() => app.close());
  const url = `/api/v1/threads/${p.binding.threadId}/project-media-input-stage`,
    valid = {
      projectId: f.reference.projectId,
      threadId: p.binding.threadId,
      expectedThreadRevision: 1,
      expectedBindingRevision: 1,
      stage,
      content: "创作一个角色候选",
      idempotencyKey: "media-stage-original",
    };
  const before = await f.rows(`SELECT run_id FROM ${f.prefix}run_snapshots`);
  const get = await app.inject({ method: "GET", url, headers: headers() });
  assert.equal(get.statusCode, 200, get.body);
  assert.deepEqual(get.json(), { available: false });
  assert.equal(
    (await app.inject({ method: "HEAD", url, headers: headers() })).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url,
        headers: { ...headers(), authorization: "Bearer wrong" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/threads/absent/project-media-input-stage",
        headers: headers(),
      })
    ).statusCode,
    404,
  );
  const post = await app.inject({
    method: "POST",
    url,
    headers: headers(),
    payload: valid,
  });
  assert.equal(post.statusCode, 409, post.body);
  assert.equal(post.json().error.code, "project_media_input_stage_unavailable");
  for (const method of ["GET", "POST"] as const) {
    assert.equal(
      (
        await app.inject({
          method,
          url: url + "?unknown=x",
          headers: headers(),
          ...(method === "POST" ? { payload: valid } : {}),
        })
      ).statusCode,
      400,
    );
  }
  for (const payload of [
    { ...valid, threadId: "other" },
    { ...valid, idempotencyKey: "different" },
    { ...valid, actorId: "claimed" },
    { ...valid, stage: { ...stage, kind: "discussion" } },
    { ...valid, expectedThreadRevision: 0 },
    [],
    { ...valid, content: "" },
  ]) {
    const r = await app.inject({
      method: "POST",
      url,
      headers: headers(),
      payload,
    });
    assert.equal(r.statusCode, 400, r.body);
  }
  for (const [h, status] of [
    [{ ...headers(), "idempotency-key": "" }, 400],
    [{ ...headers(), authorization: "Bearer wrong" }, 401],
    [{ ...headers(), origin: "https://foreign.invalid" }, 403],
    [{ ...headers(), "x-csrf-token": "wrong" }, 403],
  ] as const) {
    const r = await app.inject({
      method: "POST",
      url,
      headers: h,
      payload: valid,
    });
    assert.equal(r.statusCode, status, r.body);
  }
  assert.deepEqual(
    await f.rows(`SELECT run_id FROM ${f.prefix}run_snapshots`),
    before,
  );
  assert.equal(wakes, 0);
  const unregistered = http();
  t.after(() => unregistered.close());
  assert.throws(
    () =>
      registerProjectMediaInputStageRoutes(unregistered, {
        identity,
        threads: f.threads,
        outboxWakeup: { wake: async () => {} },
        owner: {} as ProjectMediaInputStageControlOwner,
      }),
    /project_media_input_stage_owner_required/,
  );
});
