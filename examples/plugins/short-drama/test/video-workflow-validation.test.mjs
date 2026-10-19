import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  validateComfyApiGraph,
  validateComfyApiVideoGraph,
  renderComfyApiVideoGraph,
} from "../build-support/comfyui-api-workflow-validation.mjs";

// Actual read-only SaveVideo declaration captured on 2026-10-16. Producer is a named fixture;
// no model weight, executable plugin registration, generation or output acceptance is implied.
const saveVideo = JSON.parse(
  readFileSync(
    new URL("./fixtures/save-video-object-info.json", import.meta.url),
  ),
);
const options = {
  outputNodeId: "2",
  prompt: { nodeId: "1", input: "prompt" },
  outputPrefix: { nodeId: "2", input: "filename_prefix" },
  objectInfo: {
    NamedVideoProducer: { output: ["VIDEO"] },
    SaveVideo: saveVideo,
  },
};
const fixture = () => ({
  1: {
    class_type: "NamedVideoProducer",
    inputs: { prompt: "A named fixture only." },
  },
  2: {
    class_type: "SaveVideo",
    inputs: {
      "video": ["1", 0],
      "filename_prefix": "crewon-owned-fixture",
      "format": "mp4",
      "format.codec": "h264",
      "format.codec.encoding": "re-encode",
      "format.codec.encoding.crf": 18,
    },
  },
});
const rejects = (graph, code, config = options) =>
  assert.throws(() => validateComfyApiVideoGraph(graph, config), {
    message: new RegExp(`^comfy_api_graph_(?:${code})$`),
  });

test("actual V3 MP4/H264 branch validates and renders only reviewed slots in a frozen graph", () => {
  const input = fixture();
  const rendered = renderComfyApiVideoGraph(input, options, {
    prompt: "镜头与动作\n持续录像",
    outputPrefix: "crewon-reviewed-operation",
  });
  const expected = fixture();
  expected[1].inputs.prompt = "镜头与动作\n持续录像";
  expected[2].inputs.filename_prefix = "crewon-reviewed-operation";
  assert.deepEqual(rendered, expected);
  assert.deepEqual(input, fixture());
  assert(Object.isFrozen(rendered[2].inputs.video));
  assert(Object.isFrozen(rendered[2].inputs));
});

test("video output cannot enter the unchanged v1 SaveImage validation path", () => {
  assert.throws(() => validateComfyApiGraph(fixture(), options), {
    message: "comfy_api_graph_output_role_invalid",
  });
  const g = fixture();
  g[2].class_type = "SaveImage";
  rejects(g, "class_unregistered|output_role_invalid");
  const { objectInfo: _unused, ...missing } = options;
  rejects(fixture(), "video_object_info_required", missing);
});

test("video composition has an explicit absent prompt, without dummy nodes or ignored text", () => {
  const graph = fixture();
  graph[1].inputs = {};
  const immutable = { ...options, prompt: null };
  assert.deepEqual(validateComfyApiVideoGraph(graph, immutable), graph);
  const rendered = renderComfyApiVideoGraph(graph, immutable, {
    prompt: null,
    outputPrefix: "crewon-composition-operation",
  });
  assert.deepEqual(rendered[1], graph[1]);
  assert.equal(
    rendered[2].inputs.filename_prefix,
    "crewon-composition-operation",
  );
  assert.throws(
    () =>
      renderComfyApiVideoGraph(graph, immutable, {
        prompt: "Must not be silently ignored",
        outputPrefix: "crewon-composition-operation",
      }),
    { message: "comfy_api_graph_prompt_slot_absent" },
  );
  const { prompt: _absent, ...missing } = immutable;
  rejects(graph, "options_invalid", missing);
  assert.throws(() => validateComfyApiGraph(graph, immutable));
  assert.throws(() =>
    renderComfyApiVideoGraph(fixture(), options, {
      prompt: null,
      outputPrefix: "crewon-composition-operation",
    }),
  );
});

test("a VIDEO output port is mandatory; an IMAGE or missing port cannot masquerade as a video", () => {
  rejects(fixture(), "video_link_type_invalid", {
    ...options,
    objectInfo: {
      ...options.objectInfo,
      NamedVideoProducer: { output: ["IMAGE"] },
    },
  });
  const g = fixture();
  g[2].inputs.video = ["1", 1];
  rejects(g, "link_output_missing");
});

test("dynamic branches reject missing codecs, nested DTOs, unknown selections and inactive fields", () => {
  for (const mutate of [
    (i) => {
      delete i["format.codec"];
    },
    (i) => {
      i.format = { format: "mp4", codec: "h264" };
    },
    (i) => {
      i["format.codec"] = "unknown";
    },
    (i) => {
      i.format = "webm";
    },
    (i) => {
      i["format.codec.encoding"] = "auto";
    },
    (i) => {
      i["format.codec.encoding.extra"] = "unused";
    },
    (i) => {
      i.codec = "h264";
    },
  ]) {
    const g = fixture();
    mutate(g[2].inputs);
    rejects(
      g,
      "video_input_missing|video_input_choice_invalid|video_input_branch_invalid|video_legacy_codec_ambiguous",
    );
  }
  const g = fixture();
  g[2].inputs["format.codec.encoding"] = "auto";
  delete g[2].inputs["format.codec.encoding.crf"];
  assert.deepEqual(validateComfyApiVideoGraph(g, options), g);
});

test("actual encoding numeric bounds fail closed; optional encoding can be omitted without defaults", () => {
  for (const crf of [-1, 52, "18", true, null]) {
    const g = fixture();
    g[2].inputs["format.codec.encoding.crf"] = crf;
    rejects(g, "video_input_range_invalid|video_input_type_invalid");
  }
  const g = fixture();
  delete g[2].inputs["format.codec.encoding"];
  delete g[2].inputs["format.codec.encoding.crf"];
  assert.deepEqual(validateComfyApiVideoGraph(g, options), g);
});

test("metadata accessors and Proxy declarations cannot execute during video validation", () => {
  let calls = 0;
  const malicious = { ...options.objectInfo };
  Object.defineProperty(malicious, "SaveVideo", {
    enumerable: true,
    get() {
      calls++;
      return saveVideo;
    },
  });
  rejects(fixture(), "property_invalid", { ...options, objectInfo: malicious });
  assert.equal(calls, 0);
  rejects(fixture(), "record_invalid|json_invalid", {
    ...options,
    objectInfo: new Proxy(options.objectInfo, {}),
  });
  const outputs = [];
  Object.defineProperty(outputs, "0", {
    enumerable: true,
    get() {
      calls++;
      return "VIDEO";
    },
  });
  rejects(fixture(), "array_invalid", {
    ...options,
    objectInfo: {
      ...options.objectInfo,
      NamedVideoProducer: { output: outputs },
    },
  });
  assert.equal(calls, 0);
});
