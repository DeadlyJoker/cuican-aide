import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PROJECT_TEXT_RESPONSE_BYTES } from "@crewon/contracts";
import {
  publicTextOutline as outline,
  publicTextScript as script,
  publicTextArtifact as artifact,
  publicTextRevision as revision,
  publicTextView as view,
  textProjectId as projectId,
  textEpisodeId as episodeId,
} from "../../contracts/src/project-text-control.test-support.ts";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import {
  ProjectTextControlClient,
  type ProjectTextControlTransport,
} from "./project-text-control-client.ts";
const root = `/api/v1/creative-projects/${encodeURIComponent(projectId)}/text-artifacts`;
const item = `${root}/items/outline`;
const candidate = {
  expectedArtifactRevision: 0,
  briefRevision: 1,
  content: outline,
};
function api(
  fetch: typeof globalThis.fetch,
  csrfToken: string | null = "actual-csrf",
) {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "actual-token",
    csrfToken,
    origin: "https://ui.test",
    fetch,
  });
}
const requestInvalid = (e: unknown) =>
  e instanceof ControlApiProtocolError &&
  e.code === "control_client_project_text_request_invalid";
const responseInvalid = (e: unknown) =>
  e instanceof ControlApiProtocolError &&
  e.code === "control_client_project_text_response_invalid";

test("all ten text methods use original authenticated transport, exact items namespace and once-encoded identity", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const scriptArtifact = {
    ...artifact,
    artifactId: "scripts",
    kind: "script",
    episodeId,
  };
  const scriptRevision = {
    ...revision,
    artifactId: "scripts",
    kind: "script",
    episodeId,
    content: script,
    outline: null,
  };
  const responses = [
    { artifacts: [artifact], nextArtifactId: null },
    { view },
    {
      kind: "save-outline",
      disposition: "committed",
      artifact,
      contentRevision: revision,
    },
    { view: null },
    {
      kind: "save-script",
      disposition: "replayed",
      artifact: scriptArtifact,
      contentRevision: scriptRevision,
    },
    { view },
    { revisions: [revision], nextContentRevision: 1 },
    { contentRevision: revision },
    {
      kind: "select-revision",
      disposition: "committed",
      artifact: view.artifact,
      contentRevision: revision,
    },
    {
      kind: "set-lock",
      disposition: "committed",
      artifact: { ...view.artifact, revision: 3, locked: true },
      contentRevision: null,
    },
  ];
  const client = api(async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return Response.json(responses.shift());
  });
  assert.equal(client.projectTexts, client.projectTexts);
  await client.projectTexts.listArtifacts(projectId, {
    afterArtifactId: null,
    limit: 16,
  });
  await client.projectTexts.getOutline(projectId);
  await client.projectTexts.saveOutlineCandidate(
    projectId,
    candidate,
    "outline-key",
  );
  await client.projectTexts.getScript(projectId, episodeId);
  await client.projectTexts.saveScriptCandidate(
    projectId,
    episodeId,
    { ...candidate, outline: null, content: script },
    "script-key",
  );
  await client.projectTexts.getArtifact(projectId, "outline");
  await client.projectTexts.listRevisions(projectId, "outline", {
    afterContentRevision: 0,
    limit: 1,
  });
  await client.projectTexts.getRevision(projectId, "outline", 1);
  await client.projectTexts.selectRevision(
    projectId,
    "outline",
    { expectedArtifactRevision: 1, contentRevision: 1 },
    "select-key",
  );
  await client.projectTexts.setLocked(
    projectId,
    "outline",
    { expectedArtifactRevision: 2, locked: true },
    "lock-key",
  );
  assert.deepEqual(
    calls.map((c) => [
      new URL(c.url).pathname + new URL(c.url).search,
      c.init.method,
    ]),
    [
      [`${root}?limit=16`, "GET"],
      [`${root}/outline`, "GET"],
      [`${root}/outline/candidates`, "POST"],
      [`${root}/scripts/${encodeURIComponent(episodeId)}`, "GET"],
      [`${root}/scripts/${encodeURIComponent(episodeId)}/candidates`, "POST"],
      [item, "GET"],
      [`${item}/revisions?afterContentRevision=0&limit=1`, "GET"],
      [`${item}/revisions/1`, "GET"],
      [`${item}/selection`, "PUT"],
      [`${item}/lock`, "PUT"],
    ],
  );
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("authorization"), "Bearer actual-token");
    assert.equal(headers.get("origin"), "https://ui.test");
    assert.equal(call.init.redirect, "manual");
    if (call.init.method !== "GET") {
      assert.equal(headers.get("x-csrf-token"), "actual-csrf");
      assert.ok(headers.get("idempotency-key"));
    } else assert.equal(headers.get("x-csrf-token"), null);
  }
  assert.deepEqual(JSON.parse(String(calls[4]!.init.body)), {
    ...candidate,
    outline: null,
    content: script,
  });
});
test("text request guards reject owner fields, noncanonical queries and invalid input before fetch", async () => {
  let fetches = 0,
    getters = 0;
  const client = api(async () => {
    fetches++;
    return Response.json({});
  });
  const bad = { ...candidate };
  Object.defineProperty(bad, "content", {
    enumerable: true,
    get: () => {
      getters++;
      return outline;
    },
  });
  for (const input of [bad, { ...candidate, principalId: "other" }])
    await assert.rejects(
      client.projectTexts.saveOutlineCandidate(projectId, input, "key"),
      requestInvalid,
    );
  await assert.rejects(
    client.projectTexts.listRevisions(projectId, "outline", {
      afterContentRevision: "1",
    } as never),
    requestInvalid,
  );
  await assert.rejects(
    client.projectTexts.listArtifacts(projectId, { limit: 17 }),
    requestInvalid,
  );
  await assert.rejects(
    client.projectTexts.saveScriptCandidate(
      projectId,
      episodeId,
      { ...candidate, content: script } as never,
      "key",
    ),
    requestInvalid,
  );
  await assert.rejects(
    client.projectTexts.getArtifact(projectId, ".."),
    requestInvalid,
  );
  await assert.rejects(
    client.projectTexts.saveOutlineCandidate(projectId, candidate, ""),
    requestInvalid,
  );
  await assert.rejects(
    client.projectTexts.saveOutlineCandidate(
      projectId,
      candidate,
      "once,twice",
    ),
    requestInvalid,
  );
  assert.equal(fetches, 0);
  assert.equal(getters, 0);
});
test("text replies reject mixed identity, substituted content/cursor and leaked server ownership", async () => {
  for (const reply of [
    { view: { ...view, artifact: { ...view.artifact, projectId: "other" } } },
    { view: { ...view, artifact: { ...view.artifact, tenantId: "private" } } },
    {
      view: { ...view, selectedRevision: { ...revision, artifactId: "other" } },
    },
  ])
    await assert.rejects(
      api(async () => Response.json(reply)).projectTexts.getArtifact(
        projectId,
        "outline",
      ),
      responseInvalid,
    );
  await assert.rejects(
    api(async () =>
      Response.json({ revisions: [revision], nextContentRevision: 2 }),
    ).projectTexts.listRevisions(projectId, "outline"),
    responseInvalid,
  );
  await assert.rejects(
    api(async () =>
      Response.json({
        kind: "save-outline",
        disposition: "replayed",
        artifact,
        contentRevision: {
          ...revision,
          content: { ...outline, synopsis: "substituted" },
        },
      }),
    ).projectTexts.saveOutlineCandidate(projectId, candidate, "same-key"),
    responseInvalid,
  );
});
test("real Control errors, redirect and missing CSRF never become successful text receipts", async () => {
  await assert.rejects(
    api(async () =>
      Response.json(
        {
          error: {
            category: "conflict",
            code: "project_text_revision_conflict",
            message: "CAS mismatch",
            requestId: "request-text",
          },
        },
        { status: 409 },
      ),
    ).projectTexts.saveOutlineCandidate(projectId, candidate, "key"),
    (e) =>
      e instanceof ControlApiClientError &&
      e.status === 409 &&
      e.code === "project_text_revision_conflict",
  );
  await assert.rejects(
    api(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.test" },
        }),
    ).projectTexts.getOutline(projectId),
    ControlApiProtocolError,
  );
  let fetches = 0;
  await assert.rejects(
    api(async () => {
      fetches++;
      return Response.json({});
    }, null).projectTexts.saveOutlineCandidate(projectId, candidate, "key"),
    ControlApiProtocolError,
  );
  assert.equal(fetches, 0);
});
test("text transport applies sixty-KiB byte budget and cancels oversized stream", async () => {
  let canceled = false;
  await assert.rejects(
    api(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new Uint8Array(MAX_PROJECT_TEXT_RESPONSE_BYTES + 1),
              );
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ).projectTexts.getOutline(projectId),
    { code: "control_client_workspace_response_too_large" },
  );
  assert.equal(canceled, true);
});
test("text deadline and caller cancellation fence late receipts from uncooperative transports", async () => {
  let resolve!: (value: unknown) => void, signal: AbortSignal | undefined;
  const transport: ProjectTextControlTransport = {
    json: (_m, _p, _b, options) => {
      signal = options.signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
    protocolError: (code) => new ControlApiProtocolError(code),
  };
  const timed = new ProjectTextControlClient(transport, { deadlineMs: 5 });
  await assert.rejects(timed.getOutline(projectId), { name: "TimeoutError" });
  assert.equal(signal?.aborted, true);
  resolve({ view });
  const caller = new AbortController(),
    reason = new Error("owner withdrawn");
  const pending = new ProjectTextControlClient(transport).getOutline(
    projectId,
    { signal: caller.signal },
  );
  caller.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
  resolve({ view });
  let fetches = 0;
  await assert.rejects(
    api(async () => {
      fetches++;
      return Response.json({ view });
    }).projectTexts.getOutline(projectId, { signal: caller.signal }),
    (e) => e === reason,
  );
  assert.equal(fetches, 0);
});
test("successful text calls remove caller listeners and clear request deadline scope", async () => {
  const caller = new AbortController();
  let scope: AbortSignal | undefined;
  const client = new ProjectTextControlClient(
    {
      json: async (_m, _p, _b, options) => {
        scope = options.signal;
        return { view };
      },
      protocolError: (code) => new ControlApiProtocolError(code),
    },
    { deadlineMs: 5 },
  );
  await client.getOutline(projectId, { signal: caller.signal });
  caller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scope?.aborted, false);
});
