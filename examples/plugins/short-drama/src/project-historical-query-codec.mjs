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
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key)))
    pluginUiFailure("plugin_ui_fields_invalid");
  return Object.freeze(
    Object.fromEntries(fields.map((field) => [field, dataValue(input, field)]))
  );
}
function dataValue(input, name) {
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (!descriptor?.enumerable || !("value" in descriptor))
    pluginUiFailure("plugin_ui_data_property_required");
  return descriptor.value;
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
function creativeControlRecord(input, fields) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    creativeControlFailure();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key)))
    creativeControlFailure();
  return Object.fromEntries(
    fields.map((field) => {
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
function positiveRevision(input) {
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
  const expectedThreadRevision = positiveRevision(value.expectedThreadRevision);
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
  const checked = parseProjectGenerationQueryUiActionRequest(request);
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
  const threadRevision = positiveRevision(value.threadRevision);
  const configurationRevision = positiveRevision(value.configurationRevision);
  if (threadId !== checked.input.threadId || threadRevision !== checked.input.expectedThreadRevision + 1 || configurationRevision > 2147483647)
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

// packages/contracts/src/plugin-project-historical-queries-service.ts
var PROJECT_HISTORICAL_QUERY_UI_ACTIONS = Object.freeze([
  "crewon.project-historical-queries.v1.queryConceptGeneration"
]);
var PROJECT_HISTORICAL_QUERY_HOST_CONTEXT_VERSION = "crewon.project-historical-query-host-context.v1";

// packages/contracts/src/project-historical-query-ui-action-contract.ts
function parseProjectHistoricalQueryUiActionRequest(input) {
  const v = pluginUiFields(input, ["action", "input"]);
  if (v.action !== PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0])
    pluginUiFailure("project_historical_query_ui_action_invalid");
  const checked = parseProjectGenerationQueryUiActionRequest({
    action: PROJECT_GENERATION_QUERY_UI_ACTIONS[0],
    input: v.input
  });
  return Object.freeze({
    action: PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0],
    input: checked.input
  });
}
function parseProjectHistoricalQueryUiActionResponse(request, output) {
  const checked = parseProjectHistoricalQueryUiActionRequest(request);
  return parseProjectGenerationQueryUiActionResponse(
    { action: PROJECT_GENERATION_QUERY_UI_ACTIONS[0], input: checked.input },
    output
  );
}

// packages/contracts/src/project-historical-query-host-context-contract.ts
function parseProjectHistoricalQueryHostContext(input) {
  const fields = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
    ["version", "recovery", "phase", "thread", "threadReady", "intent"]
  );
  if (fields.version !== PROJECT_HISTORICAL_QUERY_HOST_CONTEXT_VERSION || fields.recovery !== "session-only" || !["idle", "loading", "ready", "uncertain", "error"].includes(
    fields.phase
  ) || typeof fields.threadReady !== "boolean")
    pluginUiFailure("project_historical_query_host_context_invalid");
  let thread = null;
  if (fields.thread !== null) {
    const value = pluginUiFields(fields.thread, [
      "threadId",
      "revision",
      "provisional"
    ]);
    if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision >= Number.MAX_SAFE_INTEGER || typeof value.provisional !== "boolean")
      pluginUiFailure("project_historical_query_host_context_invalid");
    thread = Object.freeze({
      threadId: parseExtensionIdempotencyKey(value.threadId),
      revision: value.revision,
      provisional: value.provisional
    });
  }
  let intent = null;
  if (fields.intent !== null) {
    const value = pluginUiFields(fields.intent, [
      "request",
      "phase",
      "retryable",
      "receipt"
    ]);
    if (!["pending", "uncertain", "accepted", "refused"].includes(
      value.phase
    ) || typeof value.retryable !== "boolean" || value.phase === "accepted" !== (value.receipt !== null) || value.phase !== "uncertain" && value.retryable)
      pluginUiFailure("project_historical_query_host_context_invalid");
    const captured = parseProjectHistoricalQueryUiActionRequest({
      action: "crewon.project-historical-queries.v1.queryConceptGeneration",
      input: value.request
    });
    intent = Object.freeze({
      request: captured.input,
      phase: value.phase,
      retryable: value.retryable,
      receipt: value.receipt === null ? null : parseProjectHistoricalQueryUiActionResponse(
        captured,
        value.receipt
      )
    });
  }
  if (fields.threadReady && (fields.phase !== "ready" || thread === null || intent?.phase === "pending" || intent?.phase === "uncertain"))
    pluginUiFailure("project_historical_query_host_context_invalid");
  return Object.freeze({
    version: PROJECT_HISTORICAL_QUERY_HOST_CONTEXT_VERSION,
    recovery: "session-only",
    phase: fields.phase,
    thread,
    threadReady: fields.threadReady,
    intent
  });
}

// <stdin>
var projectHistoricalQueryCodec = Object.freeze({ parseRequest: parseProjectHistoricalQueryUiActionRequest, parseResponse: parseProjectHistoricalQueryUiActionResponse });
export {
  parseProjectHistoricalQueryHostContext,
  projectHistoricalQueryCodec
};
