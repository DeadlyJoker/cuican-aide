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
function pluginUiFields(input, fields2) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    pluginUiFailure("plugin_ui_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    pluginUiFailure("plugin_ui_object_invalid");
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields2.length || keys.some((key) => typeof key !== "string" || !fields2.includes(key)))
    pluginUiFailure("plugin_ui_fields_invalid");
  return Object.freeze(
    Object.fromEntries(fields2.map((field) => [field, dataValue(input, field)]))
  );
}
function dataValue(input, name) {
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (!descriptor?.enumerable || !("value" in descriptor))
    pluginUiFailure("plugin_ui_data_property_required");
  return descriptor.value;
}

// packages/contracts/src/creative-project-control-types.ts
var MAX_CREATIVE_PROJECT_RESPONSE_BYTES = 60 * 1024;

// packages/contracts/src/creative-project-control-support.ts
function creativeControlFailure() {
  throw new ContractValidationError(
    "creative_project_control_contract_invalid"
  );
}
function creativeControlCopy(input) {
  try {
    return parsePluginUiJsonValue(input, {
      maxBytes: MAX_CREATIVE_PROJECT_RESPONSE_BYTES
    });
  } catch {
    return creativeControlFailure();
  }
}
function creativeControlRecord(input, fields2) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    creativeControlFailure();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields2.length || keys.some((key) => typeof key !== "string" || !fields2.includes(key)))
    creativeControlFailure();
  return Object.fromEntries(
    fields2.map((field) => {
      const own = Object.getOwnPropertyDescriptor(input, field);
      if (!own?.enumerable || !("value" in own)) creativeControlFailure();
      return [field, own.value];
    })
  );
}
function creativeControlText(input, maximumUtf16) {
  if (typeof input !== "string" || input.length > maximumUtf16 || !input.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input))
    creativeControlFailure();
  for (const point of input) {
    const code = point.codePointAt(0);
    if (code >= 55296 && code <= 57343) creativeControlFailure();
  }
  return input;
}
function creativeControlId(input) {
  const value = creativeControlText(input, 128);
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value) || value === "." || value === "..")
    creativeControlFailure();
  return value;
}
function creativeControlRevision(input, minimum = 1) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum)
    creativeControlFailure();
  return input;
}
function creativeControlTimestamp(input) {
  if (typeof input !== "string" || input.length !== 24 || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input)
    creativeControlFailure();
  return input;
}

// packages/contracts/src/project-asset-contract-support.ts
var MAX_PUBLIC_PROJECT_ASSET_CONTENT_BYTES = 8 * 1024;
function assetContractFailure() {
  throw new ContractValidationError("project_asset_contract_invalid");
}
function assetContractRevision(input, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > maximum)
    assetContractFailure();
  return input;
}
function assetContractText(input, maximumBytes) {
  if (typeof input !== "string" || !input.trim() || input.length > maximumBytes || new TextEncoder().encode(input).byteLength > maximumBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input))
    assetContractFailure();
  for (const point of input) {
    const code = point.codePointAt(0);
    if (code >= 55296 && code <= 57343) assetContractFailure();
  }
  return input;
}
function assetContractOpaque(input) {
  const value = assetContractText(input, 512);
  if (value.length > 128 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value))
    assetContractFailure();
  return value;
}
function assetContractId(input) {
  const value = assetContractOpaque(input);
  if (value === "." || value === "..") assetContractFailure();
  return value;
}

// packages/contracts/src/project-media-generations.ts
var PROJECT_MEDIA_GENERATE_UI_ACTION = "crewon.project-media-generations.v1.generate";
function parseProjectMediaGenerationUiRequest(input) {
  const r = pluginUiFields(
    parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES + 256
    }),
    ["action", "input"]
  );
  if (r.action !== PROJECT_MEDIA_GENERATE_UI_ACTION)
    throw new ContractValidationError(
      "project_media_generation_ui_action_invalid"
    );
  return Object.freeze({
    action: PROJECT_MEDIA_GENERATE_UI_ACTION,
    input: parseGenerateProjectMediaRequest(r.input)
  });
}
var MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES = 2048;
var fields = [
  "projectId",
  "mediaInputId",
  "inputRevision",
  "expectedInputRevision",
  "executionId",
  "threadId",
  "expectedThreadRevision",
  "idempotencyKey"
];
function checked(input, parse) {
  try {
    return parse(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES
      })
    );
  } catch {
    throw new ContractValidationError(
      "project_media_generations_contract_invalid"
    );
  }
}
function parseGenerateProjectMediaRequest(input) {
  return checked(input, (copy2) => {
    const r = pluginUiFields(copy2, fields);
    return Object.freeze({
      projectId: assetContractId(r.projectId),
      mediaInputId: assetContractId(r.mediaInputId),
      inputRevision: assetContractRevision(r.inputRevision),
      expectedInputRevision: assetContractRevision(r.expectedInputRevision),
      executionId: assetContractId(r.executionId),
      threadId: assetContractId(r.threadId),
      expectedThreadRevision: assetContractRevision(r.expectedThreadRevision),
      idempotencyKey: assetContractId(r.idempotencyKey)
    });
  });
}
function parseGenerateProjectMediaResponse(requestInput, input) {
  const request = parseGenerateProjectMediaRequest(requestInput);
  return checked(input, (copy2) => {
    const r = pluginUiFields(copy2, [
      "disposition",
      "projectId",
      "mediaInputId",
      "inputRevision",
      "executionId",
      "threadId",
      "threadRevision",
      "runId"
    ]);
    if (r.disposition !== "committed" && r.disposition !== "replayed" || r.projectId !== request.projectId || r.mediaInputId !== request.mediaInputId || r.inputRevision !== request.inputRevision || r.executionId !== request.executionId || r.threadId !== request.threadId || assetContractRevision(r.threadRevision) <= request.expectedThreadRevision)
      throw new Error("response_mismatch");
    return Object.freeze({
      disposition: r.disposition,
      projectId: request.projectId,
      mediaInputId: request.mediaInputId,
      inputRevision: request.inputRevision,
      executionId: request.executionId,
      threadId: request.threadId,
      threadRevision: assetContractRevision(r.threadRevision),
      runId: assetContractId(r.runId)
    });
  });
}

// packages/contracts/src/plugin-control-contract-support.ts
function pluginControlFail(code = "plugin_control_contract_invalid") {
  throw new ContractValidationError(code);
}
function pluginControlVersion(input) {
  if (typeof input !== "string" || input.length > 128 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
    input
  ))
    pluginControlFail("plugin_control_version_invalid");
  return input;
}

// packages/contracts/src/plugin-control-contract.ts
var MAX_PLUGIN_CONTROL_RESPONSE_BYTES = 128 * 1024;
var MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES = 512 * 1024;
var MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES = 16 * 1024 * 1024;
var MAX_PLUGIN_UI_ASSET_BYTES = 32 * 1024 * 1024;
function parsePluginControlPluginId(input) {
  if (typeof input !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(input))
    pluginControlFail("plugin_control_plugin_id_invalid");
  return input;
}
function parsePluginControlPackageDigest(input) {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    pluginControlFail("plugin_control_package_digest_invalid");
  return input;
}

// packages/contracts/src/creative-project-control-contract.ts
function parseCreativeProjectId(input) {
  return creativeControlId(input);
}
function parseCreativeProjectIdempotencyKey(input) {
  const value = creativeControlText(input, 128);
  if (value !== value.trim() || /[,\u0000-\u001f\u007f]/u.test(value))
    creativeControlFailure();
  return value;
}

// packages/contracts/src/extension-control-contract.ts
function parseExtensionIdempotencyKey(input) {
  return text(input, 128);
}
function text(input, maximum) {
  if (typeof input !== "string" || !input.trim() || input.trim() !== input || new TextEncoder().encode(input).length > maximum || /[\u0000-\u001f\u007f]/u.test(input))
    fail("extension_text_invalid");
  for (const point of input) {
    const code = point.codePointAt(0);
    if (code >= 55296 && code <= 57343) fail("extension_text_invalid");
  }
  return input;
}
function fail(code) {
  throw new ContractValidationError(code);
}

// packages/contracts/src/extension-read-contract.ts
var MAX_EXTENSION_CATALOG_RESPONSE_BYTES = 2 * 1024 * 1024;
var MAX_EXTENSION_READ_RESPONSE_BYTES = 128 * 1024;
var MAX_EXTENSION_CATALOG_SCHEMA_BYTES = 24 * 1024;
function parseExtensionRunId(input) {
  const value = text2(input, 128);
  if (value === "." || value === ".." || /[\\/]/u.test(value)) fail2();
  return value;
}
function text2(input, maximum) {
  if (typeof input !== "string" || !input || input !== input.trim() || input.length > maximum || new TextEncoder().encode(input).length > maximum || /[\u0000-\u001f\u007f]/u.test(input) || !wellFormed(input))
    fail2();
  return input;
}
function wellFormed(input) {
  for (const point of input) {
    const code = point.codePointAt(0);
    if (code >= 55296 && code <= 57343) return false;
  }
  return true;
}
function fail2() {
  throw new ContractValidationError("extension_read_contract_invalid");
}

// packages/contracts/src/project-generation-ui-action-contract.ts
var PROJECT_GENERATION_UI_ACTIONS = Object.freeze([
  "crewon.project-generations.v1.generateConcept"
]);
function positiveRevision(input) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    pluginUiFailure("project_generation_ui_action_invalid");
  return input;
}
function parseProjectGenerationUiReference(input) {
  const reference = pluginUiFields(input, [
    "projectId",
    "assetId",
    "assetRevision",
    "expectedProjectRevision",
    "expectedAssetMetadataRevision"
  ]);
  return Object.freeze({
    projectId: parseCreativeProjectId(reference.projectId),
    assetId: parseCreativeProjectId(reference.assetId),
    assetRevision: positiveRevision(reference.assetRevision),
    expectedProjectRevision: positiveRevision(
      reference.expectedProjectRevision
    ),
    expectedAssetMetadataRevision: positiveRevision(
      reference.expectedAssetMetadataRevision
    )
  });
}
function parseProjectGenerationUiActionRequest(input) {
  const envelope = pluginUiFields(input, ["action", "input"]);
  if (envelope.action !== PROJECT_GENERATION_UI_ACTIONS[0])
    pluginUiFailure("project_generation_ui_action_invalid");
  const value = pluginUiFields(
    parsePluginUiJsonValue(envelope.input, { maxBytes: 24 * 1024 }),
    ["reference", "threadId", "expectedThreadRevision", "idempotencyKey"]
  );
  const reference = parseProjectGenerationUiReference(value.reference);
  const expectedThreadRevision = positiveRevision(value.expectedThreadRevision);
  if (expectedThreadRevision === Number.MAX_SAFE_INTEGER)
    pluginUiFailure("project_generation_ui_action_invalid");
  return Object.freeze({
    action: PROJECT_GENERATION_UI_ACTIONS[0],
    input: Object.freeze({
      reference,
      // These follow the original task's UTF-8 opaque identifier bounds.
      threadId: parseExtensionIdempotencyKey(value.threadId),
      expectedThreadRevision,
      idempotencyKey: parseExtensionIdempotencyKey(value.idempotencyKey)
    })
  });
}
function parseProjectGenerationUiActionResponse(request, output) {
  const checked2 = parseProjectGenerationUiActionRequest(request);
  const value = pluginUiFields(
    parsePluginUiJsonValue(output, { maxBytes: 24 * 1024 }),
    [
      "disposition",
      "threadId",
      "threadRevision",
      "runId",
      "messageId",
      "configurationRevision"
    ]
  );
  if (value.disposition !== "committed" && value.disposition !== "replayed")
    pluginUiFailure("project_generation_ui_action_invalid");
  const threadId = parseExtensionIdempotencyKey(value.threadId);
  const threadRevision = positiveRevision(value.threadRevision);
  const configurationRevision = positiveRevision(value.configurationRevision);
  if (threadId !== checked2.input.threadId || threadRevision !== checked2.input.expectedThreadRevision + 1 || configurationRevision > 2147483647)
    pluginUiFailure("project_generation_ui_action_invalid");
  return Object.freeze({
    disposition: value.disposition,
    threadId,
    threadRevision,
    runId: parseExtensionRunId(value.runId),
    messageId: parseExtensionIdempotencyKey(value.messageId),
    configurationRevision
  });
}

// packages/contracts/src/project-generation-read-contract.ts
function parseConceptGenerationLocator(input) {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "projectId",
    "assetId",
    "assetRevision"
  ]);
  return Object.freeze({
    projectId: creativeControlId(value.projectId),
    assetId: creativeControlId(value.assetId),
    assetRevision: creativeControlRevision(value.assetRevision)
  });
}

// packages/contracts/src/project-generation-query-ui-action-contract.ts
var PROJECT_GENERATION_QUERY_UI_ACTIONS = Object.freeze([
  "crewon.project-generation-queries.v1.queryConceptGeneration"
]);
function positiveRevision2(input) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    pluginUiFailure("project_generation_query_ui_action_invalid");
  return input;
}
function parseProjectGenerationQueryUiActionRequest(input) {
  const envelope = pluginUiFields(input, ["action", "input"]);
  if (envelope.action !== PROJECT_GENERATION_QUERY_UI_ACTIONS[0])
    pluginUiFailure("project_generation_query_ui_action_invalid");
  const value = pluginUiFields(
    parsePluginUiJsonValue(envelope.input, { maxBytes: 24 * 1024 }),
    [
      "reference",
      "operationId",
      "threadId",
      "expectedThreadRevision",
      "idempotencyKey"
    ]
  );
  const expectedThreadRevision = positiveRevision2(value.expectedThreadRevision);
  if (expectedThreadRevision === Number.MAX_SAFE_INTEGER || typeof value.operationId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
    value.operationId
  ))
    pluginUiFailure("project_generation_query_ui_action_invalid");
  return Object.freeze({
    action: PROJECT_GENERATION_QUERY_UI_ACTIONS[0],
    input: Object.freeze({
      reference: parseConceptGenerationLocator(value.reference),
      operationId: value.operationId,
      threadId: parseExtensionIdempotencyKey(value.threadId),
      expectedThreadRevision,
      idempotencyKey: parseExtensionIdempotencyKey(value.idempotencyKey)
    })
  });
}
function parseProjectGenerationQueryUiActionResponse(request, output) {
  const checked2 = parseProjectGenerationQueryUiActionRequest(request);
  const value = pluginUiFields(
    parsePluginUiJsonValue(output, { maxBytes: 24 * 1024 }),
    [
      "disposition",
      "threadId",
      "threadRevision",
      "runId",
      "messageId",
      "configurationRevision"
    ]
  );
  if (value.disposition !== "committed" && value.disposition !== "replayed")
    pluginUiFailure("project_generation_query_ui_action_invalid");
  const threadId = parseExtensionIdempotencyKey(value.threadId);
  const threadRevision = positiveRevision2(value.threadRevision);
  const configurationRevision = positiveRevision2(value.configurationRevision);
  if (threadId !== checked2.input.threadId || threadRevision !== checked2.input.expectedThreadRevision + 1 || configurationRevision > 2147483647)
    pluginUiFailure("project_generation_query_ui_action_invalid");
  return Object.freeze({
    disposition: value.disposition,
    threadId,
    threadRevision,
    runId: parseExtensionRunId(value.runId),
    messageId: parseExtensionIdempotencyKey(value.messageId),
    configurationRevision
  });
}

// packages/contracts/src/project-generation-selection-contract.ts
var MAX_PROJECT_GENERATION_SELECTION_BYTES = 24 * 1024;
function fail3() {
  throw new ContractValidationError(
    "project_generation_selection_contract_invalid"
  );
}
function copy(input) {
  try {
    return parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_GENERATION_SELECTION_BYTES
    });
  } catch {
    return fail3();
  }
}
function operationId(input) {
  if (typeof input !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input))
    fail3();
  return input;
}
function resultIndex(input) {
  const value = creativeControlRevision(input, 0);
  if (value > 15) fail3();
  return value;
}
function imageUrl(input) {
  const value = creativeControlText(input, 2048);
  if (new TextEncoder().encode(value).byteLength > 2048 || /[\u0000-\u0020\u007f]/u.test(value))
    fail3();
  let url;
  try {
    url = new URL(value);
  } catch {
    return fail3();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || value.includes("#") || url.href !== value)
    fail3();
  return value;
}
function filename(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 1024 || /[\u0000-\u001f\u007f]/u.test(input))
    fail3();
  return input;
}
function selection(input, requiresConfirmation) {
  const fields2 = [
    "reference",
    "operationId",
    "operationRevision",
    "resultIndex",
    "filename",
    "url",
    "selectedAt"
  ];
  const value = creativeControlRecord(
    input,
    requiresConfirmation ? [...fields2, "requiresConfirmation"] : fields2
  );
  const parsed = {
    reference: parseConceptGenerationLocator(value.reference),
    operationId: operationId(value.operationId),
    operationRevision: creativeControlRevision(value.operationRevision),
    resultIndex: resultIndex(value.resultIndex),
    filename: filename(value.filename),
    url: imageUrl(value.url),
    selectedAt: creativeControlTimestamp(value.selectedAt)
  };
  if (!requiresConfirmation) return Object.freeze(parsed);
  if (typeof value.requiresConfirmation !== "boolean") fail3();
  return Object.freeze({
    ...parsed,
    requiresConfirmation: value.requiresConfirmation
  });
}
function assertLocator(value, expected) {
  if (value.projectId !== expected.projectId || value.assetId !== expected.assetId)
    fail3();
}
function parseConceptSelectionLocator(input) {
  const value = creativeControlRecord(copy(input), ["projectId", "assetId"]);
  return Object.freeze({
    projectId: creativeControlId(value.projectId),
    assetId: creativeControlId(value.assetId)
  });
}
function parseSelectConceptImageRequest(input) {
  const value = creativeControlRecord(copy(input), [
    "reference",
    "operationId",
    "expectedOperationRevision",
    "resultIndex",
    "expectedSelectionRevision"
  ]);
  const expectedSelectionRevision = creativeControlRevision(
    value.expectedSelectionRevision,
    0
  );
  if (expectedSelectionRevision === Number.MAX_SAFE_INTEGER) fail3();
  return Object.freeze({
    reference: parseProjectGenerationUiReference(value.reference),
    operationId: operationId(value.operationId),
    expectedOperationRevision: creativeControlRevision(
      value.expectedOperationRevision
    ),
    resultIndex: resultIndex(value.resultIndex),
    expectedSelectionRevision
  });
}
function parseGetConceptSelectionResponse(input, expected) {
  const locator = expected === void 0 ? void 0 : parseConceptSelectionLocator(expected);
  const value = creativeControlRecord(copy(input), [
    "selectionRevision",
    "current"
  ]);
  const selectionRevision = creativeControlRevision(value.selectionRevision, 0);
  if (value.current === null) {
    if (selectionRevision !== 0) fail3();
    return Object.freeze({ selectionRevision, current: null });
  }
  if (selectionRevision === 0) fail3();
  const current = selection(value.current, true);
  if (locator) assertLocator(current.reference, locator);
  return Object.freeze({ selectionRevision, current });
}
function parseSelectConceptImageResponse(input, expected) {
  const request = expected === void 0 ? void 0 : parseSelectConceptImageRequest(expected);
  const value = creativeControlRecord(copy(input), [
    "disposition",
    "selectionRevision",
    "selection"
  ]);
  if (value.disposition !== "committed" && value.disposition !== "replayed")
    fail3();
  const selectionRevision = creativeControlRevision(value.selectionRevision);
  const selected = selection(value.selection, false);
  if (request) {
    assertLocator(selected.reference, request.reference);
    if (selected.reference.assetRevision !== request.reference.assetRevision || selected.operationId !== request.operationId || selected.operationRevision !== request.expectedOperationRevision || selected.resultIndex !== request.resultIndex || selectionRevision !== request.expectedSelectionRevision + 1)
      fail3();
  }
  return Object.freeze({
    disposition: value.disposition,
    selectionRevision,
    selection: selected
  });
}

// packages/contracts/src/project-generation-selection-ui-action-contract.ts
var PROJECT_GENERATION_SELECTION_UI_ACTIONS = Object.freeze([
  "crewon.project-generation-selections.v1.getConceptSelection",
  "crewon.project-generation-selections.v1.selectConceptImage"
]);
function parseProjectGenerationSelectionUiActionRequest(input) {
  const envelope = pluginUiFields(input, ["action", "input"]);
  const detached = parsePluginUiJsonValue(envelope.input, {
    maxBytes: MAX_PROJECT_GENERATION_SELECTION_BYTES
  });
  if (envelope.action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[0])
    return Object.freeze({
      action: envelope.action,
      input: parseConceptSelectionLocator(detached)
    });
  if (envelope.action !== PROJECT_GENERATION_SELECTION_UI_ACTIONS[1])
    pluginUiFailure("project_generation_selection_ui_action_invalid");
  const value = pluginUiFields(detached, [
    "reference",
    "operationId",
    "expectedOperationRevision",
    "resultIndex",
    "expectedSelectionRevision",
    "idempotencyKey"
  ]);
  const { idempotencyKey, ...body } = value;
  return Object.freeze({
    action: envelope.action,
    input: Object.freeze({
      ...parseSelectConceptImageRequest(body),
      idempotencyKey: parseCreativeProjectIdempotencyKey(idempotencyKey)
    })
  });
}
function parseProjectGenerationSelectionUiActionResponse(request, output) {
  const checked2 = parseProjectGenerationSelectionUiActionRequest(request);
  if (checked2.action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[0])
    return parseGetConceptSelectionResponse(output, checked2.input);
  const { idempotencyKey: _key, ...body } = checked2.input;
  return parseSelectConceptImageResponse(output, body);
}

// packages/contracts/src/plugin-ui-recovery-contract.ts
var MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES = 60 * 1024;
var SELECTION_REFUSAL_CODES = Object.freeze([
  "creative_project_revision_conflict",
  "creative_project_asset_revision_conflict",
  "concept_selection_operation_revision_conflict",
  "concept_selection_revision_conflict"
]);
function invalid() {
  return pluginUiFailure("plugin_ui_recovery_invalid");
}
function revision(value, minimum = 1) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    invalid();
  return value;
}
function parsePluginUiRecoveryRequest(input) {
  const value = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
    ["action", "input"]
  );
  switch (value.action) {
    case PROJECT_MEDIA_GENERATE_UI_ACTION:
      return parseProjectMediaGenerationUiRequest(value);
    case PROJECT_GENERATION_UI_ACTIONS[0]:
      return parseProjectGenerationUiActionRequest(value);
    case PROJECT_GENERATION_QUERY_UI_ACTIONS[0]:
      return parseProjectGenerationQueryUiActionRequest(value);
    case PROJECT_GENERATION_SELECTION_UI_ACTIONS[1]: {
      const parsed = parseProjectGenerationSelectionUiActionRequest(value);
      if (parsed.action !== PROJECT_GENERATION_SELECTION_UI_ACTIONS[1])
        invalid();
      return parsed;
    }
    default:
      return invalid();
  }
}
function sourcePin(input) {
  const value = pluginUiFields(input, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "selectionRevision",
    "contributionId"
  ]);
  return Object.freeze({
    pluginId: parsePluginControlPluginId(value.pluginId),
    publisherId: parsePluginControlPluginId(value.publisherId),
    version: pluginControlVersion(value.version),
    packageDigest: parsePluginControlPackageDigest(value.packageDigest),
    selectionRevision: revision(value.selectionRevision),
    contributionId: parsePluginControlPluginId(value.contributionId)
  });
}
function pairedReceipt(request, input) {
  switch (request.action) {
    case PROJECT_MEDIA_GENERATE_UI_ACTION:
      return parseGenerateProjectMediaResponse(request.input, input);
    case PROJECT_GENERATION_UI_ACTIONS[0]:
      return parseProjectGenerationUiActionResponse(request, input);
    case PROJECT_GENERATION_QUERY_UI_ACTIONS[0]:
      return parseProjectGenerationQueryUiActionResponse(request, input);
    case PROJECT_GENERATION_SELECTION_UI_ACTIONS[1]:
      return parseProjectGenerationSelectionUiActionResponse(
        request,
        input
      );
  }
}
function parsePluginUiRecoveryHint(input) {
  const value = pluginUiFields(
    parsePluginUiJsonValue(input, {
      maxBytes: MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES
    }),
    [
      "sourcePin",
      "request",
      "revision",
      "phase",
      "dispatchMayHaveOccurred",
      "dispatchAttemptCount",
      "receipt",
      "retryable",
      "reasonCode"
    ]
  );
  const request = parsePluginUiRecoveryRequest(value.request);
  const count = revision(value.dispatchAttemptCount, 0);
  const checkedRevision = revision(value.revision);
  if (typeof value.retryable !== "boolean" || value.dispatchMayHaveOccurred !== count > 0 || value.phase !== "prepared" && value.phase !== "dispatched" && value.phase !== "accepted" && value.phase !== "refused" || checkedRevision < count + 1 || value.phase === "prepared" && (count !== 0 || checkedRevision !== 1) || (value.phase === "dispatched" || value.phase === "accepted") && count === 0 || value.phase === "refused" && (count !== 1 || !(request.action === PROJECT_MEDIA_GENERATE_UI_ACTION ? value.reasonCode === "project_media_generation_not_admitted" : request.action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[1] && SELECTION_REFUSAL_CODES.includes(value.reasonCode))) || (value.phase === "accepted" || value.phase === "refused") && value.retryable || value.phase === "accepted" !== (value.receipt !== null) || value.reasonCode !== null && (typeof value.reasonCode !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(value.reasonCode)) || value.phase === "accepted" && value.reasonCode !== null || value.phase === "refused" && value.reasonCode === null)
    invalid();
  return Object.freeze({
    sourcePin: sourcePin(value.sourcePin),
    request,
    revision: checkedRevision,
    phase: value.phase,
    dispatchMayHaveOccurred: value.dispatchMayHaveOccurred,
    dispatchAttemptCount: count,
    receipt: value.receipt === null ? null : pairedReceipt(request, value.receipt),
    retryable: value.retryable,
    reasonCode: value.reasonCode
  });
}

// packages/contracts/src/project-media-generation-recovery.ts
function parseProjectMediaGenerationRecoveryResponse(input) {
  const value = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 4096 }),
    ["intent"]
  );
  if (value.intent === null) return Object.freeze({ intent: null });
  const intent = parsePluginUiRecoveryHint(value.intent);
  if (intent.request.action !== PROJECT_MEDIA_GENERATE_UI_ACTION)
    throw new ContractValidationError(
      "project_media_generation_recovery_invalid"
    );
  return Object.freeze({
    intent
  });
}

// media-generation-codec-entry.ts
var mediaGenerationCodec = Object.freeze({ parseGenerateProjectMediaRequest, parseGenerateProjectMediaResponse, parseProjectMediaGenerationRecoveryResponse });
export {
  mediaGenerationCodec
};
