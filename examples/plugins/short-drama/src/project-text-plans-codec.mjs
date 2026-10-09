// packages/contracts/src/project-stage-model-contract.ts
function parseProjectStageModelId(value) {
  if (typeof value !== "string" || !value || value.trim() !== value || new TextEncoder().encode(value).byteLength > 256 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value))
    throw new Error("project_stage_model_invalid");
  return value;
}

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

// packages/contracts/src/plugin-project-text-plans-service.ts
var MAX_PROJECT_TEXT_PLANS_INPUT_BYTES = 24 * 1024;
var MAX_PROJECT_TEXT_PLANS_VIEW_BYTES = 60 * 1024;
var MAX_PROJECT_TEXT_PLAN_INSTRUCTION_BYTES = 4096;
var PROJECT_TEXT_PLANS_METHOD_ACTIONS = Object.freeze({
  start: "crewon.project-text-plans.v1.start",
  get: "crewon.project-text-plans.v1.get",
  list: "crewon.project-text-plans.v1.list",
  pause: "crewon.project-text-plans.v1.pause",
  resume: "crewon.project-text-plans.v1.resume",
  revoke: "crewon.project-text-plans.v1.revoke",
  reviseRemaining: "crewon.project-text-plans.v1.reviseRemaining",
  continue: "crewon.project-text-plans.v1.continue"
});

// packages/contracts/src/plugin-project-text-plans-contract.ts
var PluginProjectTextPlansContractError = class extends Error {
  constructor() {
    super("plugin_project_text_plans_invalid");
  }
};
function fail() {
  throw new PluginProjectTextPlansContractError();
}
function checked(read) {
  try {
    return read();
  } catch {
    return fail();
  }
}
function integer(v, min = 1, max = Number.MAX_SAFE_INTEGER) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
}
function oneOf(v, values) {
  return typeof v === "string" && values.includes(v) ? v : fail();
}
function digest(v) {
  return typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
}
function timestamp(v) {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v ? v : fail();
}
var stages = ["brief", "outline", "script"];
var adoptionModes = ["manual", "whenUnchanged"];
function stage(v) {
  return oneOf(v, stages);
}
function instruction(v) {
  if (typeof v !== "string" || !v.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v) || new TextEncoder().encode(v).byteLength > MAX_PROJECT_TEXT_PLAN_INSTRUCTION_BYTES)
    fail();
  return v;
}
function episodeIds(v, allowEmpty = false) {
  if (!Array.isArray(v) || v.length < (allowEmpty ? 0 : 1) || v.length > 16)
    fail();
  const ids = v.map(parseProjectTextId);
  if (new Set(ids).size !== ids.length) fail();
  return Object.freeze(ids);
}
function episodes(v) {
  if (v === null) return null;
  const kind = v.kind;
  if (kind === "newOutline") {
    const r = pluginUiFields(v, ["kind", "episodeCount"]);
    return Object.freeze({
      kind,
      episodeCount: integer(r.episodeCount, 1, 16)
    });
  }
  if (kind === "selectedOutline" || kind === "independentScripts") {
    const r = pluginUiFields(v, ["kind", "episodeIds"]);
    return Object.freeze({ kind, episodeIds: episodeIds(r.episodeIds) });
  }
  return fail();
}
function assertDefinitionShape(start, target, mode) {
  if (stages.indexOf(start) > stages.indexOf(target)) fail();
  if (target === "brief" ? mode !== "none" : start === "script" ? mode !== "selectedOutline" && mode !== "independentScripts" : mode !== "newOutline")
    fail();
}
function parseProjectTextPlansActionRequest(input) {
  return checked(() => {
    const v = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_TEXT_PLANS_INPUT_BYTES
      }),
      ["action", "input"]
    );
    const action = oneOf(
      v.action,
      Object.values(PROJECT_TEXT_PLANS_METHOD_ACTIONS)
    );
    const method = action.slice("crewon.project-text-plans.v1.".length);
    const definitionFields = [
      "expectedBriefRevision",
      "instruction",
      "start",
      "target",
      "episodes",
      "adoption",
      ...v.input !== null && typeof v.input === "object" && Object.hasOwn(v.input, "modelId") ? ["modelId"] : []
    ];
    const controlFields = [
      "projectId",
      "planId",
      "expectedRevision",
      "idempotencyKey"
    ];
    const fields = method === "start" ? [
      "projectId",
      "threadId",
      "expectedBindingRevision",
      "idempotencyKey",
      ...definitionFields
    ] : method === "get" ? ["projectId", "planId"] : method === "list" ? ["projectId", "afterPlanId", "limit"] : method === "reviseRemaining" ? [...controlFields, ...definitionFields] : controlFields;
    const r = pluginUiFields(v.input, fields);
    const out = {};
    for (const key of fields) {
      switch (key) {
        case "modelId":
          out[key] = parseProjectStageModelId(r[key]);
          break;
        case "projectId":
        case "planId":
        case "threadId":
          out[key] = parseProjectTextId(r[key]);
          break;
        case "afterPlanId":
          out[key] = r[key] === null ? null : parseProjectTextId(r[key]);
          break;
        case "idempotencyKey":
          out[key] = parseProjectTextIdempotencyKey(r[key]);
          break;
        case "expectedRevision":
        case "expectedBindingRevision":
        case "expectedBriefRevision":
          out[key] = integer(r[key]);
          break;
        case "limit":
          out[key] = integer(r[key], 1, 16);
          break;
        case "instruction":
          out[key] = instruction(r[key]);
          break;
        case "start":
        case "target":
          out[key] = stage(r[key]);
          break;
        case "episodes":
          out[key] = episodes(r[key]);
          break;
        case "adoption":
          out[key] = oneOf(r[key], adoptionModes);
          break;
        default:
          fail();
      }
    }
    if (method === "start" || method === "reviseRemaining") {
      const e = out.episodes;
      assertDefinitionShape(
        out.start,
        out.target,
        e?.kind ?? "none"
      );
    }
    return Object.freeze({
      action,
      input: Object.freeze(out)
    });
  });
}
var pauseReasons = [
  "source_changed",
  "selection_changed",
  "locked",
  "binding_changed",
  "installation_changed",
  "authorization_unavailable",
  "run_failed",
  "run_canceled",
  "result_missing",
  "result_invalid",
  "user_paused"
];
function summary(input) {
  const r = pluginUiFields(input, [
    "planId",
    "projectId",
    "threadId",
    "revision",
    "currentPlanRevision",
    "state",
    "activeStepId",
    "pauseReason",
    "createdAt",
    "updatedAt"
  ]);
  const revision = integer(r.revision), currentPlanRevision = integer(r.currentPlanRevision);
  const state = oneOf(r.state, [
    "ready",
    "running",
    "waitingSelection",
    "paused",
    "completed",
    "revoked"
  ]);
  const pauseReason = r.pauseReason === null ? null : oneOf(r.pauseReason, pauseReasons);
  const createdAt = timestamp(r.createdAt), updatedAt = timestamp(r.updatedAt);
  if (currentPlanRevision > revision || Date.parse(updatedAt) < Date.parse(createdAt) || state === "paused" && pauseReason === null || state !== "paused" && pauseReason !== null || (state === "running" || state === "waitingSelection") && r.activeStepId === null || state === "completed" && r.activeStepId !== null)
    fail();
  return Object.freeze({
    planId: parseProjectTextId(r.planId),
    projectId: parseProjectTextId(r.projectId),
    threadId: parseProjectTextId(r.threadId),
    revision,
    currentPlanRevision,
    state,
    activeStepId: r.activeStepId === null ? null : parseProjectTextId(r.activeStepId),
    pauseReason,
    createdAt,
    updatedAt
  });
}
function sources(input) {
  const r = pluginUiFields(input, ["brief", "outline"]);
  const b = pluginUiFields(r.brief, ["briefRevision", "contentDigest"]);
  const o = r.outline === null ? null : pluginUiFields(r.outline, [
    "artifactId",
    "contentRevision",
    "contentDigest"
  ]);
  return Object.freeze({
    brief: Object.freeze({
      briefRevision: integer(b.briefRevision),
      contentDigest: digest(b.contentDigest)
    }),
    outline: o === null ? null : Object.freeze({
      artifactId: parseProjectTextId(o.artifactId),
      contentRevision: integer(o.contentRevision),
      contentDigest: digest(o.contentDigest)
    })
  });
}
function definition(input) {
  const r = pluginUiFields(input, [
    "planId",
    "planRevision",
    "start",
    "target",
    "episodeMode",
    "episodeIds",
    "adoption",
    "instruction",
    "sources"
  ]);
  const start = stage(r.start), target = stage(r.target);
  const episodeMode = oneOf(r.episodeMode, [
    "none",
    "newOutline",
    "selectedOutline",
    "independentScripts"
  ]);
  assertDefinitionShape(start, target, episodeMode);
  const ids = episodeIds(r.episodeIds, episodeMode === "none");
  if (episodeMode === "none" && ids.length !== 0) fail();
  const source = sources(r.sources);
  if (episodeMode === "selectedOutline" ? source.outline === null : source.outline !== null)
    fail();
  return Object.freeze({
    planId: parseProjectTextId(r.planId),
    planRevision: integer(r.planRevision),
    start,
    target,
    episodeMode,
    episodeIds: ids,
    adoption: oneOf(r.adoption, adoptionModes),
    instruction: instruction(r.instruction),
    sources: source
  });
}
function result(input) {
  const r = pluginUiFields(input, [
    "kind",
    "briefRevision",
    "artifactId",
    "artifactRevision",
    "contentRevision",
    "contentDigest"
  ]);
  const kind = stage(r.kind);
  const briefRevision = r.briefRevision === null ? null : integer(r.briefRevision);
  const artifactId = r.artifactId === null ? null : parseProjectTextId(r.artifactId);
  const artifactRevision = r.artifactRevision === null ? null : integer(r.artifactRevision);
  const contentRevision = r.contentRevision === null ? null : integer(r.contentRevision);
  if (kind === "brief" ? briefRevision === null || artifactId !== null || artifactRevision !== null || contentRevision !== null : briefRevision !== null || artifactId === null || artifactRevision === null || contentRevision === null || contentRevision > artifactRevision)
    fail();
  return Object.freeze({
    kind,
    briefRevision,
    artifactId,
    artifactRevision,
    contentRevision,
    contentDigest: digest(r.contentDigest)
  });
}
function selection(input) {
  const r = pluginUiFields(input, [
    "mode",
    "artifactId",
    "artifactRevision",
    "contentRevision",
    "contentDigest"
  ]);
  const artifactRevision = integer(r.artifactRevision), contentRevision = integer(r.contentRevision);
  if (contentRevision > artifactRevision) fail();
  return Object.freeze({
    mode: oneOf(r.mode, adoptionModes),
    artifactId: parseProjectTextId(r.artifactId),
    artifactRevision,
    contentRevision,
    contentDigest: digest(r.contentDigest)
  });
}
function step(input) {
  const r = pluginUiFields(input, [
    "stepId",
    "ordinal",
    "kind",
    "episodeId",
    "attempt",
    "revision",
    "state",
    "sources",
    "run",
    "result",
    "selection",
    "terminal"
  ]);
  const kind = stage(r.kind), episodeId = r.episodeId === null ? null : parseProjectTextId(r.episodeId);
  if (kind === "script" ? episodeId === null : episodeId !== null) fail();
  const state = oneOf(r.state, [
    "ready",
    "admitted",
    "waitingSelection",
    "succeeded",
    "paused",
    "failed",
    "revoked"
  ]);
  const sr = r.sources === null ? null : sources(r.sources);
  if (kind !== "script" && sr?.outline !== null && sr?.outline !== void 0)
    fail();
  const runValue = r.run === null ? null : pluginUiFields(r.run, ["runId", "stageAdmissionDigest"]);
  const run = runValue === null ? null : Object.freeze({
    runId: parseProjectTextId(runValue.runId),
    stageAdmissionDigest: digest(runValue.stageAdmissionDigest)
  });
  const outcome = r.result === null ? null : result(r.result);
  const selected = r.selection === null ? null : selection(r.selection);
  const t = r.terminal === null ? null : pluginUiFields(r.terminal, [
    "status",
    "runRevision",
    "throughSequence"
  ]);
  const terminal = t === null ? null : Object.freeze({
    status: oneOf(t.status, ["completed", "failed", "canceled"]),
    runRevision: integer(t.runRevision),
    throughSequence: integer(t.throughSequence)
  });
  if (run !== null && sr === null || (outcome !== null || terminal !== null || state === "admitted") && run === null || outcome !== null && outcome.kind !== kind)
    fail();
  if (selected !== null && (outcome === null || kind === "brief" || selected.artifactId !== outcome.artifactId || selected.contentRevision !== outcome.contentRevision || selected.contentDigest !== outcome.contentDigest))
    fail();
  if (state === "waitingSelection" && (kind === "brief" || terminal?.status !== "completed" || outcome === null))
    fail();
  if (state === "succeeded" && (terminal?.status !== "completed" || outcome === null || kind !== "brief" && selected === null))
    fail();
  return Object.freeze({
    stepId: parseProjectTextId(r.stepId),
    ordinal: integer(r.ordinal, 1, 18),
    kind,
    episodeId,
    attempt: integer(r.attempt),
    revision: integer(r.revision),
    state,
    sources: sr,
    run,
    result: outcome,
    selection: selected,
    terminal
  });
}
function view(input) {
  const r = pluginUiFields(input, ["plan", "definition", "steps"]);
  const plan = summary(r.plan), d = definition(r.definition);
  if (plan.planId !== d.planId || plan.currentPlanRevision !== d.planRevision || !Array.isArray(r.steps) || r.steps.length < 1 || r.steps.length > 18)
    fail();
  const steps = r.steps.map(step);
  if (new Set(steps.map((s) => s.stepId)).size !== steps.length || steps.some((s, i) => i > 0 && s.ordinal <= steps[i - 1].ordinal) || steps.filter((s) => s.state === "admitted").length > 1 || plan.activeStepId !== null && !steps.some((s) => s.stepId === plan.activeStepId))
    fail();
  for (const s of steps) {
    if (stages.indexOf(s.kind) < stages.indexOf(d.start) || stages.indexOf(s.kind) > stages.indexOf(d.target) || s.kind === "script" && !d.episodeIds.includes(s.episodeId))
      fail();
    if (s.kind === "script" && s.sources !== null && (d.episodeMode === "independentScripts" ? s.sources.outline !== null : s.sources.outline === null))
      fail();
    if (s.selection !== null && s.selection.mode !== d.adoption) fail();
  }
  if (plan.state === "completed" && steps.some((s) => s.state !== "succeeded"))
    fail();
  return Object.freeze({ plan, definition: d, steps: Object.freeze(steps) });
}
function compareIds(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
function parseProjectTextPlansActionResponse(requestInput, input) {
  return checked(() => {
    const request = parseProjectTextPlansActionRequest(requestInput);
    const method = request.action.slice("crewon.project-text-plans.v1.".length);
    const value = parsePluginUiJsonValue(input, {
      maxBytes: method === "list" ? MAX_PROJECT_TEXT_PLANS_INPUT_BYTES : MAX_PROJECT_TEXT_PLANS_VIEW_BYTES
    });
    if (request.action === PROJECT_TEXT_PLANS_METHOD_ACTIONS.list) {
      const r2 = pluginUiFields(value, ["plans", "nextPlanId"]);
      if (!Array.isArray(r2.plans) || r2.plans.length > request.input.limit)
        fail();
      const plans = r2.plans.map(summary);
      if (plans.some(
        (p, i) => p.projectId !== request.input.projectId || i > 0 && compareIds(plans[i - 1].planId, p.planId) >= 0 || request.input.afterPlanId !== null && compareIds(request.input.afterPlanId, p.planId) >= 0
      ))
        fail();
      const nextPlanId = r2.nextPlanId === null ? null : parseProjectTextId(r2.nextPlanId);
      if (nextPlanId !== null && (plans.length === 0 || nextPlanId !== plans.at(-1).planId))
        fail();
      return Object.freeze({ plans: Object.freeze(plans), nextPlanId });
    }
    if (request.action === PROJECT_TEXT_PLANS_METHOD_ACTIONS.get) {
      const r2 = pluginUiFields(value, ["view"]);
      const found2 = r2.view === null ? null : view(r2.view);
      if (found2 !== null && (found2.plan.projectId !== request.input.projectId || found2.plan.planId !== request.input.planId))
        fail();
      return Object.freeze({ view: found2 });
    }
    const r = pluginUiFields(value, ["disposition", "view"]);
    const disposition = oneOf(r.disposition, [
      "committed",
      "replayed"
    ]), found = view(r.view);
    if (found.plan.projectId !== request.input.projectId) fail();
    if (request.action === PROJECT_TEXT_PLANS_METHOD_ACTIONS.start) {
      const d = found.definition, e = request.input.episodes;
      if (found.plan.threadId !== request.input.threadId || d.start !== request.input.start || d.target !== request.input.target || d.adoption !== request.input.adoption || d.instruction !== request.input.instruction || d.sources.brief.briefRevision !== request.input.expectedBriefRevision || d.episodeMode !== (e?.kind ?? "none"))
        fail();
      if (e?.kind === "newOutline" ? d.episodeIds.length !== e.episodeCount : e !== null && d.episodeIds.join("\0") !== e.episodeIds.join("\0"))
        fail();
    } else {
      if (found.plan.planId !== request.input.planId || found.plan.revision !== request.input.expectedRevision + 1)
        fail();
      if (request.action === PROJECT_TEXT_PLANS_METHOD_ACTIONS.reviseRemaining) {
        const d = found.definition, e = request.input.episodes;
        if (d.start !== request.input.start || d.target !== request.input.target || d.adoption !== request.input.adoption || d.instruction !== request.input.instruction || d.sources.brief.briefRevision !== request.input.expectedBriefRevision || d.episodeMode !== (e?.kind ?? "none"))
          fail();
        if (e?.kind === "newOutline" ? d.episodeIds.length !== e.episodeCount : e !== null && d.episodeIds.join("\0") !== e.episodeIds.join("\0"))
          fail();
      }
    }
    return Object.freeze({ disposition, view: found });
  });
}
var projectTextPlansCodec = Object.freeze({
  parseRequest: parseProjectTextPlansActionRequest,
  parseResponse: parseProjectTextPlansActionResponse
});
export {
  PluginProjectTextPlansContractError,
  parseProjectTextPlansActionRequest,
  parseProjectTextPlansActionResponse,
  projectTextPlansCodec
};
