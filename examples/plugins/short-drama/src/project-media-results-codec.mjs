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

// packages/contracts/src/project-media-results.ts
var MAX_MEDIA_RESULT_CATALOG_BYTES = 64 * 1024;
function mediaResultCandidateId(input) {
  if (typeof input !== "string" || !/^result-[a-f0-9]{64}$/u.test(input))
    invalid();
  return input;
}
function parseListProjectMediaResultsRequest(input) {
  const r = pluginUiFields(parsePluginUiJsonValue(input, { maxBytes: 2048 }), [
    "projectId",
    "afterCandidateId",
    "limit",
  ]);
  return Object.freeze({
    projectId: assetContractId(r.projectId),
    afterCandidateId:
      r.afterCandidateId === null
        ? null
        : mediaResultCandidateId(r.afterCandidateId),
    limit: assetContractRevision(r.limit, 1, 16),
  });
}
function parseListProjectMediaResultsResponse(request, input) {
  const q = parseListProjectMediaResultsRequest(request),
    r = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_MEDIA_RESULT_CATALOG_BYTES,
      }),
      ["candidates", "nextCandidateId"],
    );
  if (!Array.isArray(r.candidates) || r.candidates.length > q.limit) invalid();
  let previous = q.afterCandidateId;
  const positions = /* @__PURE__ */ new Set();
  const candidates = r.candidates.map((entry) => {
    const c = pluginUiFields(entry, [
        "projectId",
        "candidateId",
        "runId",
        "resultIndex",
        "executionId",
        "mediaInputId",
        "inputRevision",
        "workflowId",
        "item",
        "contentDigest",
        "media",
      ]),
      candidateId = mediaResultCandidateId(c.candidateId),
      projectId = assetContractId(c.projectId),
      runId = assetContractId(c.runId),
      resultIndex = assetContractRevision(c.resultIndex, 0, 15),
      position = JSON.stringify([runId, resultIndex]);
    if (
      projectId !== q.projectId ||
      (previous !== null && candidateId <= previous) ||
      positions.has(position)
    )
      invalid();
    previous = candidateId;
    positions.add(position);
    let item;
    if (c.workflowId === "krea2-reference-four-view") {
      const value = pluginUiFields(c.item, ["kind", "assetId"]);
      if (value.kind !== "character-reference") invalid();
      item = Object.freeze({
        kind: value.kind,
        assetId: assetContractId(value.assetId),
      });
    } else if (c.workflowId === "flux2-three-reference-storyboard") {
      const value = pluginUiFields(c.item, ["kind", "episodeId"]);
      if (value.kind !== "storyboard-frame-exploration") invalid();
      item = Object.freeze({
        kind: value.kind,
        episodeId: assetContractId(value.episodeId),
      });
    } else invalid();
    const m = pluginUiFields(c.media, [
      "type",
      "byteDigest",
      "byteLength",
      "width",
      "height",
      "observedAt",
    ]);
    if (m.type !== "image/png") invalid();
    return Object.freeze({
      projectId,
      candidateId,
      runId,
      resultIndex,
      executionId: assetContractId(c.executionId),
      mediaInputId: assetContractId(c.mediaInputId),
      inputRevision: assetContractRevision(c.inputRevision),
      workflowId: c.workflowId,
      item,
      contentDigest: assetContractDigest(c.contentDigest),
      media: Object.freeze({
        type: m.type,
        byteDigest: assetContractDigest(m.byteDigest),
        byteLength: assetContractRevision(m.byteLength, 57, 16 * 1024 * 1024),
        width: assetContractRevision(m.width, 1, 4096),
        height: assetContractRevision(m.height, 1, 4096),
        observedAt: assetContractTimestamp(m.observedAt),
      }),
    });
  });
  const nextCandidateId =
    r.nextCandidateId === null
      ? null
      : mediaResultCandidateId(r.nextCandidateId);
  if (
    nextCandidateId !== null &&
    (candidates.length !== q.limit ||
      candidates.at(-1)?.candidateId !== nextCandidateId)
  )
    invalid();
  return Object.freeze({
    candidates: Object.freeze(candidates),
    nextCandidateId,
  });
}
function invalid() {
  throw new ContractValidationError("project_media_results_contract_invalid");
}
function parseProjectMediaRunLocator(input) {
  const r = pluginUiFields(parsePluginUiJsonValue(input, { maxBytes: 2048 }), [
    "projectId",
    "runId",
  ]);
  return Object.freeze({
    projectId: assetContractId(r.projectId),
    runId: assetContractId(r.runId),
  });
}
function parseProjectMediaRunOutputs(request, input) {
  const q = parseProjectMediaRunLocator(request);
  const r = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: MAX_MEDIA_RESULT_CATALOG_BYTES }),
    ["projectId", "runId", "mediaInputId", "inputRevision", "outputs"],
  );
  if (
    r.projectId !== q.projectId ||
    r.runId !== q.runId ||
    !Array.isArray(r.outputs) ||
    r.outputs.length < 1 ||
    r.outputs.length > 16
  )
    invalid();
  const mediaInputId = assetContractId(r.mediaInputId),
    inputRevision = assetContractRevision(r.inputRevision);
  const outputs = r.outputs.map((entry, index) => {
    const e = pluginUiFields(entry, ["resultIndex", "candidate"]);
    if (e.resultIndex !== index) invalid();
    const { candidate } = parseGetProjectMediaResultResponse(
      { ...q, resultIndex: index },
      { candidate: e.candidate },
    );
    if (
      candidate &&
      (candidate.mediaInputId !== mediaInputId ||
        candidate.inputRevision !== inputRevision)
    )
      invalid();
    return Object.freeze({ resultIndex: index, candidate });
  });
  return Object.freeze({
    ...q,
    mediaInputId,
    inputRevision,
    outputs: Object.freeze(outputs),
  });
}
function parseProjectMediaResultLocator(input) {
  const r = pluginUiFields(parsePluginUiJsonValue(input, { maxBytes: 2048 }), [
    "projectId",
    "runId",
    "resultIndex",
  ]);
  return Object.freeze({
    projectId: assetContractId(r.projectId),
    runId: assetContractId(r.runId),
    resultIndex: assetContractRevision(r.resultIndex, 0, 15),
  });
}
function parseGetProjectMediaResultResponse(request, input) {
  const q = parseProjectMediaResultLocator(request),
    r = pluginUiFields(parsePluginUiJsonValue(input, { maxBytes: 8192 }), [
      "candidate",
    ]);
  if (r.candidate === null) return Object.freeze({ candidate: null });
  const candidate = parseListProjectMediaResultsResponse(
    { projectId: q.projectId, afterCandidateId: null, limit: 1 },
    { candidates: [r.candidate], nextCandidateId: null },
  ).candidates[0];
  if (candidate.runId !== q.runId || candidate.resultIndex !== q.resultIndex)
    invalid();
  return Object.freeze({ candidate });
}
function parsePublishProjectMediaResultResponse(request, input) {
  const r = pluginUiFields(parsePluginUiJsonValue(input, { maxBytes: 8192 }), [
    "disposition",
    "candidate",
  ]);
  if (r.disposition !== "created" && r.disposition !== "replayed") invalid();
  const { candidate } = parseGetProjectMediaResultResponse(request, {
    candidate: r.candidate,
  });
  if (candidate === null) invalid();
  return Object.freeze({ disposition: r.disposition, candidate });
}
export {
  MAX_MEDIA_RESULT_CATALOG_BYTES,
  mediaResultCandidateId,
  parseGetProjectMediaResultResponse,
  parseListProjectMediaResultsRequest,
  parseListProjectMediaResultsResponse,
  parseProjectMediaResultLocator,
  parseProjectMediaRunLocator,
  parseProjectMediaRunOutputs,
  parsePublishProjectMediaResultResponse,
};
