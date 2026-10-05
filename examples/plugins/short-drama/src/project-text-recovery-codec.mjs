// packages/contracts/src/plugin-project-text-recovery-service.ts
var CREWON_PROJECT_TEXT_RECOVERY_SERVICE = "crewon.project-text-recovery";
var CREWON_PROJECT_TEXT_RECOVERY_API_VERSION = "1";
var MAX_PROJECT_TEXT_RECOVERY_INPUT_BYTES = 24 * 1024;
var MAX_PROJECT_TEXT_RECOVERY_RESPONSE_BYTES = 60 * 1024;
var PROJECT_TEXT_RECOVERY_METHOD_ACTIONS = Object.freeze({
  getPending: "crewon.project-text-recovery.v1.getPending",
  acknowledge: "crewon.project-text-recovery.v1.acknowledge"
});
var PROJECT_TEXT_RECOVERY_ACTIONS = Object.freeze(
  Object.values(PROJECT_TEXT_RECOVERY_METHOD_ACTIONS)
);
function isProjectTextRecoveryAction(input) {
  return typeof input === "string" && PROJECT_TEXT_RECOVERY_ACTIONS.some((action) => action === input);
}
function isProjectTextRecoveryNamespaceAction(input) {
  return typeof input === "string" && (input === CREWON_PROJECT_TEXT_RECOVERY_SERVICE || input.startsWith(`${CREWON_PROJECT_TEXT_RECOVERY_SERVICE}.`));
}
var PROJECT_TEXT_RECOVERY_REFUSAL_CODES = Object.freeze([
  "project_text_revision_conflict",
  "project_text_locked",
  "project_text_dependencies_stale",
  "creative_project_archived"
]);
function createPluginProjectTextRecoveryClient(services, codec) {
  const invoke = method(services, "invoke").bind(
    services
  );
  const parseRequest = method(codec, "parseRequest").bind(
    codec
  );
  const parseResponse = method(codec, "parseResponse").bind(
    codec
  );
  return Object.freeze(
    Object.fromEntries(
      Object.entries(PROJECT_TEXT_RECOVERY_METHOD_ACTIONS).map(
        ([name, action]) => [
          name,
          async (input, options = {}) => {
            if (options === null || typeof options !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options)))
              invalid();
            const fields = Object.getOwnPropertyDescriptors(options);
            if (Reflect.ownKeys(options).some((key) => key !== "signal") || fields.signal !== void 0 && (!Object.hasOwn(fields.signal, "value") || !fields.signal.enumerable))
              invalid();
            const signal = fields.signal?.value;
            if (signal !== void 0 && !(signal instanceof AbortSignal))
              invalid();
            if (signal?.aborted)
              throw new DOMException("The operation was aborted", "AbortError");
            const request = parseRequest({ action, input });
            const response = await invoke(
              request.action,
              request.input,
              signal === void 0 ? {} : { signal }
            );
            if (signal?.aborted)
              throw new DOMException("The operation was aborted", "AbortError");
            return parseResponse(request, response);
          }
        ]
      )
    )
  );
}
function method(input, key) {
  if (input === null || typeof input !== "object") invalid();
  for (let owner = input, depth = 0; owner !== null && depth < 16; owner = Object.getPrototypeOf(owner), depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor === void 0) continue;
    if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function")
      invalid();
    return descriptor.value;
  }
  return invalid();
}
function invalid() {
  throw new Error("plugin_project_text_recovery_client_invalid");
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
function creativeControlTitle(input) {
  const value = creativeControlText(input, 320);
  if (value.trim() !== value || [...value].length > 160)
    creativeControlFailure();
  return value;
}
function creativeControlCompareIds(left, right) {
  const a = [...left], b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

// packages/contracts/src/creative-project-control-contract.ts
function parseCreativeProjectIdempotencyKey(input) {
  const value = creativeControlText(input, 128);
  if (value !== value.trim() || /[,\u0000-\u001f\u007f]/u.test(value))
    creativeControlFailure();
  return value;
}

// packages/contracts/src/project-text-control-types.ts
var MAX_PROJECT_TEXT_RESPONSE_BYTES = 60 * 1024;

// packages/contracts/src/project-text-control-support.ts
function projectTextControlFailure() {
  throw new ContractValidationError("project_text_control_contract_invalid");
}
function projectTextControlCopy(input) {
  try {
    return parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_TEXT_RESPONSE_BYTES
    });
  } catch {
    return projectTextControlFailure();
  }
}
function projectTextControlRecord(input, fields) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    projectTextControlFailure();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key)))
    projectTextControlFailure();
  return Object.fromEntries(
    fields.map((field) => {
      const property = Object.getOwnPropertyDescriptor(input, field);
      if (!property?.enumerable || !("value" in property))
        projectTextControlFailure();
      return [field, property.value];
    })
  );
}
function projectTextControlNumber(input, minimum = 1) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum)
    projectTextControlFailure();
  return input;
}
function projectTextControlText(input, maximumBytes, allowEmpty = false) {
  if (typeof input !== "string" || !allowEmpty && !input.trim() || input.length > maximumBytes || new TextEncoder().encode(input).byteLength > maximumBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input))
    projectTextControlFailure();
  for (const point of input)
    if (point.codePointAt(0) >= 55296 && point.codePointAt(0) <= 57343)
      projectTextControlFailure();
  return input;
}
function projectTextControlTitle(input) {
  try {
    return creativeControlTitle(input);
  } catch {
    return projectTextControlFailure();
  }
}
function projectTextControlId(input) {
  const value = projectTextControlText(input, 512);
  if (value.length > 128 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value) || value === "." || value === "..")
    projectTextControlFailure();
  return value;
}
function projectTextControlDigest(input) {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    projectTextControlFailure();
  return input;
}
function projectTextControlTimestamp(input) {
  if (typeof input !== "string" || input.length !== 24 || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input)
    projectTextControlFailure();
  return input;
}
function projectTextControlArray(input, minimum, maximum) {
  if (!Array.isArray(input) || input.length < minimum || input.length > maximum)
    projectTextControlFailure();
  return input;
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
function bounded(value, maximum) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum)
    projectTextControlFailure();
  return value;
}
function unique(values) {
  if (new Set(values).size !== values.length) projectTextControlFailure();
}
function parseProjectTextOutlineContent(input) {
  const value = projectTextControlRecord(projectTextControlCopy(input), [
    "title",
    "logline",
    "synopsis",
    "episodes"
  ]);
  const episodes = projectTextControlArray(value.episodes, 1, 16).map((raw) => {
    const item = projectTextControlRecord(raw, ["episodeId", "title", "summary"]);
    return Object.freeze({
      episodeId: projectTextControlId(item.episodeId),
      title: projectTextControlTitle(item.title),
      summary: projectTextControlText(item.summary, 8192)
    });
  });
  unique(episodes.map((item) => item.episodeId));
  return bounded(
    Object.freeze({
      title: projectTextControlTitle(value.title),
      logline: projectTextControlText(value.logline, 2048),
      synopsis: projectTextControlText(value.synopsis, 8192),
      episodes: Object.freeze(episodes)
    }),
    MAX_PROJECT_TEXT_OUTLINE_CONTENT_BYTES
  );
}
function parseProjectTextScriptContent(input) {
  const value = projectTextControlRecord(projectTextControlCopy(input), ["title", "scenes"]);
  const scenes = projectTextControlArray(value.scenes, 1, 32).map((raw) => {
    const item = projectTextControlRecord(raw, [
      "sceneId",
      "location",
      "timeOfDay",
      "action",
      "dialogue"
    ]);
    const dialogue = projectTextControlArray(item.dialogue, 0, 64).map((rawLine) => {
      const line = projectTextControlRecord(rawLine, ["speaker", "text"]);
      return Object.freeze({
        speaker: projectTextControlText(line.speaker, 640),
        text: projectTextControlText(line.text, 8192)
      });
    });
    const action = projectTextControlText(item.action, 8192, true);
    if (!action.trim() && dialogue.length === 0) projectTextControlFailure();
    return Object.freeze({
      sceneId: projectTextControlId(item.sceneId),
      location: projectTextControlText(item.location, 640),
      timeOfDay: projectTextControlText(item.timeOfDay, 320),
      action,
      dialogue: Object.freeze(dialogue)
    });
  });
  unique(scenes.map((item) => item.sceneId));
  return bounded(
    Object.freeze({ title: projectTextControlTitle(value.title), scenes: Object.freeze(scenes) }),
    MAX_PROJECT_TEXT_SCRIPT_CONTENT_BYTES
  );
}
function parseSaveProjectOutlineCandidateRequest(input) {
  const value = projectTextControlRecord(projectTextControlCopy(input), [
    "expectedArtifactRevision",
    "briefRevision",
    "content"
  ]);
  return Object.freeze({
    expectedArtifactRevision: projectTextControlNumber(value.expectedArtifactRevision, 0),
    briefRevision: projectTextControlNumber(value.briefRevision),
    content: parseProjectTextOutlineContent(value.content)
  });
}
function parseSaveProjectScriptCandidateRequest(input) {
  const value = projectTextControlRecord(projectTextControlCopy(input), [
    "expectedArtifactRevision",
    "briefRevision",
    "outline",
    "content"
  ]);
  const outline = value.outline === null ? null : projectTextControlRecord(value.outline, ["artifactId", "contentRevision"]);
  return Object.freeze({
    expectedArtifactRevision: projectTextControlNumber(value.expectedArtifactRevision, 0),
    briefRevision: projectTextControlNumber(value.briefRevision),
    outline: outline === null ? null : Object.freeze({
      artifactId: projectTextControlId(outline.artifactId),
      contentRevision: projectTextControlNumber(outline.contentRevision)
    }),
    content: parseProjectTextScriptContent(value.content)
  });
}
function parseSelectProjectTextRevisionRequest(input) {
  const value = projectTextControlRecord(projectTextControlCopy(input), [
    "expectedArtifactRevision",
    "contentRevision"
  ]);
  return Object.freeze({
    expectedArtifactRevision: projectTextControlNumber(value.expectedArtifactRevision),
    contentRevision: projectTextControlNumber(value.contentRevision)
  });
}
function parseSetProjectTextArtifactLockedRequest(input) {
  const value = projectTextControlRecord(projectTextControlCopy(input), ["expectedArtifactRevision", "locked"]);
  if (typeof value.locked !== "boolean") projectTextControlFailure();
  return Object.freeze({
    expectedArtifactRevision: projectTextControlNumber(value.expectedArtifactRevision),
    locked: value.locked
  });
}

// packages/contracts/src/project-text-control-response.ts
function parsePublicProjectTextArtifact(input) {
  const value = projectTextControlRecord(projectTextControlCopy(input), [
    "projectId",
    "artifactId",
    "kind",
    "episodeId",
    "revision",
    "latestContentRevision",
    "selectedContentRevision",
    "locked",
    "createdAt",
    "updatedAt"
  ]);
  if (value.kind !== "outline" && value.kind !== "script" || typeof value.locked !== "boolean" || value.kind === "outline" && value.episodeId !== null)
    projectTextControlFailure();
  const revision = projectTextControlNumber(value.revision), latest = projectTextControlNumber(value.latestContentRevision), selected = value.selectedContentRevision === null ? null : projectTextControlNumber(value.selectedContentRevision), createdAt = projectTextControlTimestamp(value.createdAt), updatedAt = projectTextControlTimestamp(value.updatedAt);
  if (latest > revision || selected !== null && selected > latest || value.locked && selected === null || updatedAt < createdAt)
    projectTextControlFailure();
  const common = {
    projectId: projectTextControlId(value.projectId),
    artifactId: projectTextControlId(value.artifactId),
    revision,
    latestContentRevision: latest,
    selectedContentRevision: selected,
    locked: value.locked,
    createdAt,
    updatedAt
  };
  return value.kind === "outline" ? Object.freeze({ ...common, kind: "outline", episodeId: null }) : Object.freeze({
    ...common,
    kind: "script",
    episodeId: projectTextControlId(value.episodeId)
  });
}
function parsePublicProjectTextRevision(input) {
  const value = projectTextControlRecord(projectTextControlCopy(input), [
    "projectId",
    "artifactId",
    "kind",
    "episodeId",
    "contentRevision",
    "brief",
    "outline",
    "content",
    "contentDigest",
    "createdAt"
  ]), brief = projectTextControlRecord(value.brief, ["briefRevision", "contentDigest"]);
  const common = {
    projectId: projectTextControlId(value.projectId),
    artifactId: projectTextControlId(value.artifactId),
    contentRevision: projectTextControlNumber(value.contentRevision),
    brief: Object.freeze({
      briefRevision: projectTextControlNumber(brief.briefRevision),
      contentDigest: projectTextControlDigest(brief.contentDigest)
    }),
    contentDigest: projectTextControlDigest(value.contentDigest),
    createdAt: projectTextControlTimestamp(value.createdAt)
  };
  if (value.kind === "outline") {
    if (value.episodeId !== null || value.outline !== null) projectTextControlFailure();
    return Object.freeze({
      ...common,
      kind: "outline",
      episodeId: null,
      outline: null,
      content: parseProjectTextOutlineContent(value.content)
    });
  }
  if (value.kind !== "script") projectTextControlFailure();
  const outline = value.outline === null ? null : projectTextControlRecord(value.outline, [
    "artifactId",
    "contentRevision",
    "contentDigest"
  ]);
  return Object.freeze({
    ...common,
    kind: "script",
    episodeId: projectTextControlId(value.episodeId),
    outline: outline === null ? null : Object.freeze({
      artifactId: projectTextControlId(outline.artifactId),
      contentRevision: projectTextControlNumber(outline.contentRevision),
      contentDigest: projectTextControlDigest(outline.contentDigest)
    }),
    content: parseProjectTextScriptContent(value.content)
  });
}
function assertArtifact(value, expected) {
  if (value.projectId !== expected.projectId || expected.artifactId !== void 0 && value.artifactId !== expected.artifactId || expected.kind !== void 0 && value.kind !== expected.kind || expected.episodeId !== void 0 && value.episodeId !== expected.episodeId)
    projectTextControlFailure();
}
function assertRevision(value, artifact) {
  if (value.projectId !== artifact.projectId || value.artifactId !== artifact.artifactId || value.kind !== artifact.kind || value.episodeId !== artifact.episodeId || value.contentRevision > artifact.latestContentRevision)
    projectTextControlFailure();
}
function parsePublicProjectTextArtifactView(input) {
  const value = projectTextControlRecord(projectTextControlCopy(input), [
    "artifact",
    "selectedRevision",
    "dependencyState",
    "staleReasons"
  ]), artifact = parsePublicProjectTextArtifact(value.artifact), selected = value.selectedRevision === null ? null : parsePublicProjectTextRevision(value.selectedRevision);
  const reasons = projectTextControlArray(value.staleReasons, 0, 2).map((reason) => {
    if (reason !== "brief-changed" && reason !== "outline-selection-changed")
      projectTextControlFailure();
    return reason;
  });
  if (new Set(reasons).size !== reasons.length) projectTextControlFailure();
  if (selected === null) {
    if (artifact.selectedContentRevision !== null || value.dependencyState !== "unselected" || reasons.length !== 0)
      projectTextControlFailure();
  } else {
    assertRevision(selected, artifact);
    if (artifact.selectedContentRevision !== selected.contentRevision || !["current", "stale"].includes(String(value.dependencyState)) || (value.dependencyState === "current" ? reasons.length !== 0 : reasons.length === 0) || artifact.kind === "outline" && reasons.includes("outline-selection-changed"))
      projectTextControlFailure();
  }
  return Object.freeze({
    artifact,
    selectedRevision: selected,
    dependencyState: value.dependencyState,
    staleReasons: Object.freeze(reasons)
  });
}
function parseGetProjectTextArtifactResponse(input, expected) {
  const value = projectTextControlRecord(projectTextControlCopy(input), ["view"]), view = value.view === null ? null : parsePublicProjectTextArtifactView(value.view);
  if (view !== null) assertArtifact(view.artifact, expected);
  return Object.freeze({ view });
}
function parseGetProjectTextRevisionResponse(input, expected) {
  const value = projectTextControlRecord(projectTextControlCopy(input), ["contentRevision"]), contentRevision = parsePublicProjectTextRevision(value.contentRevision);
  if (contentRevision.projectId !== expected.projectId || contentRevision.artifactId !== expected.artifactId || contentRevision.contentRevision !== expected.contentRevision)
    projectTextControlFailure();
  return Object.freeze({ contentRevision });
}
function parseProjectTextArtifactListResponse(input, expected) {
  const value = projectTextControlRecord(projectTextControlCopy(input), ["artifacts", "nextArtifactId"]), artifacts = projectTextControlArray(value.artifacts, 0, expected.limit).map(
    parsePublicProjectTextArtifact
  );
  let previous = expected.afterArtifactId;
  for (const artifact of artifacts) {
    assertArtifact(artifact, expected);
    if (previous !== null && creativeControlCompareIds(previous, artifact.artifactId) >= 0)
      projectTextControlFailure();
    previous = artifact.artifactId;
  }
  const next = value.nextArtifactId === null ? null : projectTextControlId(value.nextArtifactId);
  if (next !== null && (artifacts.length === 0 || next !== artifacts[artifacts.length - 1].artifactId))
    projectTextControlFailure();
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    nextArtifactId: next
  });
}
function parseProjectTextRevisionListResponse(input, expected) {
  const value = projectTextControlRecord(projectTextControlCopy(input), ["revisions", "nextContentRevision"]), revisions = projectTextControlArray(value.revisions, 0, expected.limit).map(
    parsePublicProjectTextRevision
  );
  let previous = expected.afterContentRevision;
  for (const entry of revisions) {
    if (entry.projectId !== expected.projectId || entry.artifactId !== expected.artifactId || entry.contentRevision <= previous)
      projectTextControlFailure();
    previous = entry.contentRevision;
  }
  const next = value.nextContentRevision === null ? null : projectTextControlNumber(value.nextContentRevision);
  if (next !== null && (revisions.length === 0 || next !== previous)) projectTextControlFailure();
  return Object.freeze({
    revisions: Object.freeze(revisions),
    nextContentRevision: next
  });
}
function parseProjectTextMutationResponse(input, expected) {
  const value = projectTextControlRecord(projectTextControlCopy(input), [
    "kind",
    "disposition",
    "artifact",
    "contentRevision"
  ]);
  if (value.kind !== expected.kind || value.disposition !== "committed" && value.disposition !== "replayed")
    projectTextControlFailure();
  const artifact = parsePublicProjectTextArtifact(value.artifact), content = value.contentRevision === null ? null : parsePublicProjectTextRevision(value.contentRevision);
  assertArtifact(artifact, {
    projectId: expected.projectId,
    ...expected.kind === "select-revision" || expected.kind === "set-lock" ? { artifactId: expected.artifactId } : {}
  });
  if (artifact.revision !== expected.request.expectedArtifactRevision + 1)
    projectTextControlFailure();
  if (expected.kind === "set-lock") {
    if (content !== null || artifact.locked !== expected.request.locked) projectTextControlFailure();
  } else {
    if (content === null) projectTextControlFailure();
    assertRevision(content, artifact);
    if (expected.kind === "select-revision") {
      if (artifact.selectedContentRevision !== expected.request.contentRevision || content.contentRevision !== expected.request.contentRevision)
        projectTextControlFailure();
    } else {
      if (artifact.kind !== (expected.kind === "save-outline" ? "outline" : "script") || expected.kind === "save-script" && artifact.episodeId !== expected.episodeId || content.contentRevision !== artifact.latestContentRevision || content.brief.briefRevision !== expected.request.briefRevision || JSON.stringify(content.content) !== JSON.stringify(expected.request.content))
        projectTextControlFailure();
      if (expected.kind === "save-script" && (content.kind !== "script" || (expected.request.outline === null ? content.outline !== null : content.outline === null || content.outline.artifactId !== expected.request.outline.artifactId || content.outline.contentRevision !== expected.request.outline.contentRevision)))
        projectTextControlFailure();
    }
  }
  return Object.freeze({
    kind: expected.kind,
    disposition: value.disposition,
    artifact,
    contentRevision: content
  });
}

// packages/contracts/src/plugin-project-texts-ui-service.ts
var MAX_PROJECT_TEXT_UI_INPUT_BYTES = 60 * 1024;
var MAX_PROJECT_TEXT_UI_RESPONSE_BYTES = 60 * 1024;
var PROJECT_TEXT_UI_METHOD_ACTIONS = Object.freeze({
  getOutline: "crewon.project-texts.v1.getOutline",
  getScript: "crewon.project-texts.v1.getScript",
  getArtifact: "crewon.project-texts.v1.getArtifact",
  getRevision: "crewon.project-texts.v1.getRevision",
  listArtifacts: "crewon.project-texts.v1.listArtifacts",
  listRevisions: "crewon.project-texts.v1.listRevisions",
  saveOutlineCandidate: "crewon.project-texts.v1.saveOutlineCandidate",
  saveScriptCandidate: "crewon.project-texts.v1.saveScriptCandidate",
  selectRevision: "crewon.project-texts.v1.selectRevision",
  setLocked: "crewon.project-texts.v1.setLocked"
});
var PROJECT_TEXT_UI_ACTIONS = Object.freeze(
  Object.values(PROJECT_TEXT_UI_METHOD_ACTIONS)
);
var PROJECT_TEXT_UI_MUTATION_ACTIONS = Object.freeze([
  PROJECT_TEXT_UI_METHOD_ACTIONS.saveOutlineCandidate,
  PROJECT_TEXT_UI_METHOD_ACTIONS.saveScriptCandidate,
  PROJECT_TEXT_UI_METHOD_ACTIONS.selectRevision,
  PROJECT_TEXT_UI_METHOD_ACTIONS.setLocked
]);
function isProjectTextUiAction(action) {
  return typeof action === "string" && PROJECT_TEXT_UI_ACTIONS.some((value) => value === action);
}
function isProjectTextUiMutationAction(action) {
  return typeof action === "string" && PROJECT_TEXT_UI_MUTATION_ACTIONS.some((value) => value === action);
}

// packages/contracts/src/plugin-project-texts-ui-contract.ts
var PluginProjectTextUiContractError = class extends ContractValidationError {
  constructor() {
    super("plugin_project_text_ui_invalid");
    this.name = "PluginProjectTextUiContractError";
  }
};
function checked(run) {
  try {
    return run();
  } catch {
    throw new PluginProjectTextUiContractError();
  }
}
function integer(input, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > maximum)
    throw new PluginProjectTextUiContractError();
  return input;
}
function parseProjectTextUiActionRequest(input) {
  return checked(() => {
    const value = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_TEXT_UI_INPUT_BYTES
      }),
      ["action", "input"]
    );
    const action = value.action;
    if (!isProjectTextUiAction(action))
      throw new PluginProjectTextUiContractError();
    const fields = ["projectId"];
    switch (action) {
      case "crewon.project-texts.v1.getScript":
        fields.push("episodeId");
        break;
      case "crewon.project-texts.v1.getArtifact":
        fields.push("artifactId");
        break;
      case "crewon.project-texts.v1.getRevision":
        fields.push("artifactId", "contentRevision");
        break;
      case "crewon.project-texts.v1.listArtifacts":
        fields.push("afterArtifactId", "limit");
        break;
      case "crewon.project-texts.v1.listRevisions":
        fields.push("artifactId", "afterContentRevision", "limit");
        break;
      case "crewon.project-texts.v1.saveOutlineCandidate":
        fields.push("request", "idempotencyKey");
        break;
      case "crewon.project-texts.v1.saveScriptCandidate":
        fields.push("episodeId", "request", "idempotencyKey");
        break;
      case "crewon.project-texts.v1.selectRevision":
      case "crewon.project-texts.v1.setLocked":
        fields.push("artifactId", "request", "idempotencyKey");
        break;
      case "crewon.project-texts.v1.getOutline":
        break;
    }
    const body = pluginUiFields(value.input, fields);
    const common = { projectId: parseProjectTextId(body.projectId) };
    const artifact = () => ({
      ...common,
      artifactId: parseProjectTextId(body.artifactId)
    });
    const key = () => parseProjectTextIdempotencyKey(body.idempotencyKey);
    switch (action) {
      case "crewon.project-texts.v1.getOutline":
        return Object.freeze({ action, input: Object.freeze(common) });
      case "crewon.project-texts.v1.getScript":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...common,
            episodeId: parseProjectTextId(body.episodeId)
          })
        });
      case "crewon.project-texts.v1.getArtifact":
        return Object.freeze({ action, input: Object.freeze(artifact()) });
      case "crewon.project-texts.v1.getRevision":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...artifact(),
            contentRevision: integer(body.contentRevision)
          })
        });
      case "crewon.project-texts.v1.listArtifacts":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...common,
            afterArtifactId: body.afterArtifactId === null ? null : parseProjectTextId(body.afterArtifactId),
            limit: integer(body.limit, 1, 16)
          })
        });
      case "crewon.project-texts.v1.listRevisions":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...artifact(),
            afterContentRevision: integer(body.afterContentRevision, 0),
            limit: integer(body.limit, 1, 16)
          })
        });
      case "crewon.project-texts.v1.saveOutlineCandidate":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...common,
            request: parseSaveProjectOutlineCandidateRequest(body.request),
            idempotencyKey: key()
          })
        });
      case "crewon.project-texts.v1.saveScriptCandidate":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...common,
            episodeId: parseProjectTextId(body.episodeId),
            request: parseSaveProjectScriptCandidateRequest(body.request),
            idempotencyKey: key()
          })
        });
      case "crewon.project-texts.v1.selectRevision":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...artifact(),
            request: parseSelectProjectTextRevisionRequest(body.request),
            idempotencyKey: key()
          })
        });
      case "crewon.project-texts.v1.setLocked":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...artifact(),
            request: parseSetProjectTextArtifactLockedRequest(body.request),
            idempotencyKey: key()
          })
        });
    }
  });
}
function parseProjectTextUiActionResponse(requestInput, input) {
  return checked(() => {
    const request = parseProjectTextUiActionRequest(requestInput);
    const value = parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_TEXT_UI_RESPONSE_BYTES
    });
    const parsed = (() => {
      switch (request.action) {
        case "crewon.project-texts.v1.getOutline":
          return parseGetProjectTextArtifactResponse(value, {
            ...request.input,
            kind: "outline",
            episodeId: null
          });
        case "crewon.project-texts.v1.getScript":
          return parseGetProjectTextArtifactResponse(value, {
            ...request.input,
            kind: "script"
          });
        case "crewon.project-texts.v1.getArtifact":
          return parseGetProjectTextArtifactResponse(value, request.input);
        case "crewon.project-texts.v1.getRevision":
          return parseGetProjectTextRevisionResponse(value, request.input);
        case "crewon.project-texts.v1.listArtifacts":
          return parseProjectTextArtifactListResponse(value, request.input);
        case "crewon.project-texts.v1.listRevisions":
          return parseProjectTextRevisionListResponse(value, request.input);
        case "crewon.project-texts.v1.saveOutlineCandidate":
          return parseProjectTextMutationResponse(value, {
            ...request.input,
            kind: "save-outline"
          });
        case "crewon.project-texts.v1.saveScriptCandidate":
          return parseProjectTextMutationResponse(value, {
            ...request.input,
            kind: "save-script"
          });
        case "crewon.project-texts.v1.selectRevision":
          return parseProjectTextMutationResponse(value, {
            ...request.input,
            kind: "select-revision"
          });
        case "crewon.project-texts.v1.setLocked":
          return parseProjectTextMutationResponse(value, {
            ...request.input,
            kind: "set-lock"
          });
      }
    })();
    return parsed;
  });
}
var projectTextsUiCodec = Object.freeze({
  parseRequest: parseProjectTextUiActionRequest,
  parseResponse: parseProjectTextUiActionResponse
});

// packages/contracts/src/plugin-project-text-recovery-contract.ts
var PluginProjectTextRecoveryContractError = class extends ContractValidationError {
  constructor() {
    super("plugin_project_text_recovery_invalid");
    this.name = "PluginProjectTextRecoveryContractError";
  }
};
function checked2(run) {
  try {
    return run();
  } catch {
    throw new PluginProjectTextRecoveryContractError();
  }
}
function integer2(input) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    throw new PluginProjectTextRecoveryContractError();
  return input;
}
function digest(input) {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input))
    throw new PluginProjectTextRecoveryContractError();
  return input;
}
function parseProjectTextRecoveryActionRequest(input) {
  return checked2(() => {
    const value = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_TEXT_RECOVERY_INPUT_BYTES
      }),
      ["action", "input"]
    );
    if (!isProjectTextRecoveryAction(value.action))
      throw new PluginProjectTextRecoveryContractError();
    if (value.action === "crewon.project-text-recovery.v1.getPending") {
      const body2 = pluginUiFields(value.input, ["projectId"]);
      return Object.freeze({
        action: value.action,
        input: Object.freeze({ projectId: parseProjectTextId(body2.projectId) })
      });
    }
    const body = pluginUiFields(value.input, [
      "projectId",
      "intentId",
      "expectedRevision"
    ]);
    return Object.freeze({
      action: value.action,
      input: Object.freeze({
        projectId: parseProjectTextId(body.projectId),
        intentId: parseProjectTextId(body.intentId),
        expectedRevision: integer2(body.expectedRevision)
      })
    });
  });
}
var kinds = Object.freeze({
  "crewon.project-texts.v1.saveOutlineCandidate": "save-outline",
  "crewon.project-texts.v1.saveScriptCandidate": "save-script",
  "crewon.project-texts.v1.selectRevision": "select-revision",
  "crewon.project-texts.v1.setLocked": "set-lock"
});
function parseProjectTextRecoveryActionResponse(requestInput, input) {
  return checked2(() => {
    const request = parseProjectTextRecoveryActionRequest(requestInput);
    const output = parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_TEXT_RECOVERY_RESPONSE_BYTES
    });
    if (request.action === "crewon.project-text-recovery.v1.acknowledge") {
      const value2 = pluginUiFields(output, [
        "intentId",
        "revision",
        "disposition"
      ]);
      const intentId = parseProjectTextId(value2.intentId), revision = integer2(value2.revision);
      if (intentId !== request.input.intentId || revision !== request.input.expectedRevision + 1 || value2.disposition !== "acknowledged" && value2.disposition !== "replayed")
        throw new PluginProjectTextRecoveryContractError();
      return Object.freeze({
        intentId,
        revision,
        disposition: value2.disposition
      });
    }
    const value = pluginUiFields(output, ["intent"]);
    if (value.intent === null) return Object.freeze({ intent: null });
    const fields = pluginUiFields(value.intent, [
      "intentId",
      "revision",
      "phase",
      "request",
      "requestDigest",
      "confirmed",
      "refusalCode"
    ]);
    const original = parseProjectTextUiActionRequest(fields.request);
    if (!isProjectTextUiMutationAction(original.action) || original.input.projectId !== request.input.projectId)
      throw new PluginProjectTextRecoveryContractError();
    const common = {
      intentId: parseProjectTextId(fields.intentId),
      revision: integer2(fields.revision),
      request: original,
      requestDigest: digest(fields.requestDigest)
    };
    let intent;
    if (fields.phase === "pending") {
      if (fields.confirmed !== null || fields.refusalCode !== null)
        throw new PluginProjectTextRecoveryContractError();
      intent = Object.freeze({
        ...common,
        phase: "pending",
        confirmed: null,
        refusalCode: null
      });
    } else if (fields.phase === "accepted") {
      if (fields.refusalCode !== null)
        throw new PluginProjectTextRecoveryContractError();
      const receipt = pluginUiFields(fields.confirmed, [
        "kind",
        "artifactId",
        "artifactRevision",
        "contentRevision",
        "requestDigest",
        "resultDigest"
      ]);
      const contentRevision = receipt.contentRevision === null ? null : integer2(receipt.contentRevision);
      const artifactId = parseProjectTextId(receipt.artifactId);
      if (receipt.kind !== kinds[original.action] || receipt.requestDigest !== common.requestDigest || (original.action === "crewon.project-texts.v1.setLocked" ? contentRevision !== null : contentRevision === null) || "artifactId" in original.input && original.input.artifactId !== artifactId || original.action === "crewon.project-texts.v1.selectRevision" && contentRevision !== original.input.request.contentRevision)
        throw new PluginProjectTextRecoveryContractError();
      const confirmed = Object.freeze({
        kind: kinds[original.action],
        artifactId,
        artifactRevision: integer2(receipt.artifactRevision),
        contentRevision,
        requestDigest: digest(receipt.requestDigest),
        resultDigest: digest(receipt.resultDigest)
      });
      intent = Object.freeze({
        ...common,
        phase: "accepted",
        confirmed,
        refusalCode: null
      });
    } else if (fields.phase === "refused") {
      if (fields.confirmed !== null || !PROJECT_TEXT_RECOVERY_REFUSAL_CODES.includes(
        fields.refusalCode
      ))
        throw new PluginProjectTextRecoveryContractError();
      intent = Object.freeze({
        ...common,
        phase: "refused",
        confirmed: null,
        refusalCode: fields.refusalCode
      });
    } else throw new PluginProjectTextRecoveryContractError();
    return Object.freeze({ intent });
  });
}
var projectTextRecoveryCodec = Object.freeze(
  {
    parseRequest: parseProjectTextRecoveryActionRequest,
    parseResponse: parseProjectTextRecoveryActionResponse
  }
);
export {
  CREWON_PROJECT_TEXT_RECOVERY_API_VERSION,
  CREWON_PROJECT_TEXT_RECOVERY_SERVICE,
  MAX_PROJECT_TEXT_RECOVERY_INPUT_BYTES,
  MAX_PROJECT_TEXT_RECOVERY_RESPONSE_BYTES,
  PROJECT_TEXT_RECOVERY_ACTIONS,
  PROJECT_TEXT_RECOVERY_METHOD_ACTIONS,
  PROJECT_TEXT_RECOVERY_REFUSAL_CODES,
  PluginProjectTextRecoveryContractError,
  createPluginProjectTextRecoveryClient,
  isProjectTextRecoveryAction,
  isProjectTextRecoveryNamespaceAction,
  parseProjectTextRecoveryActionRequest,
  parseProjectTextRecoveryActionResponse,
  projectTextRecoveryCodec
};
