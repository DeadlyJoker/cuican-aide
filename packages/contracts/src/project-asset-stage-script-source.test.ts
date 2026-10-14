import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectAssetScriptSourceRequest as request,
  parseProjectAssetScriptSourceQuery as query,
  parseProjectAssetScriptSourceResponse as response,
  projectAssetScriptSourcePath,
} from "./project-asset-stage-script-source.ts";
const input = {
  projectId: "project/中",
  threadId: "thread/中",
  expectedBindingRevision: 2,
  briefRevision: 3,
  episodeId: "episode 1",
};
const output = {
  projectId: input.projectId,
  threadId: input.threadId,
  bindingRevision: 2,
  briefRevision: 3,
  episodeId: input.episodeId,
  script: {
    artifactId: "script",
    episodeId: input.episodeId,
    contentRevision: 4,
  },
};
test("asset source is bounded to exact project, Thread, binding, brief and episode refs", () => {
  assert.deepEqual(response(input, output), output);
  assert.deepEqual(response(input, { ...output, script: null }).script, null);
  const path = projectAssetScriptSourcePath(input),
    url = new URL(path, "https://test.invalid");
  assert.equal(
    url.pathname,
    "/api/v1/threads/thread%2F%E4%B8%AD/project-asset-stage/script-source",
  );
  assert.deepEqual(
    query(input.threadId, Object.fromEntries(url.searchParams)),
    input,
  );
  for (const invalid of [
    { ...input, actorId: "claimed" },
    { ...input, expectedBindingRevision: 0 },
    { ...input, episodeId: "x".repeat(5000) },
  ])
    assert.throws(() => request(invalid));
  for (const invalid of [
    { ...output, projectId: "foreign" },
    { ...output, threadId: "foreign" },
    { ...output, bindingRevision: 3 },
    { ...output, briefRevision: 4 },
    { ...output, episodeId: "foreign" },
    { ...output, script: { ...output.script, episodeId: "foreign" } },
    { ...output, content: "not exposed" },
  ])
    assert.throws(() => response(input, invalid));
  for (const invalid of ["01", "1e0", "-1", "0", "1.0", "9007199254740992"])
    assert.throws(() =>
      query(input.threadId, {
        projectId: input.projectId,
        expectedBindingRevision: invalid,
        briefRevision: "3",
        episodeId: input.episodeId,
      }),
    );
});
