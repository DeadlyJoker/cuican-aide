import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ContractValidationError,
  parseProjectTextOutlineContent,
  parseProjectTextScriptContent,
  parseSaveProjectOutlineCandidateRequest,
  parseSaveProjectScriptCandidateRequest,
  parseSelectProjectTextRevisionRequest,
  parseSetProjectTextArtifactLockedRequest,
  parseProjectTextArtifactListQuery,
  parseProjectTextRevisionListQuery,
  parseProjectTextContentRevision,
  parseProjectTextIdempotencyKey,
  parsePublicProjectTextArtifactView,
  parseProjectTextMutationResponse,
  parseProjectTextRevisionListResponse,
  parseProjectTextArtifactListResponse,
} from "./index.ts";
import {
  publicTextOutline as outline,
  publicTextScript as script,
  publicTextArtifact as artifact,
  publicTextRevision as revision,
  publicTextView as view,
  textProjectId as projectId,
  textEpisodeId as episodeId,
} from "./project-text-control.test-support.ts";
const invalid = (error: unknown) =>
  error instanceof ContractValidationError &&
  error.code === "project_text_control_contract_invalid";
const candidate = {
  expectedArtifactRevision: 0,
  briefRevision: 1,
  content: outline,
};

test("text requests preserve creative Unicode whitespace and explicit manual script provenance", () => {
  assert.deepEqual(
    parseSaveProjectOutlineCandidateRequest(candidate),
    candidate,
  );
  assert.deepEqual(
    parseSaveProjectScriptCandidateRequest({
      ...candidate,
      outline: null,
      content: script,
    }),
    { ...candidate, outline: null, content: script },
  );
  assert.deepEqual(
    parseSaveProjectScriptCandidateRequest({
      ...candidate,
      outline: { artifactId: "outline", contentRevision: 1 },
      content: script,
    }).outline,
    { artifactId: "outline", contentRevision: 1 },
  );
  assert.equal(
    parseProjectTextOutlineContent(outline).logline,
    outline.logline,
  );
  assert.equal(
    parseProjectTextScriptContent(script).scenes[0]!.action,
    script.scenes[0].action,
  );
  assert.equal(
    Object.isFrozen(parseProjectTextOutlineContent(outline).episodes[0]),
    true,
  );
});
test("text mutations reject unexpected owner identity, non-data objects and missing provenance without invoking getters", () => {
  let calls = 0;
  const accessor = { ...candidate };
  Object.defineProperty(accessor, "content", {
    enumerable: true,
    get: () => {
      calls++;
      return outline;
    },
  });
  for (const value of [
    { ...candidate, ownerPrincipalId: "owner" },
    { ...candidate, tenantId: "other" },
    accessor,
    { ...candidate, [Symbol("x")]: 1 },
    Object.assign(Object.create({ extra: 1 }), candidate),
  ])
    assert.throws(
      () => parseSaveProjectOutlineCandidateRequest(value),
      invalid,
    );
  assert.equal(calls, 0);
  assert.throws(
    () =>
      parseSaveProjectScriptCandidateRequest({ ...candidate, content: script }),
    invalid,
  );
  assert.throws(
    () =>
      parseSelectProjectTextRevisionRequest({
        expectedArtifactRevision: 0,
        contentRevision: 1,
      }),
    invalid,
  );
  assert.throws(
    () =>
      parseSetProjectTextArtifactLockedRequest({
        expectedArtifactRevision: 1,
        locked: "true",
      }),
    invalid,
  );
});
test("content rejects duplicate slots, empty scenes, illegal scalars and UTF-8 overflow", () => {
  for (const value of [
    { ...outline, episodes: [outline.episodes[0], outline.episodes[0]] },
    { ...outline, logline: "中".repeat(683) },
    { ...outline, synopsis: "\ud800" },
    { ...outline, synopsis: "x\u007f" },
    { ...outline, title: " 不可自动裁剪 " },
    { ...outline, episodes: [] },
    {
      ...outline,
      episodes: Array.from({ length: 17 }, (_, i) => ({
        ...outline.episodes[0],
        episodeId: `episode-${i}`,
      })),
    },
  ])
    assert.throws(() => parseProjectTextOutlineContent(value), invalid);
  for (const value of [
    {
      ...script,
      scenes: [{ ...script.scenes[0], action: " \n", dialogue: [] }],
    },
    { ...script, scenes: [script.scenes[0], script.scenes[0]] },
    { ...script, scenes: [{ ...script.scenes[0], location: "x".repeat(641) }] },
  ])
    assert.throws(() => parseProjectTextScriptContent(value), invalid);
  assert.equal(
    parseProjectTextScriptContent({
      ...script,
      scenes: [{ ...script.scenes[0], action: "" }],
    }).scenes[0]!.action,
    "",
  );
});
test("canonical content byte limits cover aggregate records rather than individual fields only", () => {
  const largeOutline = {
    ...outline,
    synopsis: "x".repeat(8192),
    episodes: [{ ...outline.episodes[0], summary: "x".repeat(8192) }],
  };
  assert.throws(() => parseProjectTextOutlineContent(largeOutline), invalid);
  const largeScript = {
    ...script,
    scenes: Array.from({ length: 5 }, (_, i) => ({
      ...script.scenes[0],
      sceneId: `scene-${i}`,
      action: "x".repeat(8192),
    })),
  };
  assert.throws(() => parseProjectTextScriptContent(largeScript), invalid);
});
test("queries are exact, canonical and bounded; content revision cannot be coerced", () => {
  assert.deepEqual(parseProjectTextArtifactListQuery({}), {
    afterArtifactId: null,
    limit: 16,
  });
  assert.deepEqual(parseProjectTextRevisionListQuery({}), {
    afterContentRevision: 0,
    limit: 16,
  });
  for (const value of [
    { limit: "17" },
    { limit: ["1", "2"] },
    { limit: "01" },
    { afterArtifactId: "owner", principalId: "other" },
  ])
    assert.throws(() => parseProjectTextArtifactListQuery(value), invalid);
  for (const value of [
    "0",
    "01",
    "1e0",
    "1.0",
    "1\n",
    -1,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => parseProjectTextContentRevision(value), invalid);
  assert.equal(parseProjectTextContentRevision("12"), 12);
  for (const key of ["once,twice", ["once", "twice"], " key "])
    assert.throws(() => parseProjectTextIdempotencyKey(key), invalid);
});
test("views strictly bind selected immutable identity and actual dependency status", () => {
  assert.deepEqual(parsePublicProjectTextArtifactView(view), view);
  assert.deepEqual(
    parsePublicProjectTextArtifactView({
      ...view,
      dependencyState: "stale",
      staleReasons: ["brief-changed"],
    }).staleReasons,
    ["brief-changed"],
  );
  for (const value of [
    { ...view, selectedRevision: { ...revision, projectId: "other" } },
    { ...view, artifact: { ...view.artifact, selectedContentRevision: 2 } },
    { ...view, dependencyState: "stale", staleReasons: [] },
    {
      ...view,
      dependencyState: "stale",
      staleReasons: ["outline-selection-changed"],
    },
    {
      ...view,
      dependencyState: "stale",
      staleReasons: ["brief-changed", "brief-changed"],
    },
    { ...view, artifact: { ...view.artifact, ownerPrincipalId: "owner" } },
  ])
    assert.throws(() => parsePublicProjectTextArtifactView(value), invalid);
});
test("mutation replies bind exact candidate, CAS, selection and script provenance", () => {
  const response = {
    kind: "save-outline",
    disposition: "committed",
    artifact,
    contentRevision: revision,
  };
  const expected = {
    kind: "save-outline",
    projectId,
    request: candidate,
  } as const;
  assert.deepEqual(
    parseProjectTextMutationResponse(response, expected),
    response,
  );
  for (const value of [
    { ...response, artifact: { ...artifact, revision: 2 } },
    {
      ...response,
      contentRevision: {
        ...revision,
        content: { ...outline, logline: "different" },
      },
    },
    { ...response, kind: "save-script" },
  ])
    assert.throws(
      () => parseProjectTextMutationResponse(value, expected),
      invalid,
    );
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
  assert.equal(
    parseProjectTextMutationResponse(
      {
        ...response,
        kind: "save-script",
        artifact: scriptArtifact,
        contentRevision: scriptRevision,
      },
      {
        kind: "save-script",
        projectId,
        episodeId,
        request: { ...candidate, outline: null, content: script },
      },
    ).artifact.artifactId,
    "scripts",
  );
  assert.throws(
    () =>
      parseProjectTextMutationResponse(
        {
          kind: "select-revision",
          disposition: "committed",
          artifact: { ...artifact, revision: 2, selectedContentRevision: 1 },
          contentRevision: { ...revision, artifactId: "other" },
        },
        {
          kind: "select-revision",
          projectId,
          artifactId: artifact.artifactId,
          request: { expectedArtifactRevision: 1, contentRevision: 1 },
        },
      ),
    invalid,
  );
});
test("history cursors are exact last returned records and cannot cross project identity", () => {
  assert.deepEqual(
    parseProjectTextRevisionListResponse(
      { revisions: [revision], nextContentRevision: 1 },
      {
        projectId,
        artifactId: artifact.artifactId,
        afterContentRevision: 0,
        limit: 16,
      },
    ),
    { revisions: [revision], nextContentRevision: 1 },
  );
  for (const value of [
    { revisions: [revision], nextContentRevision: 2 },
    { revisions: [revision, revision], nextContentRevision: null },
    {
      revisions: [{ ...revision, projectId: "other" }],
      nextContentRevision: null,
    },
  ])
    assert.throws(
      () =>
        parseProjectTextRevisionListResponse(value, {
          projectId,
          artifactId: artifact.artifactId,
          afterContentRevision: 0,
          limit: 16,
        }),
      invalid,
    );
  assert.throws(
    () =>
      parseProjectTextArtifactListResponse(
        { artifacts: [artifact], nextArtifactId: "different" },
        { projectId, afterArtifactId: null, limit: 16 },
      ),
    invalid,
  );
});
test("OpenAPI includes independent text opt-in paths without reserving artifact IDs", () => {
  const api = JSON.parse(
    readFileSync(
      new URL("../openapi/control-api.v1.json", import.meta.url),
      "utf8",
    ),
  );
  const paths = Object.keys(api.paths).filter((path) =>
    path.includes("/text-artifacts"),
  );
  assert.equal(paths.length, 10);
  assert.ok(
    paths.includes(
      "/api/v1/creative-projects/{projectId}/text-artifacts/items/{artifactId}",
    ),
  );
  assert.ok(
    paths.includes(
      "/api/v1/creative-projects/{projectId}/text-artifacts/outline",
    ),
  );
  assert.equal(
    api.components.schemas.SaveProjectScriptCandidateRequest.properties.outline
      .oneOf[1].type,
    "null",
  );
});
