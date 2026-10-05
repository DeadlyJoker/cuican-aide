import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectAssetStageRequest,
  parseProjectAssetStageResponse,
  parseProjectAssetStagesActionRequest,
  projectAssetStagesCodec,
  projectAssetStagePath,
} from "./project-asset-stages-contract.ts";
import {
  createPluginProjectAssetStagesClient,
  PROJECT_ASSET_STAGES_METHOD_ACTIONS,
  type ProjectAssetStageRequest,
} from "./project-asset-stages-service.ts";
import { parseProjectConversationStage } from "./plugin-project-conversations-contract.ts";
const input: ProjectAssetStageRequest = {
  projectId: "project",
  threadId: "thread/中文 %",
  expectedThreadRevision: 4,
  expectedBindingRevision: 2,
  stage: {
    kind: "assets",
    assetKind: "character",
    briefRevision: 3,
    script: null,
  },
  content: " 用户原想法\n角色设定 ",
  idempotencyKey: "original-key",
};
const output = {
  disposition: "committed",
  threadId: input.threadId,
  threadRevision: 5,
  runId: "-original-run",
  runRevision: 1,
  bindingRevision: 2,
  stageAdmissionDigest: `sha256:${"a".repeat(64)}`,
};
test("independent asset stage supports three asset kinds and freezes optional actual script source", () => {
  for (const assetKind of ["character", "scene", "prop"] as const) {
    const scripted = {
      ...input,
      stage: {
        ...input.stage,
        assetKind,
        script: {
          artifactId: "script",
          episodeId: "episode",
          contentRevision: 1,
        },
      },
    };
    assert.deepEqual(parseProjectAssetStageRequest(scripted), scripted);
  }
  assert.deepEqual(
    parseProjectAssetStagesActionRequest({
      action: PROJECT_ASSET_STAGES_METHOD_ACTIONS.startStage,
      input,
    }),
    { action: PROJECT_ASSET_STAGES_METHOD_ACTIONS.startStage, input },
  );
  assert.equal(parseProjectAssetStageRequest(input).content, input.content);
  assert.equal(
    projectAssetStagePath(input.threadId),
    `/api/v1/threads/${encodeURIComponent(input.threadId)}/project-asset-stage`,
  );
  assert.throws(() => parseProjectConversationStage(input.stage));
  assert.throws(() =>
    parseProjectAssetStagesActionRequest({
      action: "crewon.project-conversations.v1.startStage",
      input,
    }),
  );
});
test("asset stage cannot accept caller authority, other stages, malformed sources, key aliases or unbounded content", () => {
  for (const value of [
    { ...input, actor: {} },
    { ...input, packageDigest: "proof" },
    { ...input, stage: { kind: "script" } },
    { ...input, stage: { ...input.stage, assetKind: "camera" } },
    {
      ...input,
      stage: {
        ...input.stage,
        script: { artifactId: "script", contentRevision: 1 },
      },
    },
    { ...input, stage: { ...input.stage, briefRevision: 0 } },
    { ...input, expectedBindingRevision: 0 },
    { ...input, threadId: ".." },
    { ...input, idempotencyKey: "." },
    { ...input, idempotencyKey: "key,key" },
    { ...input, content: "a".repeat(16 * 1024 + 1) },
    { ...input, content: "\ud800" },
  ])
    assert.throws(() => parseProjectAssetStageRequest(value));
});
test("original stage response pins Thread CAS and binding, preserving replay metadata without new grants", () => {
  assert.deepEqual(parseProjectAssetStageResponse(input, output), output);
  assert.deepEqual(
    parseProjectAssetStageResponse(input, {
      ...output,
      disposition: "replayed",
    }),
    { ...output, disposition: "replayed" },
  );
  for (const value of [
    { ...output, threadId: "other" },
    { ...output, threadRevision: 6 },
    { ...output, bindingRevision: 3 },
    { ...output, runRevision: 0 },
    { ...output, stageAdmissionDigest: "bad" },
    { ...output, authority: true },
  ])
    assert.throws(() => parseProjectAssetStageResponse(input, value));
});
test("stage protocol rejects accessors before copying or reading, and detaches immutable input", () => {
  let reads = 0;
  const raw = { ...input, stage: { ...input.stage } },
    parsed = parseProjectAssetStageRequest(raw);
  raw.stage.assetKind = "scene";
  assert.equal(parsed.stage.assetKind, "character");
  assert.ok(Object.isFrozen(parsed.stage));
  const getter = Object.defineProperty({ ...input }, "content", {
    enumerable: true,
    get() {
      reads++;
      return input.content;
    },
  });
  assert.throws(() => parseProjectAssetStageRequest(getter));
  const bad = Object.defineProperty({ ...output }, "runId", {
    enumerable: true,
    get() {
      reads++;
      return output.runId;
    },
  });
  assert.throws(() => parseProjectAssetStageResponse(input, bad));
  assert.equal(reads, 0);
});
test("portable explicit stage client uses only the new action and preserves cancellation and unknown outcomes", async () => {
  const calls: unknown[] = [],
    original = new Error("unknown");
  const client = createPluginProjectAssetStagesClient(
    {
      async invoke(...args: unknown[]) {
        calls.push(args);
        return output;
      },
    },
    projectAssetStagesCodec,
  );
  assert.deepEqual(await client.startStage(input), output);
  assert.deepEqual(calls, [
    [PROJECT_ASSET_STAGES_METHOD_ACTIONS.startStage, input, {}],
  ]);
  const failed = createPluginProjectAssetStagesClient(
    {
      async invoke() {
        throw original;
      },
    },
    projectAssetStagesCodec,
  );
  await assert.rejects(failed.startStage(input), (error) => error === original);
  const cancellation = new AbortController();
  cancellation.abort(original);
  await assert.rejects(
    client.startStage(input, { signal: cancellation.signal }),
    (error) => error === original,
  );
  assert.equal(calls.length, 1);
});

test("HTTP availability is only an exact bounded boolean and never imports authority or stage metadata", async () => {
  const { parseProjectAssetStageAvailabilityResponse: parse } = await import(
    "./project-asset-stages-contract.ts"
  );
  assert.deepEqual(parse({ available: true }), { available: true });
  assert.deepEqual(parse({ available: false }), { available: false });
  for (const input of [
    null,
    { available: 1 },
    { available: true, owner: {} },
    { available: false, stage: { kind: "assets" } },
  ])
    assert.throws(() => parse(input));
  let calls = 0;
  const getter = Object.defineProperty({}, "available", {
    enumerable: true,
    get() {
      calls++;
      return true;
    },
  });
  assert.throws(() => parse(getter));
  assert.equal(calls, 0);
});
