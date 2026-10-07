import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_MEDIA_RESULT_UI_ACTIONS as actions,
  PROJECT_MEDIA_RESULT_WRITE_ACTIONS as writes,
  parseProjectMediaResultUiRequest as parse,
  parseProjectMediaResultUiResponse as response,
} from "./project-media-results-ui.ts";
test("result UI is read-only, bounded, and does not accept transport or theme data", () => {
  const q = {
    action: actions.listCandidates,
    input: { projectId: "project", afterCandidateId: null, limit: 16 },
  };
  assert.deepEqual(parse(q), q);
  assert.deepEqual(
    response(parse(q), { candidates: [], nextCandidateId: null }),
    { candidates: [], nextCandidateId: null },
  );
  for (const input of [
    { ...q.input, limit: 17 },
    { ...q.input, theme: {} },
    { ...q.input, url: "https://provider/view" },
  ])
    assert.throws(() => parse({ ...q, input }));
  for (const action of [
    actions.releasePreview,
    "crewon.project-media-results.v1.publish",
    "crewon.project-media-results.v2.preview",
  ])
    assert.throws(() =>
      parse({
        action,
        input: { projectId: "project", runId: "run", resultIndex: 0 },
      }),
    );
});

test("result actions are independently declared, contain only original selectors, and validate contiguous observed positions", () => {
  const q = {
    action: writes.listOutputs,
    input: { projectId: "p", runId: "r" },
  };
  assert.deepEqual(parse(q), q);
  const value = {
    ...q.input,
    mediaInputId: "input",
    inputRevision: 2,
    outputs: [
      { resultIndex: 0, candidate: null },
      { resultIndex: 1, candidate: null },
    ],
  };
  assert.deepEqual(response(parse(q), value), value);
  for (const outputs of [
    [],
    [{ resultIndex: 1, candidate: null }],
    [
      { resultIndex: 0, candidate: null },
      { resultIndex: 0, candidate: null },
    ],
    Array.from({ length: 17 }, (_, resultIndex) => ({
      resultIndex,
      candidate: null,
    })),
  ])
    assert.throws(() => response(parse(q), { ...value, outputs }));
  assert.throws(() => response(parse(q), { ...value, runId: "wrong" }));
  assert.throws(() =>
    parse({
      action: writes.saveCandidate,
      input: { ...q.input, resultIndex: 0, url: "https://provider/output.png" },
    }),
  );
  assert.throws(() =>
    parse({
      action: "crewon.project-media-result-actions.v1.adopt",
      input: { ...q.input, resultIndex: 0 },
    }),
  );
});
