import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_MEDIA_RESULT_UI_ACTIONS as actions,
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
