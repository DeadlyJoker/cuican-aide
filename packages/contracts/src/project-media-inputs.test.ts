import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSaveMediaInputRequest,
  parseSaveMediaInputResponse,
  parseLoadMediaInputHttpRequest,
  parseLoadMediaInputResponse,
  parseSaveMediaInputHttpRequest,
} from "./project-media-inputs.ts";

const reference = {
  projectId: "project",
  assetId: "character",
  kind: "character",
  expectedAssetRevision: 4,
  contentRevision: 1,
  referenceRevision: 1,
};
const command = {
  projectId: "project",
  mediaInputId: null,
  expectedInputRevision: 0,
  item: { kind: "character-reference", assetId: "character" },
  briefRevision: 1,
  script: null,
  workflowId: "krea2-reference-four-view",
  configurationRevision: 1,
  prompt: "保持人物特征，四视图。",
  references: { character: reference },
  idempotencyKey: "same-input",
};
const {
  mediaInputId: _,
  expectedInputRevision: __,
  idempotencyKey: ___,
  ...content
} = command;
const result = {
  ...content,
  mediaInputId: "input-1",
  inputRevision: 1,
  contentDigest: "sha256:" + "a".repeat(64),
  createdAt: "2026-10-06T00:00:00.000Z",
};

test("portable media-input metadata freezes exact role selectors without execution fields", () => {
  const parsed = parseSaveMediaInputRequest(command);
  assert.deepEqual(parsed, command);
  assert.ok(Object.isFrozen(parsed.references.character));
  const saved = parseSaveMediaInputResponse(parsed, {
    disposition: "committed",
    input: result,
  });
  assert.deepEqual(saved.input, result);
  assert.deepEqual(
    parseLoadMediaInputResponse(
      { projectId: "project", mediaInputId: "input-1", inputRevision: 1 },
      { state: { input: result, latestInputRevision: 2 } },
    ).state?.input,
    result,
  );
});
test("role contract rejects missing D18 participants, same asset in two roles and cross-project references", () => {
  const d18 = {
    ...command,
    item: { kind: "storyboard-frame-exploration", episodeId: "episode-1" },
    script: { artifactId: "script", contentRevision: 1 },
    workflowId: "flux2-three-reference-storyboard",
    references: {
      scene: { ...reference, kind: "scene", assetId: "scene" },
      characterOne: reference,
      characterTwo: { ...reference, assetId: "second-character" },
    },
  };
  assert.equal(
    parseSaveMediaInputRequest(d18).workflowId,
    "flux2-three-reference-storyboard",
  );
  for (const bad of [
    { ...d18, script: null },
    { ...d18, references: { ...d18.references, characterTwo: reference } },
    {
      ...command,
      references: { character: { ...reference, projectId: "other" } },
    },
    { ...command, references: { character: reference, scene: reference } },
  ])
    assert.throws(() => parseSaveMediaInputRequest(bad));
});
test("metadata parsers reject hidden authority, accessors, oversized input and mismatched response", () => {
  let getters = 0;
  for (const bad of [
    { ...command, target: { profileId: "invented" } },
    { ...command, url: "https://example.test/view" },
    { ...command, prompt: "x".repeat(8193) },
    { ...command, mediaInputId: "existing" },
    { ...command, expectedInputRevision: 1 },
  ])
    assert.throws(() => parseSaveMediaInputRequest(bad));
  const accessor = { ...command };
  Object.defineProperty(accessor, "prompt", {
    enumerable: true,
    get() {
      getters++;
      return "x";
    },
  });
  assert.throws(() => parseSaveMediaInputRequest(accessor));
  assert.equal(getters, 0);
  for (const input of [
    { ...result, projectId: "wrong" },
    { ...result, prompt: "silently rewritten" },
    { ...result, inputRevision: 2 },
    { ...result, actor: {} },
  ])
    assert.throws(() =>
      parseSaveMediaInputResponse(parseSaveMediaInputRequest(command), {
        disposition: "replayed",
        input,
      }),
    );
  assert.throws(() =>
    parseLoadMediaInputResponse(
      { projectId: "project", mediaInputId: "input-1", inputRevision: null },
      { state: { input: result, latestInputRevision: 2 } },
    ),
  );
});
test("HTTP parser binds path ownership and header idempotency; revision queries are canonical", () => {
  const { projectId, idempotencyKey, ...body } = command;
  assert.deepEqual(
    parseSaveMediaInputHttpRequest({ projectId, idempotencyKey, body }),
    command,
  );
  for (const extra of [
    { projectId: "other" },
    { idempotencyKey: "body-key" },
    { profileId: "other" },
  ])
    assert.throws(() =>
      parseSaveMediaInputHttpRequest({
        projectId,
        idempotencyKey,
        body: { ...body, ...extra },
      }),
    );
  assert.equal(
    parseLoadMediaInputHttpRequest({
      projectId,
      mediaInputId: "input-1",
      query: {},
    }).inputRevision,
    null,
  );
  assert.equal(
    parseLoadMediaInputHttpRequest({
      projectId,
      mediaInputId: "input-1",
      query: { inputRevision: "12" },
    }).inputRevision,
    12,
  );
  for (const inputRevision of [
    "0",
    "01",
    "1.0",
    "1e2",
    "9007199254740992",
    ["1", "2"],
  ])
    assert.throws(() =>
      parseLoadMediaInputHttpRequest({
        projectId,
        mediaInputId: "input-1",
        query: { inputRevision },
      }),
    );
});
