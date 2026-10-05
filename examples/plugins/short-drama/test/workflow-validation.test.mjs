import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  renderComfyApiGraph,
  validateComfyApiGraph,
} from "../build-support/comfyui-api-workflow-validation.mjs";

const slots = {
  outputNodeId: "29",
  prompt: { nodeId: "1", input: "text" },
  outputPrefix: { nodeId: "29", input: "filename_prefix" },
};
const objectInfo = {
  Encode: { output: ["CONDITIONING"] },
  Decode: { output: ["IMAGE"] },
  SaveImage: { output: [] },
  UnusedModel: { output: ["MODEL"] },
};
function fixture() {
  return {
    1: {
      class_type: "Encode",
      inputs: { text: "original", system: "Retained system instruction." },
    },
    2: { class_type: "Decode", inputs: { conditioning: ["1", 0], seed: -1 } },
    29: {
      class_type: "SaveImage",
      inputs: { images: ["2", 0], filename_prefix: "original-prefix" },
      _meta: { title: "Output" },
    },
    88: { class_type: "UnusedModel", inputs: { strength: 0.5 }, _meta: {} },
  };
}
function rejects(graph, code, config = slots) {
  assert.throws(() => validateComfyApiGraph(graph, config), {
    message: new RegExp(`^comfy_api_graph_(?:${code})$`),
  });
}
function nested(count) {
  let value = null;
  for (let index = 0; index < count; index++) value = { next: value };
  return value;
}
function graphAtByteLimit() {
  const graph = fixture();
  graph["1"].inputs.bulk = Array(8).fill("");
  let remaining = 512 * 1024 - Buffer.byteLength(JSON.stringify(graph));
  for (let index = 0; index < 8; index++) {
    const size = Math.min(64 * 1024, remaining);
    graph["1"].inputs.bulk[index] = "x".repeat(size);
    remaining -= size;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(graph)), 512 * 1024);
  return graph;
}

test("validation preserves all nodes and JSON fields in an independent deeply frozen clone", () => {
  const input = fixture();
  input["88"].inputs.literal = {
    flags: [true, false, null],
    nested: { scale: 1.5 },
  };
  const reviewed = validateComfyApiGraph(input, { ...slots, objectInfo });
  assert.deepEqual(reviewed, input);
  assert.deepEqual(Object.keys(reviewed), ["1", "2", "29", "88"]);
  assert.notEqual(reviewed, input);
  assert.notEqual(
    reviewed["2"].inputs.conditioning,
    input["2"].inputs.conditioning,
  );
  assert(Object.isFrozen(reviewed));
  assert(Object.isFrozen(reviewed["88"].inputs.literal.nested));
  assert(Object.isFrozen(reviewed["2"].inputs.conditioning));
  assert.throws(() => (reviewed["2"].inputs.seed = 4), TypeError);
  input["1"].inputs.text = "changed later";
  assert.equal(reviewed["1"].inputs.text, "original");
  assert.equal(reviewed["2"].inputs.seed, -1);
});

test("render updates only two declared slots and preserves multiline Unicode plus random seed -1", () => {
  const input = fixture();
  const prompt = "角色 😀\n第二行\t光线\r镜头";
  const result = renderComfyApiGraph(input, slots, {
    prompt,
    outputPrefix: "crewon-owned-operation",
  });
  const expected = fixture();
  expected["1"].inputs.text = prompt;
  expected["29"].inputs.filename_prefix = "crewon-owned-operation";
  assert.deepEqual(result, expected);
  assert.deepEqual(input, fixture());
  assert.equal(result["2"].inputs.seed, -1);
  assert(Object.isFrozen(result["1"].inputs));
  assert(Object.isFrozen(result["29"]._meta));
});

test("API root and every node must be nonempty plain JSON records with normalized bounded IDs", () => {
  for (const input of [null, [], new Date(), {}, "graph"])
    assert.throws(
      () => validateComfyApiGraph(input, slots),
      /^Error: comfy_api_graph_/,
    );
  for (const id of [
    "01",
    "1:02",
    "1::2",
    "-1",
    "1.0",
    "1e2",
    " 1",
    "１",
    "",
    "1".repeat(129),
  ]) {
    const graph = fixture();
    graph[id] = { class_type: "UnusedModel", inputs: {} };
    rejects(graph, "node_id_invalid");
  }
  const nullPrototype = Object.assign(Object.create(null), fixture());
  assert.equal(
    Object.keys(validateComfyApiGraph(nullPrototype, slots)).length,
    4,
  );
  const graph = fixture();
  graph["1".repeat(128)] = { class_type: "UnusedModel", inputs: {} };
  assert.equal(Object.keys(validateComfyApiGraph(graph, slots)).length, 5);
  for (const invalid of [
    null,
    [],
    "node",
    Object.create({ inherited: true }),
  ]) {
    const other = fixture();
    other["88"] = invalid;
    rejects(other, "record_invalid");
  }
});

test("missing class and UNKNOWN placeholder entries are rejected even outside the output dependency tree", () => {
  for (const malformed of [
    { inputs: { UNKNOWN: 4 }, _meta: { title: "Missing node" } },
    { class_type: "UNKNOWN", inputs: {} },
    { class_type: "UnusedModel", inputs: { UNKNOWN_12: "placeholder" } },
    { class_type: "UnusedModel" },
    { class_type: "UnusedModel", inputs: [], _meta: {} },
    { class_type: "UnusedModel", inputs: {}, unexpected: true },
    { class_type: "UnusedModel", inputs: {}, _meta: [] },
    { class_type: "", inputs: {} },
    { class_type: "   ", inputs: {} },
    { class_type: "x".repeat(257), inputs: {} },
  ]) {
    const graph = fixture();
    graph["90"] = malformed;
    assert.throws(
      () => validateComfyApiGraph(graph, slots),
      /^Error: comfy_api_graph_/,
    );
  }
});

test("subgraph colon IDs resolve without normalization and live metadata bounds output indexes", () => {
  const graph = fixture();
  graph["235:231"] = graph["1"];
  delete graph["1"];
  graph["2"].inputs.conditioning = ["235:231", 0];
  const config = {
    ...slots,
    prompt: { nodeId: "235:231", input: "text" },
    objectInfo,
  };
  const checked = validateComfyApiGraph(graph, config);
  assert.deepEqual(checked["2"].inputs.conditioning, ["235:231", 0]);
  assert.equal(checked["235:231"].inputs.text, "original");
  graph["2"].inputs.conditioning[1] = 1;
  rejects(graph, "link_output_missing", config);
  assert.equal(
    validateComfyApiGraph(graph, { ...config, objectInfo: undefined })["2"]
      .inputs.conditioning[1],
    1,
  );
});

test("dangling wires and invalid wire IDs or output indexes are rejected", () => {
  for (const [wire, error] of [
    [["999", 0], "link_missing"],
    [["01", 0], "node_id_invalid"],
    [[1, 0], "node_id_invalid"],
    [["1", -1], "link_index_invalid"],
    [["1", 0.5], "link_index_invalid"],
    [["1", "0"], "link_index_invalid"],
    [["1", Number.MAX_SAFE_INTEGER + 1], "json_invalid"],
  ]) {
    const graph = fixture();
    graph["2"].inputs.conditioning = wire;
    rejects(graph, error);
  }
});

test("cycles are rejected including a cycle disconnected from the chosen output", () => {
  const self = fixture();
  self["2"].inputs.conditioning = ["2", 0];
  rejects(self, "dependency_cycle");
  const backEdge = fixture();
  backEdge["1"].inputs.other = ["2", 0];
  rejects(backEdge, "dependency_cycle");
  const unused = fixture();
  unused["88"].inputs.other = ["89", 0];
  unused["89"] = { class_type: "UnusedModel", inputs: { other: ["88", 0] } };
  rejects(unused, "dependency_cycle");
});

test("output and prompt roles must exist, be literal strings, and affect the specified SaveImage", () => {
  const missingOutput = fixture();
  rejects(missingOutput, "output_role_invalid", {
    ...slots,
    outputNodeId: "100",
    outputPrefix: { nodeId: "100", input: "filename_prefix" },
  });
  const wrongClass = fixture();
  wrongClass["29"].class_type = "PreviewImage";
  rejects(wrongClass, "output_role_invalid");
  const noImageWire = fixture();
  noImageWire["29"].inputs.images = "not a wire";
  rejects(noImageWire, "output_role_invalid");
  const absentPrompt = fixture();
  delete absentPrompt["1"].inputs.text;
  rejects(absentPrompt, "slot_missing");
  const absentPrefix = fixture();
  delete absentPrefix["29"].inputs.filename_prefix;
  rejects(absentPrefix, "slot_missing");
  const numericPrompt = fixture();
  numericPrompt["1"].inputs.text = 42;
  rejects(numericPrompt, "text_invalid");
  const wiredPrefix = fixture();
  wiredPrefix["29"].inputs.filename_prefix = ["1", 0];
  rejects(wiredPrefix, "text_invalid");
  const disconnected = fixture();
  disconnected["99"] = {
    class_type: "Encode",
    inputs: { text: "unused prompt" },
  };
  rejects(disconnected, "prompt_disconnected", {
    ...slots,
    prompt: { nodeId: "99", input: "text" },
  });
});

test("slot labels and render value records cannot substitute a different role or add fields", () => {
  for (const config of [
    {},
    { ...slots, unexpected: true },
    { ...slots, prompt: { nodeId: "1", input: "text", path: "other" } },
    { ...slots, outputPrefix: { nodeId: "2", input: "filename_prefix" } },
    { ...slots, outputPrefix: { nodeId: "29", input: "images" } },
    { ...slots, prompt: { nodeId: "29", input: "filename_prefix" } },
  ])
    assert.throws(
      () => validateComfyApiGraph(fixture(), config),
      /^Error: comfy_api_graph_/,
    );
  for (const values of [
    {},
    { prompt: "okay" },
    { prompt: "okay", outputPrefix: "prefix", seed: -1 },
    null,
    [],
  ]) {
    assert.throws(
      () => renderComfyApiGraph(fixture(), slots, values),
      /^Error: comfy_api_graph_/,
    );
  }
});

test("mapped prompts retain the original 2000 UTF-16-unit ABI and reject forbidden controls or lone surrogates", () => {
  for (const prompt of [
    "角".repeat(2000),
    "😀".repeat(1000),
    "\t第一行\n第二行\r末行",
  ]) {
    assert.equal(
      renderComfyApiGraph(fixture(), slots, { prompt, outputPrefix: "prefix" })[
        "1"
      ].inputs.text,
      prompt,
    );
  }
  for (const prompt of [
    "x".repeat(2001),
    "😀".repeat(1001),
    "",
    "   ",
    "x\u0000",
    "x\u0008",
    "x\u000b",
    "x\u000c",
    "x\u001f",
    "x\u007f",
    "x\ud800",
    "x\udfff",
  ]) {
    assert.throws(
      () =>
        renderComfyApiGraph(fixture(), slots, {
          prompt,
          outputPrefix: "prefix",
        }),
      /^Error: comfy_api_graph_text_invalid$/,
    );
  }
  const tooLong = fixture();
  tooLong["1"].inputs.text = "角".repeat(2001);
  rejects(tooLong, "text_invalid");
});

test("prefixes are bounded literal strings and never accept control characters", () => {
  const prefix = "x".repeat(128);
  assert.equal(
    renderComfyApiGraph(fixture(), slots, {
      prompt: "okay",
      outputPrefix: prefix,
    })["29"].inputs.filename_prefix,
    prefix,
  );
  for (const outputPrefix of [
    "x".repeat(129),
    "",
    " ",
    "x\t",
    "x\n",
    "x\r",
    "x\u0000",
    "x\u007f",
    "x\ud800",
  ]) {
    assert.throws(
      () =>
        renderComfyApiGraph(fixture(), slots, { prompt: "okay", outputPrefix }),
      /^Error: comfy_api_graph_text_invalid$/,
    );
  }
});

test("non-JSON values, object cycles, array holes and custom serializers are rejected without executing them", () => {
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    -Number.MAX_SAFE_INTEGER - 1,
    1n,
    () => "code",
    new Date(),
    new Map(),
  ]) {
    const graph = fixture();
    graph["88"].inputs.value = value;
    rejects(graph, "json_invalid|record_invalid");
  }
  const cyclic = fixture();
  cyclic["88"].inputs.self = cyclic["88"].inputs;
  rejects(cyclic, "json_cycle");
  const holes = fixture();
  holes["88"].inputs.values = Array(3);
  rejects(holes, "array_invalid");
  const extraArrayProperty = fixture();
  const values = [1, 2, 3];
  values.hidden = true;
  extraArrayProperty["88"].inputs.values = values;
  rejects(extraArrayProperty, "array_invalid");
  let calls = 0;
  const serializer = fixture();
  serializer["88"].inputs.toJSON = () => {
    calls++;
    return "hidden";
  };
  rejects(serializer, "json_invalid");
  assert.equal(calls, 0);
});

test("safe integer seeds and finite fractional parameters retain their exact numeric values", () => {
  const graph = fixture();
  graph["88"].inputs.values = {
    positive: Number.MAX_SAFE_INTEGER,
    negative: -Number.MAX_SAFE_INTEGER,
    fractional: 0.375,
    randomSeed: -1,
  };
  assert.deepEqual(
    validateComfyApiGraph(graph, slots)["88"].inputs.values,
    graph["88"].inputs.values,
  );
});

test("prototype keys, accessors, symbol fields and proxy traps cannot execute or pollute the reviewed graph", () => {
  for (const key of ["__proto__", "prototype", "constructor"]) {
    const graph = fixture();
    graph["88"].inputs.extra = JSON.parse(`{"${key}":{"polluted":true}}`);
    rejects(graph, "key_invalid");
  }
  assert.equal(Object.prototype.polluted, undefined);
  let calls = 0;
  const accessor = fixture();
  Object.defineProperty(accessor["88"].inputs, "secret", {
    enumerable: true,
    get() {
      calls++;
      return "private";
    },
  });
  rejects(accessor, "property_invalid");
  const symbol = fixture();
  symbol["88"].inputs[Symbol("hidden")] = true;
  rejects(symbol, "key_invalid");
  const hidden = fixture();
  Object.defineProperty(hidden["88"].inputs, "hidden", {
    enumerable: false,
    value: true,
  });
  rejects(hidden, "property_invalid");
  const proxy = new Proxy(fixture(), {
    getPrototypeOf() {
      calls++;
      return Object.prototype;
    },
    ownKeys() {
      calls++;
      return [];
    },
  });
  rejects(proxy, "record_invalid");
  assert.equal(calls, 0);
});

test("live object-info must contain every class and actual output arrays without inherited class substitutions", () => {
  const missing = { ...objectInfo };
  delete missing.Encode;
  rejects(fixture(), "class_unregistered", { ...slots, objectInfo: missing });
  const invalid = { ...objectInfo, Encode: { output: "CONDITIONING" } };
  rejects(fixture(), "object_info_invalid", { ...slots, objectInfo: invalid });
  const inheritedName = fixture();
  inheritedName["88"].class_type = "toString";
  rejects(inheritedName, "class_unregistered", { ...slots, objectInfo });
  let calls = 0;
  const getter = { ...objectInfo };
  Object.defineProperty(getter, "Encode", {
    enumerable: true,
    get() {
      calls++;
      return objectInfo.Encode;
    },
  });
  rejects(fixture(), "property_invalid", { ...slots, objectInfo: getter });
  assert.equal(calls, 0);
});

test("512-node and 24-depth limits reject overflow while preserving legal boundary graphs", () => {
  const graph = fixture();
  for (let index = 0; index < 508; index++)
    graph[String(1000 + index)] = { class_type: "UnusedModel", inputs: {} };
  assert.equal(Object.keys(validateComfyApiGraph(graph, slots)).length, 512);
  graph["2000"] = { class_type: "UnusedModel", inputs: {} };
  rejects(graph, "node_limit");
  const depth = fixture();
  depth["88"].inputs.value = nested(21);
  assert.deepEqual(
    validateComfyApiGraph(depth, slots)["88"].inputs.value,
    nested(21),
  );
  depth["88"].inputs.value = nested(22);
  rejects(depth, "depth_limit");
});

test("single-string 64KiB and total 512KiB bounds use actual UTF-8 JSON bytes, including after rendering", () => {
  const graph = fixture();
  graph["1"].inputs.system = "x".repeat(64 * 1024);
  assert.equal(
    validateComfyApiGraph(graph, slots)["1"].inputs.system.length,
    64 * 1024,
  );
  graph["1"].inputs.system += "x";
  rejects(graph, "string_invalid");
  graph["1"].inputs.system = "角".repeat(22000);
  rejects(graph, "string_invalid");
  const atLimit = graphAtByteLimit();
  assert.equal(
    Buffer.byteLength(JSON.stringify(validateComfyApiGraph(atLimit, slots))),
    512 * 1024,
  );
  assert.throws(
    () =>
      renderComfyApiGraph(atLimit, slots, {
        prompt: "original plus more",
        outputPrefix: "original-prefix",
      }),
    /^Error: comfy_api_graph_byte_limit$/,
  );
  atLimit["1"].inputs.bulk[7] += "x";
  rejects(atLimit, "byte_limit");
});
