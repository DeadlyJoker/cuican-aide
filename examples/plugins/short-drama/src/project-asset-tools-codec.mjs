// packages/contracts/src/plugin-project-asset-tools-service.ts
var MAX_PROJECT_ASSET_TOOL_RESPONSE_BYTES = 8192;
var MAX_PROJECT_ASSET_TOOL_PAGE_SIZE = 4;
var PROJECT_ASSET_TOOL_OPERATIONS = Object.freeze({
  listAssets: "asset_list",
  getAsset: "asset_read",
  listRevisions: "asset_history",
  readContent: "asset_content_read",
  saveCandidate: "asset_save"
});

// packages/contracts/src/project-asset-tools-contract.ts
function parseProjectAssetToolRequest(method, input) {
  const raw = copy(input, 24576);
  let result;
  switch (method) {
    case "listAssets": {
      const v = fields(raw, ["projectId", "kind", "afterAssetId", "limit"]);
      result = {
        projectId: id(v.projectId),
        kind: kind(v.kind),
        afterAssetId: v.afterAssetId === null ? null : id(v.afterAssetId),
        limit: integer(v.limit, 1, 4)
      };
      break;
    }
    case "getAsset": {
      const v = fields(raw, ["projectId", "assetId"]);
      result = { projectId: id(v.projectId), assetId: id(v.assetId) };
      break;
    }
    case "listRevisions": {
      const v = fields(raw, [
        "projectId",
        "assetId",
        "afterContentRevision",
        "limit"
      ]);
      result = {
        projectId: id(v.projectId),
        assetId: id(v.assetId),
        afterContentRevision: integer(v.afterContentRevision, 0),
        limit: integer(v.limit, 1, 4)
      };
      break;
    }
    case "readContent": {
      const v = fields(raw, [
        "projectId",
        "assetId",
        "contentRevision",
        "offset"
      ]);
      result = {
        projectId: id(v.projectId),
        assetId: id(v.assetId),
        contentRevision: integer(v.contentRevision, 1),
        offset: integer(v.offset, 0)
      };
      break;
    }
    case "saveCandidate": {
      const v = fields(raw, [
        "projectId",
        "assetId",
        "kind",
        "expectedAssetRevision",
        "briefRevision",
        "script",
        "content"
      ]);
      const c = fields(v.content, ["name", "setting", "visualPrompt"]), s = v.script === null ? null : fields(v.script, ["artifactId", "contentRevision"]);
      const content = {
        name: text(c.name, 640, true),
        setting: text(c.setting, 6144, true),
        visualPrompt: text(c.visualPrompt, 2e3, true)
      };
      if (Array.from(content.name).length > 160 || content.name.length > 320 || content.name.trim() !== content.name || content.visualPrompt.length > 2e3 || bytes(content) > 8192)
        fail();
      const assetId = v.assetId === null ? null : id(v.assetId), expectedAssetRevision = integer(v.expectedAssetRevision, 0);
      if (assetId === null !== (expectedAssetRevision === 0)) fail();
      result = {
        projectId: id(v.projectId),
        assetId,
        kind: kind(v.kind),
        expectedAssetRevision,
        briefRevision: integer(v.briefRevision, 1),
        script: s === null ? null : {
          artifactId: id(s.artifactId),
          contentRevision: integer(s.contentRevision, 1)
        },
        content
      };
      break;
    }
    default:
      fail();
  }
  return freeze(result);
}
function parseProjectAssetToolResponse(method, request, input) {
  const r = parseProjectAssetToolRequest(method, request), raw = copy(input, MAX_PROJECT_ASSET_TOOL_RESPONSE_BYTES);
  let result;
  switch (method) {
    case "listAssets": {
      const q = r, v = fields(raw, ["assets", "nextAssetId"]);
      if (!Array.isArray(v.assets) || v.assets.length > Math.min(q.limit, MAX_PROJECT_ASSET_TOOL_PAGE_SIZE))
        fail();
      const assets = v.assets.map((x) => head(x, q.projectId));
      if (assets.some((x) => x.kind !== q.kind) || new Set(assets.map((x) => x.assetId)).size !== assets.length || assets.some(
        (x, i) => x.assetId <= (i === 0 ? q.afterAssetId ?? "" : assets[i - 1].assetId)
      ))
        fail();
      const nextAssetId = v.nextAssetId === null ? null : id(v.nextAssetId);
      if (nextAssetId !== null && (assets.length === 0 || nextAssetId !== assets.at(-1).assetId))
        fail();
      result = { assets, nextAssetId };
      break;
    }
    case "getAsset": {
      const q = r, v = fields(raw, ["view"]);
      if (v.view === null) {
        result = { view: null };
        break;
      }
      const w = fields(v.view, [
        "asset",
        "selectedRevision",
        "dependencyState",
        "staleReasons",
        "referenceState"
      ]), asset = head(w.asset, q.projectId, q.assetId);
      const selectedRevision = w.selectedRevision === null ? null : revision(w.selectedRevision, q.projectId, q.assetId);
      if (selectedRevision !== null && (selectedRevision.kind !== asset.kind || selectedRevision.contentRevision !== asset.selectedContentRevision))
        fail();
      if (asset.selectedContentRevision === null !== (selectedRevision === null))
        fail();
      const dependencyState = state(w.dependencyState), referenceState = state(w.referenceState);
      if (selectedRevision === null !== (dependencyState === "unselected") || asset.selectedReferenceRevision === null !== (referenceState === "unselected"))
        fail();
      if (!Array.isArray(w.staleReasons) || w.staleReasons.length > 3 || new Set(w.staleReasons).size !== w.staleReasons.length || w.staleReasons.some(
        (x) => x !== "brief-changed" && x !== "script-selection-changed" && x !== "script-source-stale"
      ) || dependencyState === "stale" !== w.staleReasons.length > 0)
        fail();
      result = {
        view: {
          asset,
          selectedRevision,
          dependencyState,
          staleReasons: w.staleReasons,
          referenceState
        }
      };
      break;
    }
    case "listRevisions": {
      const q = r, v = fields(raw, ["revisions", "nextContentRevision"]);
      if (!Array.isArray(v.revisions) || v.revisions.length > q.limit) fail();
      const revisions = v.revisions.map(
        (x) => revision(x, q.projectId, q.assetId)
      );
      if (revisions.some(
        (x, i) => x.contentRevision <= (i === 0 ? q.afterContentRevision : revisions[i - 1].contentRevision)
      ))
        fail();
      const nextContentRevision = v.nextContentRevision === null ? null : integer(v.nextContentRevision, 1);
      if (nextContentRevision !== null && (revisions.length === 0 || nextContentRevision !== revisions.at(-1).contentRevision))
        fail();
      result = { revisions, nextContentRevision };
      break;
    }
    case "readContent": {
      const q = r, v = fields(raw, [
        "contentDigest",
        "format",
        "offset",
        "nextOffset",
        "totalCodePoints",
        "text"
      ]);
      if (v.format !== "canonical-json") fail();
      const offset = integer(v.offset, 0), totalCodePoints = integer(v.totalCodePoints, 1), chunk = text(v.text, 6144, false), count = Array.from(chunk).length, nextOffset = v.nextOffset === null ? null : integer(v.nextOffset, 1);
      if (offset !== q.offset || offset > totalCodePoints || count > 1024 || offset + count > totalCodePoints || (nextOffset === null ? offset + count !== totalCodePoints : nextOffset !== offset + count || nextOffset >= totalCodePoints || count !== 1024))
        fail();
      result = {
        contentDigest: digest(v.contentDigest),
        format: "canonical-json",
        offset,
        nextOffset,
        totalCodePoints,
        text: chunk
      };
      break;
    }
    case "saveCandidate": {
      const q = r, v = fields(raw, ["kind", "disposition", "asset", "contentRevision"]);
      if (v.kind !== "save-content" || v.disposition !== "committed" && v.disposition !== "replayed")
        fail();
      const asset = head(v.asset, q.projectId, q.assetId ?? void 0), c = revision(v.contentRevision, q.projectId, asset.assetId);
      if (asset.kind !== q.kind || c.kind !== q.kind || asset.revision !== q.expectedAssetRevision + 1 || asset.latestContentRevision !== c.contentRevision || c.brief.briefRevision !== q.briefRevision || (q.script === null ? c.script !== null : c.script?.artifactId !== q.script.artifactId || c.script.contentRevision !== q.script.contentRevision))
        fail();
      result = {
        kind: "save-content",
        disposition: v.disposition,
        asset,
        contentRevision: c
      };
      break;
    }
    default:
      fail();
  }
  if (bytes({ resultJson: JSON.stringify(result) }) > MAX_PROJECT_ASSET_TOOL_RESPONSE_BYTES)
    fail();
  return freeze(result);
}
var PROJECT_ASSET_RUNTIME_OPERATIONS = Object.freeze([
  "asset_context_read",
  "asset_list",
  "asset_read",
  "asset_history",
  "asset_content_read",
  "project_read",
  "outline_read",
  "script_read",
  "content_read",
  "text_history",
  "asset_save"
]);
function parseProjectAssetContextResponse(input) {
  const v = fields(copy(input, MAX_PROJECT_ASSET_TOOL_RESPONSE_BYTES), [
    "scope"
  ]);
  if (v.scope === null) return Object.freeze({ scope: null });
  const s = fields(v.scope, [
    "version",
    "runId",
    "threadId",
    "projectId",
    "bindingId",
    "bindingRevision",
    "workspaceId",
    "stage",
    "sources",
    "allowedOperations",
    "admissionDigest"
  ]), stage = fields(s.stage, ["kind", "assetKind", "briefRevision", "script"]), sources = fields(s.sources, ["brief", "script"]), brief = fields(sources.brief, ["briefRevision", "contentDigest"]);
  if (s.version !== "crewon.project-asset-runtime-scope.v1" || stage.kind !== "assets" || JSON.stringify(s.allowedOperations) !== JSON.stringify(PROJECT_ASSET_RUNTIME_OPERATIONS))
    fail();
  const parseScript = (x, withDigest) => {
    if (x === null) return null;
    const v2 = fields(x, [
      "artifactId",
      "episodeId",
      "contentRevision",
      ...withDigest ? ["contentDigest"] : []
    ]);
    return {
      artifactId: id(v2.artifactId),
      episodeId: id(v2.episodeId),
      contentRevision: integer(v2.contentRevision, 1),
      ...withDigest ? { contentDigest: digest(v2.contentDigest) } : {}
    };
  };
  const sourceScript = parseScript(sources.script, true), stageScript = parseScript(stage.script, false), briefRevision = integer(stage.briefRevision, 1);
  if (briefRevision !== integer(brief.briefRevision, 1) || JSON.stringify(stageScript) !== JSON.stringify(
    sourceScript === null ? null : {
      artifactId: sourceScript.artifactId,
      episodeId: sourceScript.episodeId,
      contentRevision: sourceScript.contentRevision
    }
  ))
    fail();
  const response = {
    scope: {
      version: "crewon.project-asset-runtime-scope.v1",
      runId: id(s.runId),
      threadId: id(s.threadId),
      projectId: id(s.projectId),
      bindingId: id(s.bindingId),
      bindingRevision: integer(s.bindingRevision, 1),
      workspaceId: s.workspaceId === null ? null : id(s.workspaceId),
      stage: {
        kind: "assets",
        assetKind: kind(stage.assetKind),
        briefRevision,
        script: stageScript
      },
      sources: {
        brief: { briefRevision, contentDigest: digest(brief.contentDigest) },
        script: sourceScript
      },
      allowedOperations: PROJECT_ASSET_RUNTIME_OPERATIONS,
      admissionDigest: digest(s.admissionDigest)
    }
  };
  if (bytes({ resultJson: JSON.stringify(response) }) > MAX_PROJECT_ASSET_TOOL_RESPONSE_BYTES)
    fail();
  return freeze(response);
}
function head(input, projectId, assetId) {
  const v = fields(input, [
    "projectId",
    "assetId",
    "kind",
    "revision",
    "latestContentRevision",
    "selectedContentRevision",
    "latestReferenceRevision",
    "selectedReferenceRevision",
    "locked",
    "createdAt",
    "updatedAt"
  ]);
  const result = {
    projectId: id(v.projectId),
    assetId: id(v.assetId),
    kind: kind(v.kind),
    revision: integer(v.revision, 1),
    latestContentRevision: integer(v.latestContentRevision, 1),
    selectedContentRevision: v.selectedContentRevision === null ? null : integer(v.selectedContentRevision, 1),
    latestReferenceRevision: integer(v.latestReferenceRevision, 0),
    selectedReferenceRevision: v.selectedReferenceRevision === null ? null : integer(v.selectedReferenceRevision, 1),
    locked: bool(v.locked),
    createdAt: timestamp(v.createdAt),
    updatedAt: timestamp(v.updatedAt)
  };
  if (result.projectId !== projectId || assetId !== void 0 && result.assetId !== assetId || (result.selectedContentRevision ?? 0) > result.latestContentRevision || (result.selectedReferenceRevision ?? 0) > result.latestReferenceRevision || result.updatedAt < result.createdAt)
    fail();
  return result;
}
function revision(input, projectId, assetId) {
  const v = fields(input, [
    "projectId",
    "assetId",
    "kind",
    "contentRevision",
    "brief",
    "script",
    "createdAt",
    "contentDigest"
  ]), b = fields(v.brief, ["briefRevision", "contentDigest"]), s = v.script === null ? null : fields(v.script, [
    "artifactId",
    "episodeId",
    "contentRevision",
    "contentDigest"
  ]);
  const result = {
    projectId: id(v.projectId),
    assetId: id(v.assetId),
    kind: kind(v.kind),
    contentRevision: integer(v.contentRevision, 1),
    brief: {
      briefRevision: integer(b.briefRevision, 1),
      contentDigest: digest(b.contentDigest)
    },
    script: s === null ? null : {
      artifactId: id(s.artifactId),
      episodeId: id(s.episodeId),
      contentRevision: integer(s.contentRevision, 1),
      contentDigest: digest(s.contentDigest)
    },
    createdAt: timestamp(v.createdAt),
    contentDigest: digest(v.contentDigest)
  };
  if (result.projectId !== projectId || result.assetId !== assetId) fail();
  return result;
}
function fields(input, keys) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== keys.length)
    fail();
  const out = /* @__PURE__ */ Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== "string" || !keys.includes(key) || !d?.enumerable || !("value" in d))
      fail();
    out[key] = d.value;
  }
  return out;
}
function copy(input, max) {
  const visit = (x, seen, depth) => {
    if (depth > 24) fail();
    if (x === null || typeof x === "boolean") return x;
    if (typeof x === "string") {
      unicode(x);
      return x;
    }
    if (typeof x === "number" && Number.isFinite(x)) return x;
    if (typeof x !== "object" || seen.has(x)) fail();
    seen.add(x);
    try {
      if (Array.isArray(x)) {
        const ds = Object.getOwnPropertyDescriptors(x);
        if (Reflect.ownKeys(x).length !== x.length + 1) fail();
        const values = [];
        for (let i = 0; i < x.length; i++) {
          const d = ds[String(i)];
          if (!d || !("value" in d) || !d.enumerable) fail();
          values.push(visit(d.value, seen, depth + 1));
        }
        return values;
      }
      const keys = Reflect.ownKeys(x);
      if (![Object.prototype, null].includes(Object.getPrototypeOf(x))) fail();
      const out = /* @__PURE__ */ Object.create(null);
      for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(x, key);
        if (typeof key !== "string" || !d?.enumerable || !("value" in d))
          fail();
        unicode(key);
        out[key] = visit(d.value, seen, depth + 1);
      }
      return out;
    } finally {
      seen.delete(x);
    }
  };
  const result = visit(input, /* @__PURE__ */ new Set(), 0);
  if (bytes(result) > max) fail();
  return result;
}
function bytes(input) {
  return new TextEncoder().encode(JSON.stringify(input)).length;
}
function text(input, max, nonempty) {
  if (typeof input !== "string" || new TextEncoder().encode(input).length > max || nonempty && input.trim().length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input))
    fail();
  unicode(input);
  return input;
}
function unicode(value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 55296 && c <= 56319) {
      const n = value.charCodeAt(++i);
      if (!(n >= 56320 && n <= 57343)) fail();
    } else if (c >= 56320 && c <= 57343) fail();
  }
}
function id(input) {
  const value = text(input, 512, true);
  if (value.length > 128 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value) || value === "." || value === "..")
    fail();
  return value;
}
function digest(input) {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    fail();
  return input;
}
function integer(input, min, max = Number.MAX_SAFE_INTEGER) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max)
    fail();
  return input;
}
function kind(input) {
  if (input !== "character" && input !== "scene" && input !== "prop") fail();
  return input;
}
function state(input) {
  if (input !== "unselected" && input !== "current" && input !== "stale")
    fail();
  return input;
}
function timestamp(input) {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input)
    fail();
  return input;
}
function bool(input) {
  if (typeof input !== "boolean") fail();
  return input;
}
function freeze(input) {
  if (input !== null && typeof input === "object") {
    for (const child of Object.values(input)) freeze(child);
    Object.freeze(input);
  }
  return input;
}
function fail() {
  throw new Error("project_asset_tool_protocol_invalid");
}
var projectAssetToolsCodec = Object.freeze({
  parseRequest: parseProjectAssetToolRequest,
  parseResponse: parseProjectAssetToolResponse,
  parseContextResponse: parseProjectAssetContextResponse
});
function parseProjectAssetToolCommand(method, input) {
  const raw = copy(input, 24576);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail();
  const v = raw;
  return parseProjectAssetToolRequest(method, {
    ...v,
    ...method === "listAssets" && !Object.hasOwn(v, "afterAssetId") ? { afterAssetId: null } : {},
    ...method === "saveCandidate" && !Object.hasOwn(v, "assetId") ? { assetId: null } : {},
    ...method === "saveCandidate" && !Object.hasOwn(v, "script") ? { script: null } : {}
  });
}
export {
  PROJECT_ASSET_RUNTIME_OPERATIONS,
  parseProjectAssetContextResponse,
  parseProjectAssetToolCommand,
  parseProjectAssetToolRequest,
  parseProjectAssetToolResponse,
  projectAssetToolsCodec
};
