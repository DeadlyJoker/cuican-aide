// packages/contracts/src/contract-validation-error.ts
var ContractValidationError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "ContractValidationError";
    this.code = code;
  }
};

// packages/contracts/src/plugin-ui-json.ts
var PluginUiContractError = class extends ContractValidationError {
  constructor(code) {
    super(code);
    this.name = "PluginUiContractError";
  }
};
function pluginUiFailure(code) {
  throw new PluginUiContractError(code);
}
function parsePluginUiJsonValue(input, options = {}) {
  const maxBytes = options.maxBytes ?? 65536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536)
    pluginUiFailure("plugin_ui_json_limit_invalid");
  const ancestors = /* @__PURE__ */ new Set();
  let nodes = 0;
  let bytes = 0;
  function charge(size) {
    bytes += size;
    if (bytes > maxBytes) pluginUiFailure("plugin_ui_json_bytes_exceeded");
  }
  function quotedString(value) {
    if (value.length + 2 > maxBytes - bytes)
      pluginUiFailure("plugin_ui_json_bytes_exceeded");
    charge(2);
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 55296 && unit <= 56319) {
        const next = value.charCodeAt(++i);
        if (!(next >= 56320 && next <= 57343))
          pluginUiFailure("plugin_ui_json_invalid");
        charge(4);
      } else if (unit >= 56320 && unit <= 57343) {
        pluginUiFailure("plugin_ui_json_invalid");
      } else if (unit === 34 || unit === 92) {
        charge(2);
      } else if (unit < 32) {
        charge([8, 9, 10, 12, 13].includes(unit) ? 2 : 6);
      } else {
        charge(unit < 128 ? 1 : unit < 2048 ? 2 : 3);
      }
    }
  }
  function visit(value, depth) {
    if (++nodes > 8192 || depth > 16)
      pluginUiFailure("plugin_ui_json_complexity_exceeded");
    if (value === null || typeof value === "boolean") {
      charge(value === null || value === true ? 4 : 5);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) pluginUiFailure("plugin_ui_json_invalid");
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value === "string") {
      if (value.length > maxBytes) pluginUiFailure("plugin_ui_json_invalid");
      quotedString(value);
      return value;
    }
    if (typeof value !== "object") pluginUiFailure("plugin_ui_json_invalid");
    if (ancestors.has(value)) pluginUiFailure("plugin_ui_json_cycle");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype)
          pluginUiFailure("plugin_ui_json_invalid");
        const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
        if (!Number.isSafeInteger(length) || length > 8192)
          pluginUiFailure("plugin_ui_json_complexity_exceeded");
        const keys2 = Reflect.ownKeys(value);
        if (keys2.length !== length + 1)
          pluginUiFailure("plugin_ui_json_invalid");
        charge(2);
        const copied2 = [];
        for (let i = 0; i < length; i++) {
          if (i !== 0) charge(1);
          copied2.push(visit(dataValue(value, String(i)), depth + 1));
        }
        return Object.freeze(copied2);
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        pluginUiFailure("plugin_ui_json_invalid");
      const keys = Reflect.ownKeys(value);
      if (keys.length > 8192)
        pluginUiFailure("plugin_ui_json_complexity_exceeded");
      charge(2);
      const entries = keys.map((key, index) => {
        if (typeof key !== "string") pluginUiFailure("plugin_ui_json_invalid");
        if (index !== 0) charge(1);
        quotedString(key);
        charge(1);
        return [key, visit(dataValue(value, key), depth + 1)];
      });
      return Object.freeze(Object.fromEntries(entries));
    } finally {
      ancestors.delete(value);
    }
  }
  const copied = visit(input, 0);
  if (new TextEncoder().encode(JSON.stringify(copied)).byteLength > maxBytes)
    pluginUiFailure("plugin_ui_json_bytes_exceeded");
  return copied;
}
function pluginUiFields(input, fields) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    pluginUiFailure("plugin_ui_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    pluginUiFailure("plugin_ui_object_invalid");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    pluginUiFailure("plugin_ui_fields_invalid");
  return Object.freeze(
    Object.fromEntries(fields.map((field) => [field, dataValue(input, field)])),
  );
}
function dataValue(input, name) {
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (!descriptor?.enumerable || !("value" in descriptor))
    pluginUiFailure("plugin_ui_data_property_required");
  return descriptor.value;
}

// packages/contracts/src/project-asset-contract-support.ts
var MAX_PUBLIC_PROJECT_ASSET_CONTENT_BYTES = 8 * 1024;
function assetContractFailure() {
  throw new ContractValidationError("project_asset_contract_invalid");
}
function assetContractRevision(
  input,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    assetContractFailure();
  return input;
}
function assetContractText(input, maximumBytes) {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > maximumBytes ||
    new TextEncoder().encode(input).byteLength > maximumBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)
  )
    assetContractFailure();
  for (const point of input) {
    const code = point.codePointAt(0);
    if (code >= 55296 && code <= 57343) assetContractFailure();
  }
  return input;
}
function assetContractOpaque(input) {
  const value = assetContractText(input, 512);
  if (
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    assetContractFailure();
  return value;
}
function assetContractId(input) {
  const value = assetContractOpaque(input);
  if (value === "." || value === "..") assetContractFailure();
  return value;
}
function assetContractDigest(input) {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    assetContractFailure();
  return input;
}
function assetContractTimestamp(input) {
  if (
    typeof input !== "string" ||
    input.length !== 24 ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  )
    assetContractFailure();
  return input;
}

// packages/contracts/src/project-media-inputs.ts
var MAX_PROJECT_MEDIA_INPUT_REQUEST_BYTES = 16 * 1024;
var MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES = 24 * 1024;
var contentFields = [
  "projectId",
  "item",
  "briefRevision",
  "script",
  "workflowId",
  "configurationRevision",
  "prompt",
  "references",
];
var record = pluginUiFields;
function checked(input, maxBytes, parse) {
  try {
    return parse(parsePluginUiJsonValue(input, { maxBytes }));
  } catch {
    throw new ContractValidationError("project_media_inputs_contract_invalid");
  }
}
function invalid() {
  throw new ContractValidationError("project_media_inputs_contract_invalid");
}
function content(r) {
  const projectId = assetContractId(r.projectId),
    workflowId = r.workflowId;
  if (
    workflowId !== "krea2-reference-four-view" &&
    workflowId !== "flux2-three-reference-storyboard"
  )
    invalid();
  const itemFields =
    workflowId === "krea2-reference-four-view"
      ? ["kind", "assetId"]
      : ["kind", "episodeId"];
  const i = record(r.item, itemFields);
  let item;
  if (workflowId === "krea2-reference-four-view") {
    if (i.kind !== "character-reference") invalid();
    item = Object.freeze({ kind: i.kind, assetId: assetContractId(i.assetId) });
  } else {
    if (i.kind !== "storyboard-frame-exploration") invalid();
    item = Object.freeze({
      kind: i.kind,
      episodeId: assetContractId(i.episodeId),
    });
  }
  const s =
    r.script === null
      ? null
      : record(r.script, ["artifactId", "contentRevision"]);
  const script =
    s === null
      ? null
      : Object.freeze({
          artifactId: assetContractId(s.artifactId),
          contentRevision: assetContractRevision(s.contentRevision),
        });
  if (workflowId === "flux2-three-reference-storyboard" && script === null)
    invalid();
  const roles =
    workflowId === "krea2-reference-four-view"
      ? ["character"]
      : ["scene", "characterOne", "characterTwo"];
  const refs = record(r.references, roles);
  const references = {};
  for (const role of roles) {
    const v = record(refs[role], [
      "projectId",
      "assetId",
      "kind",
      "expectedAssetRevision",
      "contentRevision",
      "referenceRevision",
    ]);
    const kind = role === "scene" ? "scene" : "character";
    if (v.kind !== kind || assetContractId(v.projectId) !== projectId)
      invalid();
    references[role] = Object.freeze({
      projectId,
      assetId: assetContractId(v.assetId),
      kind,
      expectedAssetRevision: assetContractRevision(v.expectedAssetRevision),
      contentRevision: assetContractRevision(v.contentRevision),
      referenceRevision: assetContractRevision(v.referenceRevision),
    });
  }
  if (
    new Set(roles.map((role) => references[role].assetId)).size !==
      roles.length ||
    (item.kind === "character-reference" &&
      item.assetId !== references.character.assetId)
  )
    invalid();
  return Object.freeze({
    projectId,
    item,
    briefRevision: assetContractRevision(r.briefRevision),
    script,
    workflowId,
    configurationRevision: assetContractRevision(r.configurationRevision),
    prompt: assetContractText(r.prompt, 8192),
    references: Object.freeze(references),
  });
}
function parseSaveMediaInputRequest(input) {
  return checked(input, MAX_PROJECT_MEDIA_INPUT_REQUEST_BYTES, (copy) => {
    const r = record(copy, [
      ...contentFields,
      "mediaInputId",
      "expectedInputRevision",
      "idempotencyKey",
    ]);
    const mediaInputId =
      r.mediaInputId === null ? null : assetContractId(r.mediaInputId);
    const expectedInputRevision = assetContractRevision(
      r.expectedInputRevision,
      0,
    );
    if ((mediaInputId === null) !== (expectedInputRevision === 0)) invalid();
    return Object.freeze({
      ...content(r),
      mediaInputId,
      expectedInputRevision,
      idempotencyKey: assetContractId(r.idempotencyKey),
    });
  });
}
function parseLoadMediaInputRequest(input) {
  return checked(input, 1024, (copy) => {
    const r = record(copy, ["projectId", "mediaInputId", "inputRevision"]);
    return Object.freeze({
      projectId: assetContractId(r.projectId),
      mediaInputId: assetContractId(r.mediaInputId),
      inputRevision:
        r.inputRevision === null
          ? null
          : assetContractRevision(r.inputRevision),
    });
  });
}
function publicInput(input) {
  const r = record(input, [
    ...contentFields,
    "mediaInputId",
    "inputRevision",
    "createdAt",
    "contentDigest",
  ]);
  return Object.freeze({
    ...content(r),
    mediaInputId: assetContractId(r.mediaInputId),
    inputRevision: assetContractRevision(r.inputRevision),
    createdAt: assetContractTimestamp(r.createdAt),
    contentDigest: assetContractDigest(r.contentDigest),
  });
}
function parseSaveMediaInputResponse(requestInput, input) {
  const request = parseSaveMediaInputRequest(requestInput);
  return checked(input, MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES, (copy) => {
    const r = record(copy, ["disposition", "input"]);
    if (r.disposition !== "committed" && r.disposition !== "replayed")
      invalid();
    const result = publicInput(r.input);
    if (
      (request.mediaInputId !== null &&
        result.mediaInputId !== request.mediaInputId) ||
      result.inputRevision !== request.expectedInputRevision + 1 ||
      contentFields.some(
        (key) => JSON.stringify(result[key]) !== JSON.stringify(request[key]),
      )
    )
      invalid();
    return Object.freeze({ disposition: r.disposition, input: result });
  });
}
function parseLoadMediaInputResponse(requestInput, input) {
  const request = parseLoadMediaInputRequest(requestInput);
  return checked(input, MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES, (copy) => {
    const r = record(copy, ["state"]);
    if (r.state === null) return Object.freeze({ state: null });
    const state = record(r.state, ["input", "latestInputRevision"]),
      result = publicInput(state.input),
      latestInputRevision = assetContractRevision(state.latestInputRevision);
    if (
      result.projectId !== request.projectId ||
      result.mediaInputId !== request.mediaInputId ||
      (request.inputRevision !== null &&
        result.inputRevision !== request.inputRevision) ||
      latestInputRevision < result.inputRevision ||
      (request.inputRevision === null &&
        latestInputRevision !== result.inputRevision)
    )
      invalid();
    return Object.freeze({
      state: Object.freeze({ input: result, latestInputRevision }),
    });
  });
}

// packages/contracts/src/project-media-input-catalog.ts
function parseMediaInputOptionsRequest(input) {
  const f = pluginUiFields(parsePluginUiJsonValue(input, { maxBytes: 1024 }), [
    "projectId",
  ]);
  return Object.freeze({ projectId: assetContractId(f.projectId) });
}
function parseMediaInputOptionsResponse(input) {
  const f = pluginUiFields(parsePluginUiJsonValue(input, { maxBytes: 1024 }), [
    "configuration",
  ]);
  if (f.configuration === null) return Object.freeze({ configuration: null });
  const r = pluginUiFields(f.configuration, ["revision", "workflows"]);
  if (
    !Array.isArray(r.workflows) ||
    r.workflows.length < 1 ||
    r.workflows.length > 2 ||
    new Set(r.workflows).size !== r.workflows.length ||
    r.workflows.some(
      (w) =>
        w !== "krea2-reference-four-view" &&
        w !== "flux2-three-reference-storyboard",
    )
  )
    invalid2();
  return Object.freeze({
    configuration: Object.freeze({
      revision: assetContractRevision(r.revision),
      workflows: Object.freeze(r.workflows),
    }),
  });
}
function parseListMediaInputsRequest(input) {
  const f = pluginUiFields(parsePluginUiJsonValue(input, { maxBytes: 2048 }), [
    "projectId",
    "afterMediaInputId",
    "limit",
  ]);
  if (!Number.isSafeInteger(f.limit) || f.limit < 1 || f.limit > 16) invalid2();
  return Object.freeze({
    projectId: assetContractId(f.projectId),
    afterMediaInputId:
      f.afterMediaInputId === null
        ? null
        : assetContractId(f.afterMediaInputId),
    limit: f.limit,
  });
}
function parseListMediaInputsResponse(requestInput, input) {
  const q = parseListMediaInputsRequest(requestInput);
  const f = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
    ["inputs", "nextMediaInputId"],
  );
  if (!Array.isArray(f.inputs) || f.inputs.length > q.limit) invalid2();
  let previous = q.afterMediaInputId;
  const inputs = f.inputs.map((entry) => {
    const r = pluginUiFields(entry, [
      "projectId",
      "mediaInputId",
      "latestInputRevision",
      "item",
      "workflowId",
      "createdAt",
    ]);
    const mediaInputId = assetContractId(r.mediaInputId),
      projectId = assetContractId(r.projectId);
    if (
      projectId !== q.projectId ||
      (previous !== null && compare(previous, mediaInputId) >= 0)
    )
      invalid2();
    previous = mediaInputId;
    let item;
    if (r.workflowId === "krea2-reference-four-view") {
      const i = pluginUiFields(r.item, ["kind", "assetId"]);
      if (i.kind !== "character-reference") invalid2();
      item = Object.freeze({
        kind: i.kind,
        assetId: assetContractId(i.assetId),
      });
    } else if (r.workflowId === "flux2-three-reference-storyboard") {
      const i = pluginUiFields(r.item, ["kind", "episodeId"]);
      if (i.kind !== "storyboard-frame-exploration") invalid2();
      item = Object.freeze({
        kind: i.kind,
        episodeId: assetContractId(i.episodeId),
      });
    } else invalid2();
    return Object.freeze({
      projectId,
      mediaInputId,
      latestInputRevision: assetContractRevision(r.latestInputRevision),
      item,
      workflowId: r.workflowId,
      createdAt: assetContractTimestamp(r.createdAt),
    });
  });
  const nextMediaInputId =
    f.nextMediaInputId === null ? null : assetContractId(f.nextMediaInputId);
  if (
    nextMediaInputId !== null &&
    (inputs.length !== q.limit ||
      nextMediaInputId !== inputs.at(-1)?.mediaInputId)
  )
    invalid2();
  return Object.freeze({ inputs: Object.freeze(inputs), nextMediaInputId });
}
function compare(a, b) {
  const aa = [...a],
    bb = [...b];
  for (let n = 0; n < Math.min(aa.length, bb.length); n++) {
    const difference = aa[n].codePointAt(0) - bb[n].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return aa.length - bb.length;
}
function invalid2() {
  throw new ContractValidationError("project_media_input_catalog_invalid");
}

// packages/contracts/src/project-media-input-tools.ts
var PROJECT_MEDIA_INPUT_TOOLS_SERVICE = "crewon.project-media-input-tools";
var PROJECT_MEDIA_INPUT_TOOLS_API_VERSION = "1";
var MAX_MEDIA_INPUT_TOOL_RESPONSE_BYTES = 8192;
var MEDIA_INPUT_TOOL_METHODS = [
  "getContext",
  "getOptions",
  "listInputs",
  "getInput",
  "readPrompt",
  "saveInput",
];
var validationKey = "host-only-media-input-validation";
var omittedPrompt = "Prompt omitted from bounded metadata acknowledgement.";
function fail() {
  throw new ContractValidationError(
    "project_media_input_tools_contract_invalid",
  );
}
function plain(input, maximum) {
  return parsePluginUiJsonValue(input, { maxBytes: maximum });
}
function parseMediaInputToolRequest(method, input) {
  const value = plain(input, 16384);
  let result;
  switch (method) {
    case "getContext":
      result = Object.freeze(pluginUiFields(value, []));
      break;
    case "getOptions":
      result = parseMediaInputOptionsRequest(value);
      break;
    case "listInputs": {
      const request = parseListMediaInputsRequest(value);
      if (request.limit > 4) fail();
      result = request;
      break;
    }
    case "getInput":
      result = parseLoadMediaInputRequest(value);
      break;
    case "readPrompt": {
      const r = pluginUiFields(value, [
        "projectId",
        "mediaInputId",
        "inputRevision",
        "offset",
      ]);
      result = Object.freeze({
        projectId: assetContractId(r.projectId),
        mediaInputId: assetContractId(r.mediaInputId),
        inputRevision: assetContractRevision(r.inputRevision),
        offset: assetContractRevision(r.offset, 0, 8192),
      });
      break;
    }
    case "saveInput": {
      const r = pluginUiFields(value, [
        "projectId",
        "mediaInputId",
        "expectedInputRevision",
        "item",
        "briefRevision",
        "script",
        "workflowId",
        "configurationRevision",
        "prompt",
        "references",
      ]);
      const { idempotencyKey: _key, ...request } = parseSaveMediaInputRequest({
        ...r,
        idempotencyKey: validationKey,
      });
      result = Object.freeze(request);
      break;
    }
    default:
      return fail();
  }
  return result;
}
function parseMediaInputToolCommand(input) {
  const r = pluginUiFields(plain(input, 32768), ["method", "requestJson"]);
  if (
    !MEDIA_INPUT_TOOL_METHODS.includes(r.method) ||
    typeof r.requestJson !== "string"
  )
    fail();
  const method = r.method;
  return Object.freeze({
    method,
    request: parseMediaInputToolRequest(method, JSON.parse(r.requestJson)),
  });
}
function metadata(input) {
  const r = pluginUiFields(input, [
    "projectId",
    "mediaInputId",
    "inputRevision",
    "item",
    "briefRevision",
    "script",
    "workflowId",
    "configurationRevision",
    "references",
    "createdAt",
    "contentDigest",
  ]);
  const state = parseLoadMediaInputResponse(
    {
      projectId: assetContractId(r.projectId),
      mediaInputId: assetContractId(r.mediaInputId),
      inputRevision: assetContractRevision(r.inputRevision),
    },
    {
      state: {
        input: { ...r, prompt: omittedPrompt },
        latestInputRevision: r.inputRevision,
      },
    },
  ).state;
  const { prompt: _prompt, ...result } = state.input;
  return Object.freeze(result);
}
function assertMediaInputToolResponseBudget(value) {
  const resultJson = JSON.stringify(value);
  if (
    typeof resultJson !== "string" ||
    new TextEncoder().encode(JSON.stringify({ resultJson })).byteLength >
      MAX_MEDIA_INPUT_TOOL_RESPONSE_BYTES
  )
    fail();
}
function parseMediaInputToolResponse(method, requestInput, input) {
  const request = parseMediaInputToolRequest(method, requestInput);
  const copy = plain(input, MAX_MEDIA_INPUT_TOOL_RESPONSE_BYTES);
  let result;
  switch (method) {
    case "getContext": {
      const r = pluginUiFields(copy, [
        "projectId",
        "runId",
        "threadId",
        "workspaceId",
        "bindingRevision",
        "workflowId",
        "configurationRevision",
        "briefRevision",
        "script",
      ]);
      if (
        r.workflowId !== "krea2-reference-four-view" &&
        r.workflowId !== "flux2-three-reference-storyboard"
      )
        fail();
      const s =
        r.script === null
          ? null
          : pluginUiFields(r.script, [
              "artifactId",
              "episodeId",
              "contentRevision",
            ]);
      if (r.workflowId === "flux2-three-reference-storyboard" && s === null)
        fail();
      result = Object.freeze({
        projectId: assetContractId(r.projectId),
        runId: assetContractId(r.runId),
        threadId: assetContractId(r.threadId),
        workspaceId:
          r.workspaceId === null ? null : assetContractId(r.workspaceId),
        bindingRevision: assetContractRevision(r.bindingRevision),
        workflowId: r.workflowId,
        configurationRevision: assetContractRevision(r.configurationRevision),
        briefRevision: assetContractRevision(r.briefRevision),
        script:
          s === null
            ? null
            : Object.freeze({
                artifactId: assetContractId(s.artifactId),
                episodeId: assetContractId(s.episodeId),
                contentRevision: assetContractRevision(s.contentRevision),
              }),
      });
      break;
    }
    case "getOptions":
      result = parseMediaInputOptionsResponse(copy);
      break;
    case "listInputs":
      result = parseListMediaInputsResponse(request, copy);
      break;
    case "getInput": {
      const r = pluginUiFields(copy, ["state"]);
      if (r.state === null) {
        result = Object.freeze({ state: null });
        break;
      }
      const s = pluginUiFields(r.state, ["input", "latestInputRevision"]),
        m = metadata(s.input);
      const checked2 = parseLoadMediaInputResponse(request, {
        state: {
          input: { ...m, prompt: omittedPrompt },
          latestInputRevision: s.latestInputRevision,
        },
      }).state;
      result = Object.freeze({
        state: Object.freeze({
          input: m,
          latestInputRevision: checked2.latestInputRevision,
        }),
      });
      break;
    }
    case "saveInput": {
      const r = pluginUiFields(copy, ["disposition", "input"]),
        m = metadata(r.input);
      const checked2 = parseSaveMediaInputResponse(
        {
          ...request,
          idempotencyKey: validationKey,
          prompt: omittedPrompt,
        },
        { disposition: r.disposition, input: { ...m, prompt: omittedPrompt } },
      );
      result = Object.freeze({ disposition: checked2.disposition, input: m });
      break;
    }
    case "readPrompt": {
      const q = request;
      const r = pluginUiFields(copy, [
        "projectId",
        "mediaInputId",
        "inputRevision",
        "contentDigest",
        "offset",
        "nextOffset",
        "totalCodePoints",
        "text",
      ]);
      const total = assetContractRevision(r.totalCodePoints, 1, 8192),
        offset = assetContractRevision(r.offset, 0, total);
      if (
        typeof r.text !== "string" ||
        new TextEncoder().encode(r.text).byteLength > 2048 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(r.text)
      )
        fail();
      const points = [...r.text];
      if (
        points.some((p) => {
          const n = p.codePointAt(0);
          return n >= 55296 && n <= 57343;
        })
      )
        fail();
      const end = offset + points.length;
      if (
        end > total ||
        (end < total && points.length === 0) ||
        r.nextOffset !== (end === total ? null : end) ||
        q.offset !== offset ||
        q.projectId !== assetContractId(r.projectId) ||
        q.mediaInputId !== assetContractId(r.mediaInputId) ||
        q.inputRevision !== assetContractRevision(r.inputRevision)
      )
        fail();
      result = Object.freeze({
        ...q,
        contentDigest: assetContractDigest(r.contentDigest),
        nextOffset: r.nextOffset,
        totalCodePoints: total,
        text: r.text,
      });
      break;
    }
    default:
      return fail();
  }
  assertMediaInputToolResponseBudget(result);
  return result;
}
function mediaInputToolMetadata(input) {
  const { prompt: _prompt, ...value } = input;
  return metadata(value);
}
export {
  MAX_MEDIA_INPUT_TOOL_RESPONSE_BYTES,
  MEDIA_INPUT_TOOL_METHODS,
  PROJECT_MEDIA_INPUT_TOOLS_API_VERSION,
  PROJECT_MEDIA_INPUT_TOOLS_SERVICE,
  assertMediaInputToolResponseBudget,
  mediaInputToolMetadata,
  parseMediaInputToolCommand,
  parseMediaInputToolRequest,
  parseMediaInputToolResponse,
};
