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

function options(input, outputRole) {
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
    prompt:
      outputRole === VIDEO_OUTPUT && entries.prompt.value === null
        ? null
        : slot(entries.prompt.value),
    outputPrefix: slot(entries.outputPrefix.value),
    objectInfo: entries.objectInfo?.value,
  };
  if (
    result.outputPrefix.nodeId !== result.outputNodeId ||
    result.outputPrefix.input !== "filename_prefix" ||
    (result.prompt?.nodeId === result.outputPrefix.nodeId &&
      result.prompt?.input === result.outputPrefix.input)
  )
    fail("slot_invalid");
  return result;
}

const IMAGE_OUTPUT = Object.freeze({ className: "SaveImage", input: "images" });
const VIDEO_OUTPUT = Object.freeze({ className: "SaveVideo", input: "video" });
const AUDIO_OUTPUT = Object.freeze({ className: "SaveAudio", input: "audio" });

/** Author-side API JSON validation only; registration/valid JSON do not prove runtime readiness. */
export function validateComfyApiGraph(input, inputOptions) {
  return validateGraph(input, inputOptions, IMAGE_OUTPUT);
}

/** Explicit video authoring; it cannot qualify a v1 image workflow or authorize execution. */
export function validateComfyApiVideoGraph(input, inputOptions) {
  return validateGraph(input, inputOptions, VIDEO_OUTPUT);
}

/** Explicit lossless audio authoring; no execution or v1 image-result qualification. */
export function validateComfyApiAudioGraph(input, inputOptions) {
  return validateGraph(input, inputOptions, AUDIO_OUTPUT);
}

function validateGraph(input, inputOptions, outputRole) {
  const source = record(input);
  const ids = Object.keys(source);
  if (!ids.length || ids.length > 512) fail("node_limit");
  for (const id of ids) nodeId(id);
  const config = options(inputOptions, outputRole);
  const graph = cloneJson(input);
  const metadata =
    config.objectInfo === undefined
      ? null
      : record(
          outputRole === IMAGE_OUTPUT
            ? config.objectInfo
            : cloneJson(config.objectInfo),
        );
  const outputCounts = new Map();
  const outputTypes = new Map();
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
      outputTypes.set(id, outputs);
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
    output?.class_type !== outputRole.className ||
    !Array.isArray(output.inputs[outputRole.input]) ||
    output.inputs[outputRole.input].length !== 2
  )
    fail("output_role_invalid");
  if (outputRole === VIDEO_OUTPUT) {
    if (!metadata) fail("video_object_info_required");
    const wire = output.inputs.video;
    if (outputTypes.get(wire[0])?.[wire[1]] !== "VIDEO")
      fail("video_link_type_invalid");
    validateVideoSaveInputs(output.inputs, metadata.SaveVideo.value);
  }
  if (outputRole === AUDIO_OUTPUT) {
    if (!metadata) fail("audio_object_info_required");
    const wire = output.inputs.audio;
    if (outputTypes.get(wire[0])?.[wire[1]] !== "AUDIO")
      fail("audio_link_type_invalid");
    validateAudioSaveInputs(output.inputs, metadata.SaveAudio.value);
  }
  if (!Object.hasOwn(output.inputs, config.outputPrefix.input))
    fail("slot_missing");
  const prefix = output.inputs[config.outputPrefix.input];
  text(prefix, 128, ALL_CONTROLS, true);
  const ancestors = new Set();
  function collect(id) {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    for (const dependency of dependencies.get(id)) collect(dependency);
  }
  collect(config.outputNodeId);
  if (config.prompt !== null) {
    const promptNode = graph[config.prompt.nodeId];
    if (!promptNode || !Object.hasOwn(promptNode.inputs, config.prompt.input))
      fail("slot_missing");
    text(promptNode.inputs[config.prompt.input], 2000, PROMPT_CONTROLS, true);
    if (!ancestors.has(config.prompt.nodeId)) fail("prompt_disconnected");
  }
  return freezeJson(graph);
}

/** Renders only the explicit reviewed prompt and output prefix slots, preserving every graph entry. */
export function renderComfyApiGraph(input, inputOptions, inputValues) {
  return renderGraph(input, inputOptions, inputValues, IMAGE_OUTPUT);
}

export function renderComfyApiVideoGraph(input, inputOptions, inputValues) {
  return renderGraph(input, inputOptions, inputValues, VIDEO_OUTPUT);
}

export function renderComfyApiAudioGraph(input, inputOptions, inputValues) {
  return renderGraph(input, inputOptions, inputValues, AUDIO_OUTPUT);
}

function renderGraph(input, inputOptions, inputValues, outputRole) {
  const values = record(inputValues);
  if (
    Object.keys(values).length !== 2 ||
    !values.prompt ||
    !values.outputPrefix
  )
    fail("render_values_invalid");
  const config = options(inputOptions, outputRole);
  if (config.prompt === null && values.prompt.value !== null)
    fail("prompt_slot_absent");
  const prompt =
    config.prompt === null
      ? null
      : text(values.prompt.value, 2000, PROMPT_CONTROLS);
  const outputPrefix = text(values.outputPrefix.value, 128, ALL_CONTROLS);
  const graph = cloneJson(validateGraph(input, inputOptions, outputRole));
  if (config.prompt !== null)
    graph[config.prompt.nodeId].inputs[config.prompt.input] = prompt;
  graph[config.outputPrefix.nodeId].inputs[config.outputPrefix.input] =
    outputPrefix;
  if (Buffer.byteLength(JSON.stringify(graph)) > MAX_BYTES) fail("byte_limit");
  return freezeJson(graph);
}

/** SaveVideo V3 selects branches with flattened dotted keys, never a nested request object. */
function validateVideoSaveInputs(inputs, objectInfo) {
  const metadata = objectInfo;
  record(metadata.input);
  const allowed = new Set();
  function visit(declaration, prefix = "", depth = 0) {
    if (depth > 8) fail("video_input_schema_invalid");
    record(declaration);
    for (const group of ["required", "optional"]) {
      const fields = declaration[group] ?? {};
      record(fields);
      if (Object.keys(fields).length > 64) fail("video_input_schema_invalid");
      for (const [name, spec] of Object.entries(fields)) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
          !Array.isArray(spec) ||
          !spec.length
        )
          fail("video_input_schema_invalid");
        const key = prefix ? `${prefix}.${name}` : name;
        allowed.add(key);
        if (!Object.hasOwn(inputs, key)) {
          if (group === "required") fail("video_input_missing");
          continue;
        }
        const value = inputs[key],
          type = spec[0],
          parameters = spec[1] ?? {};
        record(parameters);
        if (type === "COMFY_DYNAMICCOMBO_V3") {
          if (
            !Array.isArray(parameters.options) ||
            parameters.options.length > 64
          )
            fail("video_input_schema_invalid");
          for (const option of parameters.options) {
            record(option);
            if (typeof option.key !== "string" || !option.inputs)
              fail("video_input_schema_invalid");
          }
          const selected = parameters.options.filter(
            (option) => option.key === value,
          );
          if (typeof value !== "string" || selected.length !== 1)
            fail("video_input_choice_invalid");
          visit(selected[0].inputs, key, depth + 1);
        } else if (type === "VIDEO") {
          if (key !== "video" || !Array.isArray(value))
            fail("video_input_type_invalid");
        } else if (Array.isArray(type)) {
          if (!type.includes(value)) fail("video_input_choice_invalid");
        } else if (type === "STRING") {
          if (typeof value !== "string") fail("video_input_type_invalid");
        } else if (type === "BOOLEAN") {
          if (typeof value !== "boolean") fail("video_input_type_invalid");
        } else if (type === "INT" || type === "FLOAT") {
          if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            (type === "INT" && !Number.isSafeInteger(value))
          )
            fail("video_input_type_invalid");
          if (
            [parameters.min, parameters.max].some(
              (limit) =>
                limit !== undefined &&
                (typeof limit !== "number" || !Number.isFinite(limit)),
            )
          )
            fail("video_input_schema_invalid");
          if (
            (parameters.min !== undefined && value < parameters.min) ||
            (parameters.max !== undefined && value > parameters.max)
          )
            fail("video_input_range_invalid");
        } else fail("video_input_schema_invalid");
      }
    }
  }
  visit(metadata.input);
  if (Object.keys(inputs).some((key) => !allowed.has(key)))
    fail("video_input_branch_invalid");
  // This adapter emits the current format.codec branch, not the hidden legacy codec alias.
  if (Object.hasOwn(inputs, "codec")) fail("video_legacy_codec_ambiguous");
}

/** Current SaveAudio emits FLAC. Do not invent a format/codec branch or accept a server file path. */
function validateAudioSaveInputs(inputs, metadata) {
  const declaration = record(metadata.input);
  const required = declaration.required?.value;
  record(required);
  if (
    Object.keys(required).length !== 2 ||
    !Array.isArray(required.audio) ||
    required.audio[0] !== "AUDIO" ||
    !Array.isArray(required.filename_prefix) ||
    required.filename_prefix[0] !== "STRING"
  )
    fail("audio_input_schema_invalid");
  if (
    Object.keys(inputs).length !== 2 ||
    !Object.hasOwn(inputs, "audio") ||
    !Object.hasOwn(inputs, "filename_prefix") ||
    typeof inputs.filename_prefix !== "string"
  )
    fail("audio_input_invalid");
}
