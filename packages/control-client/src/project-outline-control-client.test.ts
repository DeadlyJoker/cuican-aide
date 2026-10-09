import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
const projectId = "project/中文 %2F",
  artifactId = "outline/中文 %2F";
const contentDigest = "sha256:" + "a".repeat(64);
const revision = {
  projectId,
  artifactId,
  contentRevision: 1,
  contentDigest,
  brief: { briefRevision: 1, contentDigest },
  format: "legacy-v1",
  title: "大纲",
  createdAt: "2026-10-09T00:00:00.000Z",
  counts: { episodes: 1, characters: 0, scenes: 0, props: 0, beats: 0 },
  quality: null,
};
const query = {
  projectId,
  artifactId,
  contentRevision: 1,
  contentDigest,
  section: "episodes" as const,
  afterIndex: 0,
  limit: 10,
};
const page = {
  revision,
  section: "episodes",
  startIndex: 0,
  totalItems: 1,
  items: [{ episodeId: "first", title: "第一集" }],
  nextIndex: null,
};
function api(fetch: typeof globalThis.fetch) {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "actual-session",
    origin: "https://ui.test",
    fetch,
  });
}
test("outline methods use original authenticated GET transport with once encoded identities", async () => {
  const calls: { url: URL; options: RequestInit }[] = [];
  const replies = [
    { view: null },
    page,
    { revisions: [revision], nextContentRevision: null },
  ];
  const client = api(async (url, options) => {
    calls.push({ url: new URL(String(url)), options: options! });
    return Response.json(replies.shift());
  });
  assert.equal(client.projectOutlines, client.projectOutlines);
  await client.projectOutlines.getOutline({ projectId });
  await client.projectOutlines.getSection(query);
  await client.projectOutlines.listRevisions({
    projectId,
    artifactId,
    afterContentRevision: 0,
    limit: 10,
  });
  const root = `/api/v2/creative-projects/${encodeURIComponent(projectId)}/outline`;
  assert.deepEqual(
    calls.map((c) => c.url.pathname),
    [root, root + "/sections", root + "/revisions"],
  );
  assert.equal(calls[1]!.url.searchParams.get("artifactId"), artifactId);
  for (const { options } of calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer actual-session",
    );
    assert.equal(new Headers(options.headers).get("origin"), "https://ui.test");
    assert.equal(options.body, undefined);
  }
});
test("outline reads reject substitutions, oversized replies and invalid requests", async () => {
  for (const reply of [
    {
      ...page,
      revision: { ...revision, contentDigest: "sha256:" + "b".repeat(64) },
    },
    { ...page, revision: { ...revision, projectId: "other" } },
    { ...page, extra: true },
  ])
    await assert.rejects(
      api(async () => Response.json(reply)).projectOutlines.getSection(query),
      (e) => e instanceof ControlApiProtocolError,
    );
  await assert.rejects(
    api(async () =>
      Response.json({ padding: "x".repeat(70 * 1024) }),
    ).projectOutlines.getOutline({ projectId }),
  );
  let fetched = false;
  await assert.rejects(
    api(async () => {
      fetched = true;
      return Response.json({});
    }).projectOutlines.getSection({ ...query, limit: 11 }),
    (e) => e instanceof ControlApiProtocolError,
  );
  assert.equal(fetched, false);
});
test("caller abort settles promptly even if the HTTP implementation ignores cancellation", async () => {
  const controller = new AbortController();
  const pending = api(
    async () => new Promise<Response>(() => {}),
  ).projectOutlines.getOutline({ projectId }, { signal: controller.signal });
  controller.abort(new Error("original-view-disposed"));
  await assert.rejects(pending, /original-view-disposed/);
});
