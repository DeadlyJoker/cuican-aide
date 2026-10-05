import { Buffer } from "node:buffer";
import { types } from "node:util";

const MAX_BYTES = 512 * 1024;
const MAX_STRING_BYTES = 64 * 1024;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const NODE_ID = /^(?:0|[1-9][0-9]*)(?::(?:0|[1-9][0-9]*))*$/u;
const PLACEHOLDER = /^UNKNOWN(?:_[0-9]+)?$/u;
const PROMPT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ALL_CONTROLS = /[\u0000-\u001f\u007f]/u;
const UNPAIRED_SURROGATES = /[\ud800-\udfff]/u;

function fail(code) {
  throw new Error(`comfy_api_graph_${code}`);
}

function record(value) {
  if (!value || typeof value !== "object" || types.isProxy(value))
    fail("record_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail("record_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const entry = descriptors[key];
    if (typeof key !== "string" || UNSAFE_KEYS.has(key)) fail("key_invalid");
    if (!entry.enumerable || !Object.hasOwn(entry, "value"))
      fail("property_invalid");
  }
  return descriptors;
}

function nodeId(value) {
  if (typeof value !== "string" || value.length > 128 || !NODE_ID.test(value))
    fail("node_id_invalid");
  return value;
}

function text(value, maximum, controls, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && !value.trim()) ||
    controls.test(value) ||
    UNPAIRED_SURROGATES.test(value)
  )
    fail("text_invalid");
  return value;
}

function cloneJson(input) {
  let bytes = 0;
  const active = new Set();
  function account(size) {
    bytes += size;
    if (bytes > MAX_BYTES) fail("byte_limit");
  }
  function string(value) {
    if (
      value.length > MAX_STRING_BYTES ||
      Buffer.byteLength(value) > MAX_STRING_BYTES ||
      UNPAIRED_SURROGATES.test(value)
    )
      fail("string_invalid");
    account(Buffer.byteLength(JSON.stringify(value)));
    return value;
  }
  function copy(value, depth) {
    if (depth > 24) fail("depth_limit");
    if (typeof value === "string") return string(value);
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" &&
        Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value)))
    ) {
      account(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (!value || typeof value !== "object" || types.isProxy(value))
      fail("json_invalid");
    if (active.has(value)) fail("json_cycle");
    active.add(value);
    let result;
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > MAX_BYTES
      )
        fail("array_invalid");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).length !== value.length + 1)
        fail("array_invalid");
      result = [];
      account(2 + Math.max(0, value.length - 1));
      for (let index = 0; index < value.length; index++) {
        const entry = descriptors[index];
        if (!entry?.enumerable || !Object.hasOwn(entry, "value"))
          fail("array_invalid");
        result.push(copy(entry.value, depth + 1));
      }
    } else {
      const entries = Object.entries(record(value));
      result = {};
      account(2 + Math.max(0, entries.length - 1));
      for (const [key, entry] of entries) {
        string(key);
        account(1);
        result[key] = copy(entry.value, depth + 1);
      }
    }
    active.delete(value);
    return result;
  }
  return copy(input, 0);
}

function freezeJson(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

function slot(value) {
  const entries = record(value);
  if (Object.keys(entries).length !== 2 || !entries.nodeId || !entries.input)
    fail("slot_invalid");
  return {
    nodeId: nodeId(entries.nodeId.value),
    input: text(entries.input.value, 256, ALL_CONTROLS),
  };
}

function options(input) {
  const entries = record(input);
  if (
    Object.keys(entries).some(
      (key) =>
        !["outputNodeId", "prompt", "outputPrefix", "objectInfo"].includes(key),
    ) ||
    !entries.outputNodeId ||
    !entries.prompt ||
    !entries.outputPrefix
  )
    fail("options_invalid");
  const result = {
    outputNodeId: nodeId(entries.outputNodeId.value),
    prompt: slot(entries.prompt.value),
    outputPrefix: slot(entries.outputPrefix.value),
    objectInfo: entries.objectInfo?.value,
  };
  if (
    result.outputPrefix.nodeId !== result.outputNodeId ||
    result.outputPrefix.input !== "filename_prefix" ||
    (result.prompt.nodeId === result.outputPrefix.nodeId &&
      result.prompt.input === result.outputPrefix.input)
  )
    fail("slot_invalid");
  return result;
}

/** Author-side API JSON validation only; registration/valid JSON do not prove runtime readiness. */
export function validateComfyApiGraph(input, inputOptions) {
  const source = record(input);
  const ids = Object.keys(source);
  if (!ids.length || ids.length > 512) fail("node_limit");
  for (const id of ids) nodeId(id);
  const config = options(inputOptions);
  const graph = cloneJson(input);
  const metadata =
    config.objectInfo === undefined ? null : record(config.objectInfo);
  const outputCounts = new Map();
  const dependencies = new Map();
  for (const id of ids) {
    const node = graph[id];
    const entries = record(node);
    if (
      Object.keys(entries).some(
        (key) => !["class_type", "inputs", "_meta"].includes(key),
      ) ||
      !entries.class_type ||
      !entries.inputs
    )
      fail("node_shape_invalid");
    text(node.class_type, 256, ALL_CONTROLS);
    if (PLACEHOLDER.test(node.class_type)) fail("placeholder_node");
    record(node.inputs);
    if (node._meta !== undefined) record(node._meta);
    if (Object.keys(node.inputs).some((key) => PLACEHOLDER.test(key)))
      fail("placeholder_input");
    if (metadata) {
      if (!Object.hasOwn(metadata, node.class_type)) fail("class_unregistered");
      const entry = metadata[node.class_type];
      const classInfo = record(entry.value);
      const outputs = classInfo.output?.value;
      if (!Array.isArray(outputs) || types.isProxy(outputs))
        fail("object_info_invalid");
      outputCounts.set(id, outputs.length);
    }
    dependencies.set(id, []);
  }
  for (const id of ids) {
    for (const value of Object.values(graph[id].inputs)) {
      // In API input position a two-item array is a ComfyUI wire: [nodeId, outputIndex].
      if (!Array.isArray(value) || value.length !== 2) continue;
      const sourceId = nodeId(value[0]);
      if (!Object.hasOwn(graph, sourceId)) fail("link_missing");
      if (!Number.isSafeInteger(value[1]) || value[1] < 0)
        fail("link_index_invalid");
      if (metadata && value[1] >= outputCounts.get(sourceId))
        fail("link_output_missing");
      dependencies.get(id).push(sourceId);
    }
  }
  const visited = new Set(),
    visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) fail("dependency_cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  const output = graph[config.outputNodeId];
  if (
    output?.class_type !== "SaveImage" ||
    !Array.isArray(output.inputs.images) ||
    output.inputs.images.length !== 2
  )
    fail("output_role_invalid");
  const promptNode = graph[config.prompt.nodeId];
  if (
    !promptNode ||
    !Object.hasOwn(promptNode.inputs, config.prompt.input) ||
    !Object.hasOwn(output.inputs, config.outputPrefix.input)
  )
    fail("slot_missing");
  const prompt = promptNode.inputs[config.prompt.input];
  const prefix = output.inputs[config.outputPrefix.input];
  text(prompt, 2000, PROMPT_CONTROLS, true);
  text(prefix, 128, ALL_CONTROLS, true);
  const ancestors = new Set();
  function collect(id) {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    for (const dependency of dependencies.get(id)) collect(dependency);
  }
  collect(config.outputNodeId);
  if (!ancestors.has(config.prompt.nodeId)) fail("prompt_disconnected");
  return freezeJson(graph);
}

/** Renders only the explicit reviewed prompt and output prefix slots, preserving every graph entry. */
export function renderComfyApiGraph(input, inputOptions, inputValues) {
  const values = record(inputValues);
  if (
    Object.keys(values).length !== 2 ||
    !values.prompt ||
    !values.outputPrefix
  )
    fail("render_values_invalid");
  const prompt = text(values.prompt.value, 2000, PROMPT_CONTROLS);
  const outputPrefix = text(values.outputPrefix.value, 128, ALL_CONTROLS);
  const config = options(inputOptions);
  const graph = cloneJson(validateComfyApiGraph(input, inputOptions));
  graph[config.prompt.nodeId].inputs[config.prompt.input] = prompt;
  graph[config.outputPrefix.nodeId].inputs[config.outputPrefix.input] =
    outputPrefix;
  if (Buffer.byteLength(JSON.stringify(graph)) > MAX_BYTES) fail("byte_limit");
  return freezeJson(graph);
}
