import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
const threadId = "thread/中文 %",
  at = "2026-10-06T00:00:00.000Z";
const binding = {
  bindingId: "bound-thread",
  projectId: "project",
  threadId,
  workspaceId: "actual-workspace",
  revision: 1,
  state: "active",
  source: {
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "16.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
    selectionRevision: 2,
  },
  createdAt: at,
  updatedAt: at,
};
const request = {
  projectId: "project",
  threadId,
  expectedThreadRevision: 1,
  expectedBindingRevision: 1,
  content: " 原用户消息\n第二行 ",
  idempotencyKey: "original-stage-key",
  stage: { kind: "discussion" as const },
};
const response = {
  disposition: "committed",
  threadId,
  threadRevision: 2,
  runId: "real-run",
  runRevision: 1,
  bindingRevision: 1,
  stageAdmissionDigest: `sha256:${"b".repeat(64)}`,
};
function client(
  fetch: typeof globalThis.fetch,
  csrfToken: string | null = "real-csrf",
) {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "real-token",
    csrfToken,
    origin: "https://ui.test",
    fetch,
  });
}
test("project binding and stage use original auth/CSRF, exact body and once-encoded Thread; replay has no automatic submit", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const c = client(async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(calls.length === 1 ? { binding } : response, {
      status: calls.length === 1 ? 200 : 201,
    });
  });
  assert.deepEqual(await c.projectConversations.getBinding(threadId), {
    binding,
  });
  assert.deepEqual(
    await c.projectConversations.startStage(threadId, request),
    response,
  );
  assert.equal(
    calls[0]!.url,
    `https://control.test/api/v1/threads/${encodeURIComponent(threadId)}/project-conversation`,
  );
  const headers = new Headers(calls[1]!.init.headers);
  assert.equal(headers.get("authorization"), "Bearer real-token");
  assert.equal(headers.get("x-csrf-token"), "real-csrf");
  assert.equal(headers.get("idempotency-key"), request.idempotencyKey);
  assert.equal(headers.get("origin"), "https://ui.test");
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), request);
  assert.equal(calls.length, 2);
});
test("foreign Thread, supplied authority and pre-abort refuse before HTTP; missing CSRF stays refused", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return Response.json({ binding: null });
  });
  for (const raw of [
    { ...request, threadId: "other" },
    { ...request, actor: "forged" },
    { ...request, stage: { kind: "media" } },
  ])
    await assert.rejects(
      c.projectConversations.startStage(threadId, raw as typeof request),
      ControlApiProtocolError,
    );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    c.projectConversations.getBinding(threadId, { signal: aborted.signal }),
  );
  assert.equal(calls, 0);
  await assert.rejects(
    client(async () => {
      calls++;
      return Response.json(response);
    }, null).projectConversations.startStage(threadId, request),
  );
  assert.equal(calls, 0);
});
test("successful HTTP with wrong thread/revision or private fields cannot be adopted", async () => {
  for (const raw of [
    { ...response, threadId: "other" },
    { ...response, threadRevision: 3 },
    { ...response, actor: "hidden" },
  ])
    await assert.rejects(
      client(async () => Response.json(raw)).projectConversations.startStage(
        threadId,
        request,
      ),
      (e) =>
        e instanceof ControlApiProtocolError &&
        e.code === "control_client_project_conversation_response_invalid",
    );
});
test("composer context uses one authenticated read of the actual Thread and rejects a foreign binding", async () => {
  const context = {
    binding,
    projectRevision: 2,
    briefRevision: 1,
    outline: {
      artifactId: "adopted",
      contentRevision: 2,
      episodes: [{ episodeId: "one", title: "第一集" }],
    },
  };
  const calls: Request[] = [];
  const c = client(async (url, init) => {
    calls.push(new Request(url, init));
    return Response.json({ context });
  });
  assert.deepEqual(await c.projectConversations.getContext(threadId), {
    context,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    `https://control.test/api/v1/threads/${encodeURIComponent(threadId)}/project-conversation/context`,
  );
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer real-token");
  assert.equal(calls[0]!.headers.get("idempotency-key"), null);
  await assert.rejects(
    client(async () =>
      Response.json({
        context: { ...context, binding: { ...binding, threadId: "foreign" } },
      }),
    ).projectConversations.getContext(threadId),
    ControlApiProtocolError,
  );
});
