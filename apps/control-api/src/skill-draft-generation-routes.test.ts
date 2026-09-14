import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  ApplicationError,
  type SkillDraftGenerationService,
} from "@crewon/application";
import { registerSkillDraftGenerationRoutes } from "./skill-draft-generation-routes.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
const actor = { principalId: "p", actorId: "a", tenantId: "t", spaceId: "s" };
const headers = {
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "http://localhost:3000",
  "x-csrf-token": "c".repeat(32),
};
function fixture(missing = false) {
  const app = Fastify();
  const calls: unknown[] = [];
  let failure: Error | null = null;
  let wakes = 0;
  const methods = Object.fromEntries(
    ["start", "list", "read", "collect", "apply"].map((name) => [
      name,
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        if (failure) throw failure;
        return name === "list"
          ? []
          : {
              generationId: "g",
              runId: "r",
              candidate: null,
              verification: "unknown",
            };
      },
    ]),
  );
  registerSkillDraftGenerationRoutes(app, {
    generations: missing
      ? null
      : (methods as unknown as SkillDraftGenerationService),
    identity: new StandaloneIdentity({
      actor,
      sessionToken: "s".repeat(32),
      csrfToken: "c".repeat(32),
      allowedOrigins: [headers.origin],
    }),
    outboxWakeup: {
      async wake() {
        wakes++;
      },
    },
  });
  return {
    app,
    calls,
    wakes: () => wakes,
    fail(error: Error) {
      failure = error;
    },
  };
}
const base = "/api/v1/skills/skill-1/generations";
const input = {
  generationId: "g",
  threadId: "thread-1",
  expectedThreadRevision: 1,
  agentVersionId: null,
  expectedSkillRevision: 1,
};
test("generation routes carry exact immutable request and explicit collect/apply confirmation", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  for (const [method, url, payload, expected] of [
    ["POST", base, input, ["start", actor, "skill-1", input]],
    ["GET", base, undefined, ["list", actor, "skill-1"]],
    ["GET", `${base}/g`, undefined, ["read", actor, "skill-1", "g"]],
    ["POST", `${base}/g/collect`, {}, ["collect", actor, "skill-1", "g"]],
    [
      "POST",
      `${base}/g/apply`,
      { expectedSkillRevision: 1 },
      ["apply", actor, "skill-1", "g", 1],
    ],
  ] as const) {
    const response = await f.app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(f.calls.at(-1), expected);
    if (method === "GET" && url === base)
      assert.deepEqual(response.json(), { generations: [] });
  }
  assert.equal(f.wakes(), 1);
});
test("generation routes enforce session, CSRF, strict fields, host availability and typed errors", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  assert.equal(
    (await f.app.inject({ method: "POST", url: base, payload: input }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: base,
        headers: { ...headers, "x-csrf-token": "bad" },
        payload: input,
      })
    ).statusCode,
    403,
  );
  for (const [url, payload] of [
    [base, { ...input, verification: "real" }],
    [base, { ...input, expectedSkillRevision: -1 }],
    [base, { ...input, agentVersionId: {} }],
    [`${base}/g/collect`, { runId: "unrelated" }],
    [`${base}/g/apply`, { expectedSkillRevision: 1, candidate: {} }],
  ] as const)
    assert.equal(
      (await f.app.inject({ method: "POST", url, headers, payload }))
        .statusCode,
      400,
    );
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: `${base}?tenantId=other`,
        headers,
      })
    ).statusCode,
    400,
  );
  assert.equal(f.calls.length, 0);
  f.fail(new ApplicationError("conflict", "skill_generation_not_completed"));
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `${base}/g/collect`,
        headers,
        payload: {},
      })
    ).statusCode,
    409,
  );
  const absent = fixture(true);
  t.after(() => absent.app.close());
  assert.equal(
    (await absent.app.inject({ method: "GET", url: base, headers })).statusCode,
    503,
  );
});
