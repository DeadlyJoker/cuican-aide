import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
  ControlApiClientError,
} from "./control-api-client.ts";
import type { ProjectAssetStageRequest } from "@crewon/contracts/project-asset-stages";
const threadId = "thread/中文 %",
  input: ProjectAssetStageRequest = {
    projectId: "project",
    threadId,
    expectedThreadRevision: 1,
    expectedBindingRevision: 2,
    stage: {
      kind: "assets",
      assetKind: "character",
      briefRevision: 3,
      script: null,
    },
    content: " 用户原文\n第二行 ",
    idempotencyKey: "original-key",
  };
const output = {
  disposition: "committed",
  threadId,
  threadRevision: 2,
  runId: "_original-run",
  runRevision: 1,
  bindingRevision: 2,
  stageAdmissionDigest: `sha256:${"b".repeat(64)}`,
};
function client(
  fetch: typeof globalThis.fetch,
  csrfToken: string | null = "fixture-csrf",
) {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "fixture-token",
    csrfToken,
    origin: "https://ui.test",
    fetch,
  });
}
test("asset stage group is lazy and original authenticated POST preserves exact input, header key and encoded Thread", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [],
    c = client(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json(output, { status: 201 });
    });
  const group = c.projectAssetStages;
  assert.equal(group, c.projectAssetStages);
  assert.equal(calls.length, 0);
  assert.deepEqual(await group.startStage(threadId, input), output);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    `https://control.test/api/v1/threads/${encodeURIComponent(threadId)}/project-asset-stage`,
  );
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), "Bearer fixture-token");
  assert.equal(headers.get("origin"), "https://ui.test");
  assert.equal(headers.get("x-csrf-token"), "fixture-csrf");
  assert.equal(headers.get("idempotency-key"), input.idempotencyKey);
  assert.equal(calls[0]!.init.credentials, "include");
  assert.equal(calls[0]!.init.redirect, "manual");
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), input);
});
test("foreign Thread, unknown owner fields, accessors and invalid stage refuse before HTTP", async () => {
  let calls = 0,
    reads = 0;
  const c = client(async () => {
    calls++;
    return Response.json(output);
  });
  for (const raw of [
    { ...input, threadId: "other" },
    { ...input, actorId: "other" },
    { ...input, stage: { kind: "outline" } },
    { ...input, expectedBindingRevision: 0 },
  ])
    await assert.rejects(
      c.projectAssetStages.startStage(
        threadId,
        raw as ProjectAssetStageRequest,
      ),
      ControlApiProtocolError,
    );
  const getter = Object.defineProperty({ ...input }, "content", {
    enumerable: true,
    get() {
      reads++;
      return input.content;
    },
  });
  await assert.rejects(c.projectAssetStages.startStage(threadId, getter));
  const options = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      reads++;
      return undefined;
    },
  });
  await assert.rejects(
    c.projectAssetStages.startStage(threadId, input, options),
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});
test("missing CSRF and cancelled owners cannot submit; late transport success still preserves caller abort", async () => {
  let calls = 0;
  const original = new Error("owner-abort"),
    cancellation = new AbortController();
  cancellation.abort(original);
  const c = client(async () => {
    calls++;
    return Response.json(output);
  });
  await assert.rejects(
    c.projectAssetStages.startStage(threadId, input, {
      signal: cancellation.signal,
    }),
    (error) => error === original,
  );
  await assert.rejects(
    client(async () => {
      calls++;
      return Response.json(output);
    }, null).projectAssetStages.startStage(threadId, input),
    ControlApiProtocolError,
  );
  assert.equal(calls, 0);
  const late = new AbortController(),
    ignored = client(async () => {
      calls++;
      late.abort(original);
      return Response.json(output);
    });
  await assert.rejects(
    ignored.projectAssetStages.startStage(threadId, input, {
      signal: late.signal,
    }),
    (error) => error === original,
  );
  assert.equal(calls, 1);
});
test("HTTP errors remain original and no automatic retry can create a second stage request", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return Response.json(
      {
        error: {
          category: "conflict",
          code: "project_asset_stage_binding_changed",
          requestId: "req-fixture",
        },
      },
      { status: 409 },
    );
  });
  await assert.rejects(
    c.projectAssetStages.startStage(threadId, input),
    (error) =>
      error instanceof ControlApiClientError &&
      error.status === 409 &&
      error.code === "project_asset_stage_binding_changed",
  );
  assert.equal(calls, 1);
});
test("wrong receipt identities, private fields and actual oversized response stream cannot become confirmed", async () => {
  for (const raw of [
    { ...output, threadId: "foreign" },
    { ...output, threadRevision: 3 },
    { ...output, bindingRevision: 3 },
    { ...output, actor: "private" },
  ])
    await assert.rejects(
      client(async () => Response.json(raw)).projectAssetStages.startStage(
        threadId,
        input,
      ),
      (error) =>
        error instanceof ControlApiProtocolError &&
        error.code === "control_client_project_asset_stage_response_invalid",
    );
  let canceled = false;
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...output, extra: "x".repeat(24 * 1024) }),
  );
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 12000));
      controller.enqueue(bytes.subarray(12000));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(
    client(
      async () =>
        new Response(oversized, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ).projectAssetStages.startStage(threadId, input),
  );
  assert.equal(canceled, true);
});
test("old project conversation startStage still rejects assets and retains its original four-stage route", async () => {
  let calls = 0;
  const c = client(async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      `https://control.test/api/v1/threads/${encodeURIComponent(threadId)}/project-conversation/stages`,
    );
    assert.equal(JSON.parse(init!.body as string).stage.kind, "discussion");
    return Response.json(output);
  });
  await assert.rejects(
    c.projectConversations.startStage(threadId, input as never),
    ControlApiProtocolError,
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await c.projectConversations.startStage(threadId, {
      ...input,
      stage: { kind: "discussion" },
    }),
    output,
  );
  assert.equal(calls, 1);
});

test("asset availability is independent authenticated GET without mutation credentials and strictly parses the actual boolean", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [],
    c = client(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ available: false });
    }, null);
  assert.deepEqual(await c.projectAssetStages.getAvailability(threadId), {
    available: false,
  });
  const call = calls[0]!;
  assert.equal(
    call.url,
    `https://control.test/api/v1/threads/${encodeURIComponent(threadId)}/project-asset-stage`,
  );
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.body, undefined);
  assert.equal(call.init.redirect, "manual");
  const h = new Headers(call.init.headers);
  assert.equal(h.get("authorization"), "Bearer fixture-token");
  assert.equal(h.get("x-csrf-token"), null);
  assert.equal(h.get("idempotency-key"), null);
  for (const value of [
    { available: "true" },
    { available: true, authority: {} },
    {},
  ]) {
    const other = client(async () => Response.json(value));
    await assert.rejects(
      other.projectAssetStages.getAvailability(threadId),
      ControlApiProtocolError,
    );
  }
});
test("asset availability rejects owner/selectors and aborted late replies; it never falls back to conversation", async () => {
  let calls = 0,
    reads = 0;
  const c = client(async () => {
    calls++;
    return Response.json({ available: true });
  });
  await assert.rejects(
    c.projectAssetStages.getAvailability(".."),
    ControlApiProtocolError,
  );
  const options = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      reads++;
      return new AbortController().signal;
    },
  });
  await assert.rejects(
    c.projectAssetStages.getAvailability(threadId, options),
    ControlApiProtocolError,
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  const controller = new AbortController(),
    late = client(async () => {
      controller.abort();
      return Response.json({ available: true });
    });
  await assert.rejects(
    late.projectAssetStages.getAvailability(threadId, {
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  const missing = client(async () =>
    Response.json(
      {
        error: {
          category: "notFound",
          code: "missing",
          message: "missing",
          requestId: "fixture",
        },
      },
      { status: 404 },
    ),
  );
  await assert.rejects(
    missing.projectAssetStages.getAvailability(threadId),
    ControlApiClientError,
  );
});

test("script source is an exact authenticated finite read without legacy project text API or automatic execution", async () => {
  const request = {
    projectId: "project",
    threadId,
    expectedBindingRevision: 2,
    briefRevision: 3,
    episodeId: "episode 1",
  };
  const output = {
    projectId: request.projectId,
    threadId,
    bindingRevision: 2,
    briefRevision: 3,
    episodeId: request.episodeId,
    script: {
      artifactId: "script",
      episodeId: request.episodeId,
      contentRevision: 1,
    },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const c = client(async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(output);
  }, null);
  assert.deepEqual(await c.projectAssetStages.getScriptSource(request), output);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.redirect, "manual");
  const url = new URL(calls[0]!.url);
  assert.equal(
    url.pathname,
    `/api/v1/threads/${encodeURIComponent(threadId)}/project-asset-stage/script-source`,
  );
  assert.equal(url.searchParams.get("projectId"), request.projectId);
  assert.equal(
    new Headers(calls[0]!.init.headers).get("authorization"),
    "Bearer fixture-token",
  );
  assert.equal(
    new Headers(calls[0]!.init.headers).get("idempotency-key"),
    null,
  );
  for (const bad of [
    { ...output, threadId: "foreign" },
    { ...output, script: { ...output.script, episodeId: "foreign" } },
    { ...output, content: "unbounded" },
  ])
    await assert.rejects(
      client(async () => Response.json(bad)).projectAssetStages.getScriptSource(
        request,
      ),
      ControlApiProtocolError,
    );
  await assert.rejects(
    c.projectAssetStages.getScriptSource({
      ...request,
      actorId: "forged",
    } as never),
    ControlApiProtocolError,
  );
  assert.equal(calls.length, 1);
  const gate = new AbortController();
  gate.abort();
  await assert.rejects(
    c.projectAssetStages.getScriptSource(request, { signal: gate.signal }),
  );
  assert.equal(calls.length, 1);
});
