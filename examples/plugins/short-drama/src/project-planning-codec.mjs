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

// packages/contracts/src/project-planning-service.ts
var PROJECT_PLANNING_PROPOSAL_VERSION = "crewon.project-planning-proposal.v1";
var PROJECT_PLANNING_MAX_BYTES = 8192;
var PROJECT_PLANNING_TOOL_NAMES = Object.freeze({
  capabilities: "crewon_project_capabilities",
  propose: "crewon_project_propose"
});

// packages/contracts/src/project-planning-contract.ts
function invalid() {
  return pluginUiFailure("project_planning_data_invalid");
}
function text(input, limit, multiline = false) {
  if (typeof input !== "string" || !input.trim() || new TextEncoder().encode(input).byteLength > limit || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(input))
    invalid();
  return input;
}
function digest(input) {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    invalid();
  return input;
}
function fields(input, keys) {
  return pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: PROJECT_PLANNING_MAX_BYTES }),
    keys
  );
}
function parseProjectPlanningCapability(input) {
  const v = fields(input, [
    "capabilityId",
    "source",
    "title",
    "kind",
    "stages",
    "maximumEpisodes",
    "moduleAvailable",
    "textPlansAvailable",
    "executionReady"
  ]);
  const source = pluginUiFields(v.source, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "contributionId"
  ]);
  if (v.kind !== "short-drama" || v.maximumEpisodes !== 16 || !Array.isArray(v.stages) || JSON.stringify(v.stages) !== '["brief","outline","script"]' || [v.moduleAvailable, v.textPlansAvailable, v.executionReady].some(
    (x) => typeof x !== "boolean"
  ))
    invalid();
  if (v.executionReady === true && (v.moduleAvailable !== true || v.textPlansAvailable !== true))
    invalid();
  return Object.freeze({
    capabilityId: digest(v.capabilityId),
    source: Object.freeze({
      pluginId: parsePluginControlPluginId(source.pluginId),
      publisherId: parsePluginControlPluginId(source.publisherId),
      version: pluginControlVersion(source.version),
      packageDigest: parsePluginControlPackageDigest(source.packageDigest),
      contributionId: parsePluginControlPluginId(source.contributionId)
    }),
    title: text(v.title, 256),
    kind: "short-drama",
    stages: Object.freeze(["brief", "outline", "script"]),
    maximumEpisodes: 16,
    moduleAvailable: v.moduleAvailable,
    textPlansAvailable: v.textPlansAvailable,
    executionReady: v.executionReady
  });
}
function parseProjectPlanningProposalInput(input) {
  const v = fields(input, [
    "capabilityId",
    "title",
    "briefText",
    "instruction",
    "start",
    "target",
    "episodeCount",
    "adoption"
  ]);
  if (v.start !== "brief" && v.start !== "outline" || !["brief", "outline", "script"].includes(v.target) || v.adoption !== "manual" && v.adoption !== "whenUnchanged" || v.start === "outline" && v.target === "brief")
    invalid();
  if (v.target === "brief" ? v.episodeCount !== null : typeof v.episodeCount !== "number" || !Number.isSafeInteger(v.episodeCount) || v.episodeCount < 1 || v.episodeCount > 16)
    invalid();
  return Object.freeze({
    capabilityId: digest(v.capabilityId),
    title: text(v.title, 128),
    briefText: text(v.briefText, 4096, true),
    instruction: text(v.instruction, 2048, true),
    start: v.start,
    target: v.target,
    episodeCount: v.episodeCount,
    adoption: v.adoption
  });
}
function parseProjectPlanningProposal(input) {
  const v = fields(input, [
    "schemaVersion",
    "kind",
    "capability",
    "origin",
    "input"
  ]);
  if (v.schemaVersion !== PROJECT_PLANNING_PROPOSAL_VERSION || v.kind !== "newProject")
    invalid();
  const capability = parseProjectPlanningCapability(v.capability), proposal = parseProjectPlanningProposalInput(v.input), origin = pluginUiFields(v.origin, ["runId", "threadId", "callId"]);
  if (capability.capabilityId !== proposal.capabilityId) invalid();
  return Object.freeze({
    schemaVersion: PROJECT_PLANNING_PROPOSAL_VERSION,
    kind: "newProject",
    capability,
    origin: Object.freeze({
      runId: text(origin.runId, 256),
      threadId: text(origin.threadId, 256),
      callId: text(origin.callId, 256)
    }),
    input: proposal
  });
}
export {
  parseProjectPlanningProposal
};
