// packages/contracts/src/plugin-project-context-service.ts
var CREWON_PROJECT_CONTEXT_SERVICE = "crewon.project-context";
var CREWON_PROJECT_CONTEXT_API_VERSION = "1";
var MAX_PROJECT_CONTEXT_RESPONSE_BYTES = 8192;

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

// packages/contracts/src/creative-project-control-support.ts
function creativeControlFailure() {
  throw new ContractValidationError(
    "creative_project_control_contract_invalid"
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

// packages/contracts/src/creative-project-control-contract.ts
function parseCreativeProjectIdempotencyKey(input) {
  const value = creativeControlText(input, 128);
  if (value !== value.trim() || /[,\u0000-\u001f\u007f]/u.test(value))
    creativeControlFailure();
  return value;
}

// packages/contracts/src/project-text-control-support.ts
function projectTextControlFailure() {
  throw new ContractValidationError("project_text_control_contract_invalid");
}
function projectTextControlText(input, maximumBytes, allowEmpty = false) {
  if (typeof input !== "string" || !allowEmpty && !input.trim() || input.length > maximumBytes || new TextEncoder().encode(input).byteLength > maximumBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input))
    projectTextControlFailure();
  for (const point of input)
    if (point.codePointAt(0) >= 55296 && point.codePointAt(0) <= 57343)
      projectTextControlFailure();
  return input;
}
function projectTextControlId(input) {
  const value = projectTextControlText(input, 512);
  if (value.length > 128 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value) || value === "." || value === "..")
    projectTextControlFailure();
  return value;
}

// packages/contracts/src/project-text-control-contract.ts
var MAX_PROJECT_TEXT_OUTLINE_CONTENT_BYTES = 16 * 1024;
var MAX_PROJECT_TEXT_SCRIPT_CONTENT_BYTES = 32 * 1024;
function parseProjectTextId(input) {
  return projectTextControlId(input);
}
function parseProjectTextIdempotencyKey(input) {
  try {
    return parseCreativeProjectIdempotencyKey(input);
  } catch {
    return projectTextControlFailure();
  }
}

// packages/contracts/src/plugin-project-conversations-service.ts
var MAX_PROJECT_CONVERSATIONS_BYTES = 24 * 1024;
var MAX_PROJECT_CONVERSATION_CONTENT_BYTES = 16 * 1024;
var PROJECT_CONVERSATIONS_METHOD_ACTIONS = {
  getBinding: "crewon.project-conversations.v1.getBinding",
  listConversations: "crewon.project-conversations.v1.listConversations",
  createConversation: "crewon.project-conversations.v1.createConversation",
  openConversation: "crewon.project-conversations.v1.openConversation",
  refreshSource: "crewon.project-conversations.v1.refreshSource",
  setState: "crewon.project-conversations.v1.setState",
  startStage: "crewon.project-conversations.v1.startStage"
};

// packages/contracts/src/plugin-project-conversations-contract.ts
var PluginProjectConversationsContractError = class extends Error {
  constructor() {
    super("plugin_project_conversations_invalid");
  }
};
var fail = () => {
  throw new PluginProjectConversationsContractError();
};
var integer = (v, min = 1, max = Number.MAX_SAFE_INTEGER) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
var digest = (v) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
var timestamp = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v ? v : fail();
var state = (v) => v === "active" || v === "revoked" ? v : fail();
function checked(read) {
  try {
    return read();
  } catch {
    throw new PluginProjectConversationsContractError();
  }
}
function parseProjectConversationStage(input) {
  return checked(() => {
    const v = pluginUiFields(
      parsePluginUiJsonValue(input),
      Object.keys(input)
    );
    if (v.kind === "discussion") {
      pluginUiFields(v, ["kind"]);
      return Object.freeze({ kind: "discussion" });
    }
    if (v.kind === "brief" || v.kind === "outline") {
      pluginUiFields(v, ["kind", "briefRevision"]);
      return Object.freeze({
        kind: v.kind,
        briefRevision: integer(v.briefRevision)
      });
    }
    if (v.kind !== "script") return fail();
    pluginUiFields(v, ["kind", "episodeId", "briefRevision", "outline"]);
    const o = v.outline === null ? null : pluginUiFields(v.outline, ["artifactId", "contentRevision"]);
    return Object.freeze({
      kind: "script",
      episodeId: parseProjectTextId(v.episodeId),
      briefRevision: integer(v.briefRevision),
      outline: o === null ? null : Object.freeze({
        artifactId: parseProjectTextId(o.artifactId),
        contentRevision: integer(o.contentRevision)
      })
    });
  });
}
function parseProjectConversationsActionRequest(input) {
  return checked(() => {
    const v = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_CONVERSATIONS_BYTES
      }),
      ["action", "input"]
    );
    if (!Object.values(PROJECT_CONVERSATIONS_METHOD_ACTIONS).includes(
      v.action
    ))
      fail();
    const action = v.action, method = action.slice("crewon.project-conversations.v1.".length);
    const fields = method === "getBinding" ? ["threadId"] : method === "listConversations" ? ["projectId", "afterThreadId", "limit"] : method === "createConversation" ? ["projectId", "workspaceId", "title", "idempotencyKey"] : method === "openConversation" ? ["projectId", "threadId"] : method === "refreshSource" ? [
      "projectId",
      "threadId",
      "expectedBindingRevision",
      "idempotencyKey"
    ] : method === "setState" ? [
      "projectId",
      "threadId",
      "expectedBindingRevision",
      "state",
      "idempotencyKey"
    ] : [
      "projectId",
      "threadId",
      "expectedThreadRevision",
      "expectedBindingRevision",
      "content",
      "idempotencyKey",
      "stage"
    ];
    const b = pluginUiFields(v.input, fields), out = {};
    for (const k of fields) {
      const x = b[k];
      switch (k) {
        case "limit":
          out[k] = integer(x, 1, 16);
          break;
        case "expectedThreadRevision":
        case "expectedBindingRevision":
          out[k] = integer(x);
          break;
        case "idempotencyKey":
          out[k] = parseProjectTextIdempotencyKey(x);
          break;
        case "workspaceId":
        case "afterThreadId":
          out[k] = x === null ? null : parseProjectTextId(x);
          break;
        case "title":
          if (x === null) {
            out[k] = null;
            break;
          }
          if (typeof x !== "string" || x.trim() !== x || !x.length || [...x].length > 160 || x.length > 320)
            fail();
          out[k] = x;
          break;
        case "content":
          if (typeof x !== "string" || !x.trim() || new TextEncoder().encode(x).length > MAX_PROJECT_CONVERSATION_CONTENT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(x))
            fail();
          out[k] = x;
          break;
        case "state":
          out[k] = state(x);
          break;
        case "stage":
          out[k] = parseProjectConversationStage(x);
          break;
        default:
          out[k] = parseProjectTextId(x);
      }
    }
    return Object.freeze({
      action,
      input: Object.freeze(out)
    });
  });
}
function parsePublicProjectConversationBinding(input) {
  return checked(() => {
    const v = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_CONVERSATIONS_BYTES
      }),
      [
        "bindingId",
        "projectId",
        "threadId",
        "workspaceId",
        "revision",
        "state",
        "source",
        "createdAt",
        "updatedAt"
      ]
    ), s = pluginUiFields(v.source, [
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
      "selectionRevision"
    ]);
    const namespace = (x) => typeof x === "string" && /^[a-z][a-z0-9._-]{0,127}$/u.test(x) && x.length <= 128 ? x : fail();
    if (typeof s.version !== "string" || s.version.length > 128 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      s.version
    ))
      fail();
    const createdAt = timestamp(v.createdAt), updatedAt = timestamp(v.updatedAt);
    if (Date.parse(updatedAt) < Date.parse(createdAt)) fail();
    return Object.freeze({
      bindingId: parseProjectTextId(v.bindingId),
      projectId: parseProjectTextId(v.projectId),
      threadId: parseProjectTextId(v.threadId),
      workspaceId: v.workspaceId === null ? null : parseProjectTextId(v.workspaceId),
      revision: integer(v.revision),
      state: state(v.state),
      source: Object.freeze({
        pluginId: namespace(s.pluginId),
        publisherId: namespace(s.publisherId),
        version: s.version,
        packageDigest: digest(s.packageDigest),
        selectionRevision: integer(s.selectionRevision)
      }),
      createdAt,
      updatedAt
    });
  });
}
function parseProjectConversationsActionResponse(requestInput, input) {
  return checked(() => {
    const request = parseProjectConversationsActionRequest(requestInput), v = parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_CONVERSATIONS_BYTES
    }), b = request.input;
    if (request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage) {
      const out2 = pluginUiFields(v, [
        "disposition",
        "threadId",
        "threadRevision",
        "runId",
        "runRevision",
        "bindingRevision",
        "stageAdmissionDigest"
      ]);
      if (out2.disposition !== "committed" && out2.disposition !== "replayed")
        fail();
      if (out2.threadId !== request.input.threadId || out2.bindingRevision !== request.input.expectedBindingRevision)
        fail();
      return Object.freeze({
        disposition: out2.disposition,
        threadId: parseProjectTextId(out2.threadId),
        threadRevision: out2.threadRevision === request.input.expectedThreadRevision + 1 ? integer(out2.threadRevision) : fail(),
        runId: parseProjectTextId(out2.runId),
        runRevision: integer(out2.runRevision),
        bindingRevision: integer(out2.bindingRevision),
        stageAdmissionDigest: digest(out2.stageAdmissionDigest)
      });
    }
    if (request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.listConversations) {
      const out2 = pluginUiFields(v, ["bindings", "nextThreadId"]);
      if (!Array.isArray(out2.bindings) || out2.bindings.length > request.input.limit)
        fail();
      const bindings = out2.bindings.map(
        parsePublicProjectConversationBinding
      );
      if (bindings.some((x) => x.projectId !== request.input.projectId) || new Set(bindings.map((x) => x.threadId)).size !== bindings.length || bindings.some((x, index) => {
        const previous = index === 0 ? request.input.afterThreadId : bindings[index - 1].threadId;
        return previous !== null && compareUtf8(x.threadId, previous) <= 0;
      }))
        fail();
      const nextThreadId = out2.nextThreadId === null ? null : parseProjectTextId(out2.nextThreadId);
      if (nextThreadId !== null && nextThreadId !== bindings.at(-1)?.threadId)
        fail();
      return Object.freeze({ bindings: Object.freeze(bindings), nextThreadId });
    }
    const read = request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.getBinding || request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.openConversation, out = pluginUiFields(v, read ? ["binding"] : ["disposition", "binding"]);
    if (out.binding === null) {
      if (request.action !== PROJECT_CONVERSATIONS_METHOD_ACTIONS.getBinding)
        fail();
      return Object.freeze({ binding: null });
    }
    const binding = parsePublicProjectConversationBinding(out.binding);
    if ("projectId" in b && binding.projectId !== b.projectId || "threadId" in b && binding.threadId !== b.threadId)
      fail();
    if (read) return Object.freeze({ binding });
    if (out.disposition !== "committed" && out.disposition !== "replayed")
      fail();
    if ("expectedBindingRevision" in b && binding.revision !== b.expectedBindingRevision + 1)
      fail();
    if (request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.createConversation && (binding.revision !== 1 || binding.workspaceId !== request.input.workspaceId))
      fail();
    if (request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.setState && binding.state !== request.input.state)
      fail();
    return Object.freeze({
      disposition: out.disposition,
      binding
    });
  });
}
var projectConversationsCodec = Object.freeze({
  parseRequest: parseProjectConversationsActionRequest,
  parseResponse: parseProjectConversationsActionResponse
});
function compareUtf8(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

// packages/contracts/src/plugin-project-context-contract.ts
function parseProjectContextResponse(input) {
  const v = pluginUiFields(
    parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_CONTEXT_RESPONSE_BYTES
    }),
    ["scope"]
  );
  if (v.scope === null) return Object.freeze({ scope: null });
  const s = pluginUiFields(v.scope, [
    "projectId",
    "threadId",
    "runId",
    "bindingId",
    "bindingRevision",
    "stage",
    "sources",
    "allowedOperations",
    "contentDigest"
  ]);
  const stage = parseProjectConversationStage(s.stage), sources = pluginUiFields(s.sources, ["brief", "outline"]);
  const integer2 = (x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 1 ? x : fail2();
  const digest2 = (x) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/u.test(x) ? x : fail2();
  const b = sources.brief === null ? null : pluginUiFields(sources.brief, ["briefRevision", "contentDigest"]), o = sources.outline === null ? null : pluginUiFields(sources.outline, [
    "artifactId",
    "contentRevision",
    "contentDigest"
  ]);
  const brief = b === null ? null : Object.freeze({
    briefRevision: integer2(b.briefRevision),
    contentDigest: digest2(b.contentDigest)
  }), outline = o === null ? null : Object.freeze({
    artifactId: parseProjectTextId(o.artifactId),
    contentRevision: integer2(o.contentRevision),
    contentDigest: digest2(o.contentDigest)
  });
  const operations = [
    "project_context_read",
    "project_read",
    "outline_read",
    "script_read",
    "content_read",
    "text_history",
    ...stage.kind === "discussion" ? [] : [
      stage.kind === "brief" ? "brief_append" : stage.kind === "outline" ? "outline_save" : "script_save"
    ]
  ];
  if (JSON.stringify(s.allowedOperations) !== JSON.stringify(operations) || stage.kind !== "discussion" && brief?.briefRevision !== stage.briefRevision || (stage.kind === "script" ? stage.outline === null ? outline !== null : outline === null || outline.artifactId !== stage.outline.artifactId || outline.contentRevision !== stage.outline.contentRevision : outline !== null))
    fail2();
  return Object.freeze({
    scope: Object.freeze({
      projectId: parseProjectTextId(s.projectId),
      threadId: parseProjectTextId(s.threadId),
      runId: parseProjectTextId(s.runId),
      bindingId: parseProjectTextId(s.bindingId),
      bindingRevision: integer2(s.bindingRevision),
      stage,
      sources: Object.freeze({ brief, outline }),
      allowedOperations: Object.freeze(operations),
      contentDigest: digest2(s.contentDigest)
    })
  });
}
function fail2() {
  throw new Error("plugin_project_context_invalid");
}
var projectContextCodec = Object.freeze({
  parseResponse: parseProjectContextResponse
});
export {
  CREWON_PROJECT_CONTEXT_API_VERSION,
  CREWON_PROJECT_CONTEXT_SERVICE,
  MAX_PROJECT_CONTEXT_RESPONSE_BYTES,
  parseProjectContextResponse,
  projectContextCodec
};
