import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
const request = {
  projectId: "project/雨夜",
  afterCandidateId: "result-" + "a".repeat(64),
  limit: 16,
};
const client = (fetch: typeof globalThis.fetch) =>
  new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "original-session",
    csrfToken: null,
    origin: "https://ui.test",
    fetch,
  });
test("result client keeps original authentication, encoded project and read-only bounded transport", async () => {
  let calls = 0;
  const c = client(async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      `https://control.test/api/v1/creative-projects/${encodeURIComponent(request.projectId)}/media-results?limit=16&afterCandidateId=${request.afterCandidateId}`,
    );
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer original-session");
    assert.equal(headers.get("origin"), "https://ui.test");
    assert.equal(headers.get("x-csrf-token"), null);
    return Response.json({ candidates: [], nextCandidateId: null });
  });
  assert.equal(c.projectMediaResults, c.projectMediaResults);
  assert.deepEqual(await c.projectMediaResults.listCandidates(request), {
    candidates: [],
    nextCandidateId: null,
  });
  await assert.rejects(
    c.projectMediaResults.listCandidates({ ...request, limit: 17 }),
    ControlApiProtocolError,
  );
  await assert.rejects(
    c.projectMediaResults.listCandidates(request, {
      signal: AbortSignal.abort(),
    }),
    ControlApiProtocolError,
  );
  let invoked = false;
  await assert.rejects(
    c.projectMediaResults.listCandidates(request, {
      get signal() {
        invoked = true;
        return undefined;
      },
    }),
    ControlApiProtocolError,
  );
  assert.equal(invoked, false);
  assert.equal(calls, 1);
});
test("result client rejects invalid or oversized catalog and does not retry errors or redirects", async () => {
  for (const value of [
    { candidates: [], nextCandidateId: request.afterCandidateId },
    { candidates: [], nextCandidateId: null, authority: true },
    { candidates: new Array(17).fill({}), nextCandidateId: null },
  ]) {
    let calls = 0;
    await assert.rejects(
      client(async () => {
        calls++;
        return Response.json(value);
      }).projectMediaResults.listCandidates(request),
      ControlApiProtocolError,
    );
    assert.equal(calls, 1);
  }
  for (const response of [
    new Response("x".repeat(64 * 1024 + 1), { status: 200 }),
    new Response(null, {
      status: 302,
      headers: { location: "https://foreign.test" },
    }),
    new Response("unavailable", { status: 503 }),
  ]) {
    let calls = 0;
    await assert.rejects(
      client(async () => {
        calls++;
        return response;
      }).projectMediaResults.listCandidates(request),
    );
    assert.equal(calls, 1);
  }
});
