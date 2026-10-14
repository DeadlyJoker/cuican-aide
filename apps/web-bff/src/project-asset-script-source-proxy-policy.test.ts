import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAssetScriptSourceProxyPolicy as policy,
  boundedProjectAssetScriptSourceProxyResponse as finite,
} from "./project-asset-script-source-proxy-policy.ts";
import { createWebBff } from "./web-bff.ts";
const pathname = "/api/v1/threads/thread/project-asset-stage/script-source";
const search =
  "?projectId=project&expectedBindingRevision=1&briefRevision=2&episodeId=episode";
const input = { pathname, search, method: "GET" };
const output = {
  projectId: "project",
  threadId: "thread",
  bindingRevision: 1,
  briefRevision: 2,
  episodeId: "episode",
  script: null,
};
test("script source policy refuses extra query, ambiguous versions, non GET and alternate paths", () => {
  assert.equal(policy(input)?.outcome, "allow");
  for (const bad of [
    { ...input, search: search + "&actorId=forged" },
    { ...input, search: search + "&projectId=foreign" },
    { ...input, search: search.replace("Revision=1", "Revision=01") },
    { ...input, method: "POST" },
    { ...input, pathname: pathname + "/extra" },
    { ...input, pathname: pathname.replace("thread/", "%2e%2e/") },
  ])
    assert.equal(policy(bad)?.outcome, "deny");
  assert.equal(
    policy({ ...input, pathname: "/api/v1/threads/thread/turns" }),
    null,
  );
});
test("finite source response keeps exact bound refs and refuses body widening or foreign output", async () => {
  const p = policy(input);
  assert.ok(p?.outcome === "allow");
  const signal = new AbortController().signal;
  assert.deepEqual(
    await (
      await finite({ upstream: Response.json(output), signal, policy: p })
    ).json(),
    output,
  );
  for (const value of [
    { ...output, threadId: "foreign" },
    { ...output, content: "x" },
    {
      ...output,
      script: { artifactId: "s", episodeId: "foreign", contentRevision: 1 },
    },
  ])
    await assert.rejects(
      finite({ upstream: Response.json(value), signal, policy: p }),
    );
  await assert.rejects(
    finite({
      upstream: Response.json({ content: "x".repeat(4096) }),
      signal,
      policy: p,
    }),
  );
});
test("actual BFF authenticates the exact bounded source read and never invokes upstream for malformed or logged out requests", async () => {
  let calls = 0;
  const app = createWebBff({
    publicOrigin: "https://bff.test",
    controlTarget: "http://127.0.0.1:3210",
    controlBffToken: "bff-service-token-at-least-32-characters",
    controlCsrfToken: "control-csrf-token-at-least-32-characters",
    csrfSecret: "browser-csrf-secret-at-least-32-characters",
    identity: {
      resolve: async ({ cookie }) =>
        cookie === "actual-session"
          ? {
              sessionId: "session-identity-at-least-32-characters",
              expiresAt: "2030-01-01T00:00:00.000Z",
              controlAccessToken:
                "resolved-control-actor-at-least-32-characters",
            }
          : null,
    },
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "manual");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer resolved-control-actor-at-least-32-characters",
      );
      return Response.json(output);
    },
  });
  assert.equal(
    (await app.handle(new Request(`https://bff.test${pathname}${search}`)))
      .status,
    401,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await app.handle(
        new Request(`https://bff.test${pathname}${search}&projectId=foreign`, {
          headers: { cookie: "actual-session" },
        }),
      )
    ).status,
    400,
  );
  assert.equal(calls, 0);
  const response = await app.handle(
    new Request(`https://bff.test${pathname}${search}`, {
      headers: { cookie: "actual-session" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), output);
  assert.equal(calls, 1);
});
