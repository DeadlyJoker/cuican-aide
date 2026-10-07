import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
const bytes = new Uint8Array(64).fill(137);
const candidate = {
  projectId: "project/雨夜",
  candidateId: "result-" + "a".repeat(64),
  runId: "run/one",
  resultIndex: 0,
  executionId: "original-execution",
  mediaInputId: "original-input",
  inputRevision: 2,
  workflowId: "krea2-reference-four-view" as const,
  item: { kind: "character-reference" as const, assetId: "hero" },
  contentDigest: "sha256:" + "b".repeat(64),
  media: {
    type: "image/png" as const,
    byteDigest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    width: 2,
    height: 1,
    observedAt: "2026-10-07T00:00:00.000Z",
  },
};
const locator = {
  projectId: candidate.projectId,
  runId: candidate.runId,
  resultIndex: candidate.resultIndex,
};
const client = (
  fetch: typeof globalThis.fetch,
  csrfToken: string | null = "original-csrf",
) =>
  new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "original-session",
    csrfToken,
    origin: "https://ui.test",
    fetch,
  }).projectMediaResults;
const headers = {
  "content-type": "image/png",
  "content-length": String(bytes.length),
  "x-crewon-candidate-id": candidate.candidateId,
  "x-crewon-byte-digest": candidate.media.byteDigest,
};
test("publication sends an authenticated CSRF-bound empty JSON object and metadata is tied to the exact original position", async () => {
  let calls = 0;
  const c = client(async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      "https://control.test/api/v1/creative-projects/project%2F%E9%9B%A8%E5%A4%9C/media-results/run%2Fone/0",
    );
    assert.equal(init?.redirect, "manual");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer original-session",
    );
    if (init?.method === "POST") {
      assert.equal(init.body, "{}");
      assert.equal(
        new Headers(init.headers).get("x-csrf-token"),
        "original-csrf",
      );
      return Response.json({ disposition: "created", candidate });
    }
    return Response.json({ candidate: { ...candidate, resultIndex: 1 } });
  });
  assert.deepEqual((await c.publish(locator)).candidate, candidate);
  await assert.rejects(c.getCandidate(locator), ControlApiProtocolError);
  await assert.rejects(
    client(async () => {
      throw new Error("must-not-fetch");
    }, null).publish(locator),
  );
  assert.equal(calls, 2);
});
test("image reads use original credentials and verify complete byte digest", async () => {
  const c = client(async (url, init) => {
    assert.ok(String(url).endsWith("/media-results/run%2Fone/0/content"));
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "include");
    assert.equal(init?.redirect, "manual");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer original-session",
    );
    assert.equal(new Headers(init?.headers).get("accept"), "image/png");
    return new Response(bytes, { headers });
  });
  assert.deepEqual(await c.readContent(candidate), bytes);
});
test("content mismatches, missing/oversized bytes, redirects and foreign candidate headers never become a preview", async () => {
  for (const response of [
    new Response(bytes, {
      headers: {
        ...headers,
        "x-crewon-candidate-id": "result-" + "c".repeat(64),
      },
    }),
    new Response(bytes, {
      headers: { ...headers, "content-type": "text/html" },
    }),
    new Response(bytes, {
      headers: { ...headers, "content-encoding": "gzip" },
    }),
    new Response(bytes.slice(1), { headers }),
    new Response(new Uint8Array(bytes.length + 1), { headers }),
    new Response(new Uint8Array(bytes.length), { headers }),
    new Response(null, {
      status: 302,
      headers: { location: "https://foreign.test" },
    }),
  ]) {
    let calls = 0;
    await assert.rejects(
      client(async () => {
        calls++;
        return response;
      }).readContent(candidate),
    );
    assert.equal(calls, 1);
  }
});
test("abort cancels pending image body and returns no partial preview", async () => {
  const controller = new AbortController();
  let canceled = false,
    entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      entered();
    },
    cancel() {
      canceled = true;
    },
  });
  const pending = client(
    async () => new Response(stream, { headers }),
  ).readContent(candidate, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  await started;
  controller.abort(new Error("named-content-cancel"));
  await rejected;
  assert.equal(canceled, true);
});
