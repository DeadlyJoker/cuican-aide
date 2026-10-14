import assert from "node:assert/strict";
import test from "node:test";
import { createWebBff } from "./web-bff.ts";
import {
  projectConversationProxyPolicy,
  boundedProjectConversationProxyRequest,
  boundedProjectConversationProxyResponse,
} from "./project-conversation-proxy-policy.ts";

const path = "/api/v1/threads/thread-1/project-conversation";
const body = {
  projectId: "project-1",
  threadId: "thread-1",
  expectedThreadRevision: 2,
  expectedBindingRevision: 1,
  content: "原聊天文本",
  idempotencyKey: "original-stage-key",
  stage: { kind: "discussion" },
};
function policy(target: string, method = "GET") {
  const question = target.indexOf("?");
  return projectConversationProxyPolicy({
    pathname: question < 0 ? target : target.slice(0, question),
    search: question < 0 ? "" : target.slice(question),
    method,
  });
}
test("conversation proxy bounds only the exact binding, context and stage routes before path normalization", () => {
  assert.deepEqual(policy(path), {
    outcome: "allow",
    threadId: "thread-1",
    responseMaxBytes: 24 * 1024,
  });
  assert.deepEqual(policy(`${path}/stages`, "POST"), {
    outcome: "allow",
    threadId: "thread-1",
    responseMaxBytes: 24 * 1024,
  });
  assert.deepEqual(policy(`${path}/context`), {
    outcome: "allow",
    threadId: "thread-1",
    responseMaxBytes: 256 * 1024,
  });
  assert.equal(policy(`${path}/context`, "POST")?.outcome, "deny");
  assert.equal(policy("/api/v1/threads/thread-1/turns", "POST"), null);
  for (const target of [
    `${path}/unknown`,
    `${path}/stages/extra`,
    path.replace("thread-1", "%2e%2e"),
    path.replace("thread-1", "%ZZ"),
    path.replace("project-conversation", "%70roject-conversation"),
    `${path}/../turns`,
  ])
    assert.equal(policy(target)?.outcome, "deny");
  assert.deepEqual(policy(`${path}?actorId=forged`), {
    outcome: "deny",
    status: 400,
    code: "project_conversation_request_invalid",
  });
  assert.equal(policy(path, "POST")?.outcome, "deny");
  assert.equal(policy(`${path}/stages`)?.outcome, "deny");
});
test("conversation body checks strict stage, actual path Thread and the same idempotency key", async () => {
  const allowed = policy(`${path}/stages`, "POST");
  assert.ok(allowed?.outcome === "allow");
  const request = (value: unknown, key = "original-stage-key") =>
    new Request(`https://bff.test${path}/stages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(value),
    });
  const signal = new AbortController().signal;
  const result = await boundedProjectConversationProxyRequest(
    request(body),
    signal,
    allowed,
  );
  assert.deepEqual(JSON.parse(new TextDecoder().decode(result!)), body);
  for (const invalid of [
    { ...body, threadId: "foreign-thread" },
    { ...body, actorId: "forged" },
    { ...body, stage: { kind: "media" } },
    { ...body, content: "x".repeat(25 * 1024) },
  ])
    await assert.rejects(
      boundedProjectConversationProxyRequest(request(invalid), signal, allowed),
    );
  await assert.rejects(
    boundedProjectConversationProxyRequest(
      request(body, "different-key"),
      signal,
      allowed,
    ),
  );
});
test("actual BFF session and CSRF guards precede conversation upstream, which retains the original request once", async () => {
  const origin = "https://conversation-bff.test",
    calls: Request[] = [];
  const app = createWebBff({
    publicOrigin: origin,
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
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return Response.json({ disposition: "replayed" });
    },
  });
  const session = await app.handle(
    new Request(`${origin}/control-api/session`, {
      headers: { cookie: "actual-session" },
    }),
  );
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const write = (value: unknown, csrf = csrfToken, cookie = "actual-session") =>
    new Request(`${origin}${path}/stages`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        "idempotency-key": "original-stage-key",
        "authorization": "Bearer caller-forged-identity",
      },
      body: JSON.stringify(value),
    });
  assert.equal(
    (await app.handle(write(body, "invalid-csrf-at-least-32-characters")))
      .status,
    403,
  );
  assert.equal(
    (await app.handle(write(body, csrfToken, "foreign-session"))).status,
    401,
  );
  assert.equal(
    (await app.handle(write({ ...body, principalId: "forged" }))).status,
    400,
  );
  assert.equal(calls.length, 0);
  assert.equal((await app.handle(write(body))).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `http://127.0.0.1:3210${path}/stages`);
  assert.equal(
    calls[0]!.headers.get("authorization"),
    "Bearer resolved-control-actor-at-least-32-characters",
  );
  assert.equal(calls[0]!.headers.get("idempotency-key"), body.idempotencyKey);
  assert.deepEqual(await calls[0]!.json(), body);
});
test("conversation ACK response cannot exceed the bounded public metadata budget", async () => {
  const signal = new AbortController().signal;
  const response = await boundedProjectConversationProxyResponse({
    upstream: Response.json({ binding: null }),
    signal,
  });
  assert.deepEqual(await response.json(), { binding: null });
  await assert.rejects(
    boundedProjectConversationProxyResponse({
      upstream: new Response("x".repeat(24 * 1024 + 1)),
      signal,
    }),
  );
});
