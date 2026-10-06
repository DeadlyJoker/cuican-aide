import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectMediaInputStageRequest,
  parseProjectMediaInputStageResponse,
  parseProjectMediaInputStagesActionRequest,
  projectMediaInputStagesCodec,
  projectMediaInputStagePath,
} from "./project-media-input-stages-contract.ts";
import {
  createPluginProjectMediaInputStagesClient,
  PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS,
  type ProjectMediaInputStageRequest,
} from "./project-media-input-stages-service.ts";
import { parseProjectConversationStage } from "./plugin-project-conversations-contract.ts";
const input: ProjectMediaInputStageRequest = {
  projectId: "project",
  threadId: "thread/中文 %",
  expectedThreadRevision: 4,
  expectedBindingRevision: 2,
  stage: {
    kind: "media-input",
    workflowId: "krea2-reference-four-view",
    configurationRevision: 2,
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
test("independent media input stage supports two workflows and freezes optional actual script source", () => {
  for (const workflowId of [
    "krea2-reference-four-view",
    "flux2-three-reference-storyboard",
  ] as const) {
    const scripted = {
      ...input,
      stage: {
        ...input.stage,
        workflowId,
        script: {
          artifactId: "script",
          episodeId: "episode",
          contentRevision: 1,
        },
      },
    };
    assert.deepEqual(parseProjectMediaInputStageRequest(scripted), scripted);
  }
  assert.deepEqual(
    parseProjectMediaInputStagesActionRequest({
      action: PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS.startStage,
      input,
    }),
    { action: PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS.startStage, input },
  );
  assert.equal(
    parseProjectMediaInputStageRequest(input).content,
    input.content,
  );
  assert.equal(
    projectMediaInputStagePath(input.threadId),
    `/api/v1/threads/${encodeURIComponent(input.threadId)}/project-media-input-stage`,
  );
  assert.throws(() => parseProjectConversationStage(input.stage));
  assert.throws(() =>
    parseProjectMediaInputStagesActionRequest({
      action: "crewon.project-conversations.v1.startStage",
      input,
    }),
  );
});
test("media input stage cannot accept caller authority, other stages, malformed sources, key aliases or unbounded content", () => {
  for (const value of [
    { ...input, actor: {} },
    { ...input, packageDigest: "proof" },
    { ...input, stage: { kind: "script" } },
    { ...input, stage: { ...input.stage, workflowId: "video" } },
    {
      ...input,
      stage: {
        ...input.stage,
        script: { artifactId: "script", contentRevision: 1 },
      },
    },
    { ...input, stage: { ...input.stage, briefRevision: 0 } },
    { ...input, expectedBindingRevision: 0 },
    { ...input, stage: { ...input.stage, configurationRevision: 0 } },
    {
      ...input,
      stage: {
        ...input.stage,
        workflowId: "flux2-three-reference-storyboard",
        script: null,
      },
    },
    { ...input, threadId: ".." },
    { ...input, idempotencyKey: "." },
    { ...input, idempotencyKey: "key,key" },
    { ...input, content: "a".repeat(16 * 1024 + 1) },
    { ...input, content: "\ud800" },
  ])
    assert.throws(() => parseProjectMediaInputStageRequest(value));
});
test("original stage response pins Thread CAS and binding, preserving replay metadata without new grants", () => {
  assert.deepEqual(parseProjectMediaInputStageResponse(input, output), output);
  assert.deepEqual(
    parseProjectMediaInputStageResponse(input, {
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
    assert.throws(() => parseProjectMediaInputStageResponse(input, value));
});
test("stage protocol rejects accessors before copying or reading, and detaches immutable input", () => {
  let reads = 0;
  const raw = { ...input, stage: { ...input.stage } },
    parsed = parseProjectMediaInputStageRequest(raw);
  raw.stage.workflowId = "flux2-three-reference-storyboard";
  assert.equal(parsed.stage.workflowId, "krea2-reference-four-view");
  assert.ok(Object.isFrozen(parsed.stage));
  const getter = Object.defineProperty({ ...input }, "content", {
    enumerable: true,
    get() {
      reads++;
      return input.content;
    },
  });
  assert.throws(() => parseProjectMediaInputStageRequest(getter));
  const bad = Object.defineProperty({ ...output }, "runId", {
    enumerable: true,
    get() {
      reads++;
      return output.runId;
    },
  });
  assert.throws(() => parseProjectMediaInputStageResponse(input, bad));
  assert.equal(reads, 0);
});
test("portable explicit stage client uses only the new action and preserves cancellation and unknown outcomes", async () => {
  const calls: unknown[] = [],
    original = new Error("unknown");
  const client = createPluginProjectMediaInputStagesClient(
    {
      async invoke(...args: unknown[]) {
        calls.push(args);
        return output;
      },
    },
    projectMediaInputStagesCodec,
  );
  assert.deepEqual(await client.startStage(input), output);
  assert.deepEqual(calls, [
    [PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS.startStage, input, {}],
  ]);
  const failed = createPluginProjectMediaInputStagesClient(
    {
      async invoke() {
        throw original;
      },
    },
    projectMediaInputStagesCodec,
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
  const { parseProjectMediaInputStageAvailabilityResponse: parse } =
    await import("./project-media-input-stages-contract.ts");
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
