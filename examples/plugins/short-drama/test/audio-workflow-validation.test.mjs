import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  validateComfyApiGraph,
  validateComfyApiVideoGraph,
  validateComfyApiAudioGraph,
  renderComfyApiAudioGraph,
} from "../build-support/comfyui-api-workflow-validation.mjs";

// Captured saved-service SaveAudio declaration, 2026-10-16. Producer is a named fixture.
// This is lossless FLAC authoring, not WAV, TTS execution or a saved project result.
const saveAudio = JSON.parse(
  readFileSync(
    new URL("./fixtures/save-audio-object-info.json", import.meta.url),
  ),
);
const options = {
  outputNodeId: "2",
  prompt: { nodeId: "1", input: "text" },
  outputPrefix: { nodeId: "2", input: "filename_prefix" },
  objectInfo: {
    NamedAudioProducer: { output: ["AUDIO"] },
    SaveAudio: saveAudio,
  },
};
const fixture = () => ({
  1: {
    class_type: "NamedAudioProducer",
    inputs: { text: "具名测试，不是实际配音。" },
  },
  2: {
    class_type: "SaveAudio",
    inputs: { audio: ["1", 0], filename_prefix: "crewon-named-audio-fixture" },
  },
});

test("lossless audio validates declared AUDIO and renders only reviewed text and prefix", () => {
  const graph = fixture();
  assert.deepEqual(validateComfyApiAudioGraph(graph, options), graph);
  const rendered = renderComfyApiAudioGraph(graph, options, {
    prompt: "欠你的三千二，念完给。",
    outputPrefix: "crewon-reviewed-audio-operation",
  });
  const expected = fixture();
  expected[1].inputs.text = "欠你的三千二，念完给。";
  expected[2].inputs.filename_prefix = "crewon-reviewed-audio-operation";
  assert.deepEqual(rendered, expected);
  assert.deepEqual(graph, fixture());
  assert(Object.isFrozen(rendered[2].inputs.audio));
});

test("audio cannot enter image/video validation or accept a mislabeled port", () => {
  assert.throws(() => validateComfyApiGraph(fixture(), options));
  assert.throws(() => validateComfyApiVideoGraph(fixture(), options));
  for (const port of ["IMAGE", "VIDEO", "STRING"]) {
    assert.throws(
      () =>
        validateComfyApiAudioGraph(fixture(), {
          ...options,
          objectInfo: {
            ...options.objectInfo,
            NamedAudioProducer: { output: [port] },
          },
        }),
      /audio_link_type_invalid/u,
    );
  }
  const { objectInfo, ...missing } = options;
  assert.throws(
    () => validateComfyApiAudioGraph(fixture(), missing),
    /audio_object_info_required/u,
  );
});

test("actual SaveAudio sink needs exactly audio wire and filename prefix, without invented WAV format", () => {
  for (const [key, value] of [
    ["format", "wav"],
    ["codec", "pcm_s16le"],
    ["audio", "provider-file-path"],
    ["filename_prefix", 9],
  ]) {
    const graph = fixture();
    graph[2].inputs[key] = value;
    assert.throws(() => validateComfyApiAudioGraph(graph, options));
  }
  const graph = fixture();
  delete graph[2].inputs.filename_prefix;
  assert.throws(() => validateComfyApiAudioGraph(graph, options));
});

test("audio authoring preserves graph, source and metadata boundaries", () => {
  const graph = fixture();
  graph[1].inputs.text = ["2", 0];
  assert.throws(
    () => validateComfyApiAudioGraph(graph, options),
    /dependency_cycle/u,
  );
  assert.throws(() =>
    validateComfyApiAudioGraph(fixture(), { ...options, prompt: null }),
  );
  assert.throws(() =>
    validateComfyApiAudioGraph(fixture(), {
      ...options,
      objectInfo: new Proxy(options.objectInfo, {}),
    }),
  );
  let observed = false;
  const metadata = { ...options.objectInfo };
  Object.defineProperty(metadata, "SaveAudio", {
    enumerable: true,
    get() {
      observed = true;
      throw Error("must not execute");
    },
  });
  assert.throws(() =>
    validateComfyApiAudioGraph(fixture(), { ...options, objectInfo: metadata }),
  );
  assert.equal(observed, false);
  assert.throws(() =>
    renderComfyApiAudioGraph(fixture(), options, {
      prompt: "声音".repeat(2001),
      outputPrefix: "crewon-bounded",
    }),
  );
});
