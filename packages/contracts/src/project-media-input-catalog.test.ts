import assert from "node:assert/strict";
import test from "node:test";
import {
  parseListMediaInputsRequest as query,
  parseListMediaInputsResponse as page,
  parseMediaInputOptionsResponse as options,
} from "./project-media-input-catalog.ts";
test("media input discovery is bounded, ordered and contains only exact logical identities", () => {
  const q = query({ projectId: "p", afterMediaInputId: null, limit: 1 });
  const row = {
    projectId: "p",
    mediaInputId: "input-1",
    latestInputRevision: 2,
    item: { kind: "character-reference", assetId: "character" },
    workflowId: "krea2-reference-four-view",
    createdAt: "2026-10-06T00:00:00.000Z",
  };
  assert.deepEqual(page(q, { inputs: [row], nextMediaInputId: "input-1" }), {
    inputs: [row],
    nextMediaInputId: "input-1",
  });
  for (const invalid of [
    { inputs: [{ ...row, projectId: "other" }], nextMediaInputId: null },
    { inputs: [row, row], nextMediaInputId: null },
    { inputs: [{ ...row, prompt: "private" }], nextMediaInputId: null },
    { inputs: [], nextMediaInputId: "input-1" },
    { inputs: [row], nextMediaInputId: "input-2" },
  ])
    assert.throws(() => page(q, invalid));
  assert.throws(() =>
    page(
      { ...q, afterMediaInputId: "input-1" },
      { inputs: [row], nextMediaInputId: null },
    ),
  );
  for (const limit of [0, 17, 1.5]) assert.throws(() => query({ ...q, limit }));
  assert.throws(() =>
    options({ configuration: { revision: 1, workflows: ["video"] } }),
  );
  assert.throws(() =>
    options({
      configuration: {
        revision: 1,
        workflows: ["krea2-reference-four-view"],
        baseUrl: "https://supplier/",
      },
    }),
  );
  let getters = 0;
  const input = Object.defineProperty({}, "projectId", {
    enumerable: true,
    get() {
      getters++;
      return "p";
    },
  });
  assert.throws(() => query(input));
  assert.equal(getters, 0);
});
