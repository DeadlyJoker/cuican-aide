import assert from "node:assert/strict";
import test from "node:test";
import {
  parseListProjectMediaResultsRequest as request,
  parseListProjectMediaResultsResponse as response,
} from "./project-media-results.ts";
const query = { projectId: "project/雨夜", afterCandidateId: null, limit: 2 };
const candidate = {
  projectId: query.projectId,
  candidateId: "result-" + "a".repeat(64),
  runId: "run-original",
  resultIndex: 0,
  executionId: "execution-original",
  mediaInputId: "input-original",
  inputRevision: 2,
  workflowId: "krea2-reference-four-view",
  item: { kind: "character-reference", assetId: "hero" },
  contentDigest: "sha256:" + "b".repeat(64),
  media: {
    type: "image/png",
    byteDigest: "sha256:" + "c".repeat(64),
    byteLength: 123,
    width: 1280,
    height: 720,
    observedAt: "2026-10-07T00:00:00.000Z",
  },
};
test("candidate catalog keeps bounded original source selectors and media metadata", () => {
  const result = response(query, {
    candidates: [candidate],
    nextCandidateId: null,
  });
  assert.deepEqual(result.candidates, [candidate]);
  assert.ok(Object.isFrozen(result.candidates[0]!.media));
  assert.deepEqual(request(query), query);
  assert.deepEqual(
    response(query, {
      candidates: [
        {
          ...candidate,
          workflowId: "flux2-three-reference-storyboard",
          item: { kind: "storyboard-frame-exploration", episodeId: "first" },
        },
      ],
      nextCandidateId: null,
    }).candidates[0]!.item,
    { kind: "storyboard-frame-exploration", episodeId: "first" },
  );
});
test("candidate catalog rejects authority injection, malformed cursor, foreign result and unbounded media", () => {
  for (const q of [
    { ...query, limit: 0 },
    { ...query, limit: 17 },
    { ...query, afterCandidateId: "" },
    { ...query, afterCandidateId: "result-ABC" },
    { ...query, actor: "owner" },
  ])
    assert.throws(() => request(q));
  let invoked = false;
  assert.throws(() =>
    request({
      ...query,
      get limit() {
        invoked = true;
        return 1;
      },
    }),
  );
  assert.equal(invoked, false);
  for (const c of [
    { ...candidate, projectId: "foreign" },
    { ...candidate, url: "https://provider.test/view" },
    { ...candidate, resultIndex: 16 },
    { ...candidate, workflowId: "unknown" },
    {
      ...candidate,
      item: { kind: "storyboard-frame-exploration", episodeId: "first" },
    },
    {
      ...candidate,
      media: { ...candidate.media, byteLength: 16 * 1024 * 1024 + 1 },
    },
    { ...candidate, media: { ...candidate.media, width: 4097 } },
  ])
    assert.throws(() =>
      response(query, { candidates: [c], nextCandidateId: null }),
    );
});
test("candidate catalog rejects duplicate original positions, out-of-order or false cursors", () => {
  const second = {
    ...candidate,
    candidateId: "result-" + "d".repeat(64),
    resultIndex: 1,
  };
  assert.equal(
    response(query, {
      candidates: [candidate, second],
      nextCandidateId: second.candidateId,
    }).nextCandidateId,
    second.candidateId,
  );
  for (const page of [
    { candidates: [second, candidate], nextCandidateId: null },
    {
      candidates: [candidate, { ...second, resultIndex: 0 }],
      nextCandidateId: null,
    },
    { candidates: [candidate], nextCandidateId: candidate.candidateId },
    { candidates: [candidate, second], nextCandidateId: candidate.candidateId },
    { candidates: [candidate, second, second], nextCandidateId: null },
  ])
    assert.throws(() => response(query, page));
  assert.throws(() =>
    response(
      { ...query, afterCandidateId: candidate.candidateId },
      { candidates: [candidate], nextCandidateId: null },
    ),
  );
});

test("maximum page of multibyte original identifiers fits the public response budget", () => {
  const name = "角".repeat(128);
  const candidates = Array.from({ length: 16 }, (_, index) => ({
    ...candidate,
    projectId: name,
    candidateId: "result-" + index.toString(16).padStart(64, "0"),
    runId: name,
    resultIndex: index,
    executionId: name,
    mediaInputId: name,
    item: { kind: "character-reference", assetId: name },
    media: { ...candidate.media, byteLength: 16 * 1024 * 1024 },
  }));
  assert.equal(
    response(
      { projectId: name, afterCandidateId: null, limit: 16 },
      { candidates, nextCandidateId: null },
    ).candidates.length,
    16,
  );
});
