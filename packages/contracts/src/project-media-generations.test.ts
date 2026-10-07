import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_MEDIA_GENERATE_UI_ACTION,
  parseProjectMediaGenerationUiRequest as ui,
  isProjectMediaGenerationUiNamespaceAction as namespace,
  parseGenerateProjectMediaHttpRequest as http,
  parseGenerateProjectMediaRequest as parse,
  parseGenerateProjectMediaResponse as response,
} from "./project-media-generations.ts";

const request = {
  projectId: "project-1",
  mediaInputId: "input-1",
  inputRevision: 2,
  expectedInputRevision: 2,
  executionId: "execution-1",
  threadId: "thread-1",
  expectedThreadRevision: 4,
  idempotencyKey: "key-1",
};
const { projectId, idempotencyKey, ...body } = request;
test("media generation contract preserves a bounded logical command and route/header ownership", () => {
  assert.deepEqual(http({ body, projectId, idempotencyKey }), request);
  for (const field of [
    "actor",
    "profileId",
    "pin",
    "authorization",
    "providerUrl",
    "workflow",
    "materials",
    "projectId",
    "idempotencyKey",
  ])
    assert.throws(() =>
      http({
        body: { ...body, [field]: "injected" },
        projectId,
        idempotencyKey,
      }),
    );
  for (const key of [undefined, ["first", "second"], "x".repeat(129), "\n"])
    assert.throws(() => http({ body, projectId, idempotencyKey: key }));
});
test("media generation contract rejects accessors and invalid revisions; copies data without invoking property getters", () => {
  for (const field of [
    "inputRevision",
    "expectedInputRevision",
    "expectedThreadRevision",
  ])
    for (const value of [0, -1, 1.2, "1", Number.MAX_SAFE_INTEGER + 1, null])
      assert.throws(() => parse({ ...request, [field]: value }));
  assert.throws(() => parse({ ...request, executionId: "x".repeat(4096) }));
  let invoked = 0;
  const accessor = { ...request };
  Object.defineProperty(accessor, "executionId", {
    get: () => {
      invoked++;
      return "x";
    },
    enumerable: true,
  });
  assert.throws(() => parse(accessor));
  assert.deepEqual(
    parse(
      new Proxy(request, {
        get: () => {
          invoked++;
          return "x";
        },
      }),
    ),
    request,
  );
  assert.equal(invoked, 0);
});
test("media generation response is tied to original intent and carries no provider or installation data", () => {
  const accepted = {
    disposition: "committed",
    projectId,
    mediaInputId: request.mediaInputId,
    inputRevision: 2,
    executionId: request.executionId,
    threadId: request.threadId,
    threadRevision: 5,
    runId: "run-1",
  };
  assert.deepEqual(response(request, accepted), accepted);
  assert.equal(
    response(request, { ...accepted, disposition: "replayed" }).runId,
    "run-1",
  );
  for (const field of ["projectId", "mediaInputId", "executionId", "threadId"])
    assert.throws(() =>
      response(request, { ...accepted, [field]: "different" }),
    );
  for (const change of [
    { inputRevision: 3 },
    { threadRevision: 4 },
    { disposition: "completed" },
    { binding: {} },
    { providerUrl: "https://example.test/" },
  ])
    assert.throws(() => response(request, { ...accepted, ...change }));
});

test("media UI action accepts only the exact logical command and reserves future namespace actions", () => {
  assert.deepEqual(
    ui({ action: PROJECT_MEDIA_GENERATE_UI_ACTION, input: request }),
    { action: PROJECT_MEDIA_GENERATE_UI_ACTION, input: request },
  );
  for (const action of [
    "crewon.project-media-generations",
    "crewon.project-media-generations.v2.generate",
    "crewon.project-media-generations.v1.other",
  ]) {
    assert.equal(namespace(action), true);
    assert.throws(() => ui({ action, input: request }));
  }
  assert.equal(namespace("crewon.project-media-generations-other"), false);
  assert.throws(() =>
    ui({
      action: PROJECT_MEDIA_GENERATE_UI_ACTION,
      input: { ...request, providerUrl: "https://supplier.test" },
    }),
  );
});
