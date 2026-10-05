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

// packages/contracts/src/creative-project-control-contract.ts
function parseCreativeProjectIdempotencyKey(input) {
  const value = creativeControlText(input, 128);
  if (value !== value.trim() || /[,\u0000-\u001f\u007f]/u.test(value))
    creativeControlFailure();
  return value;
}

// packages/contracts/src/project-asset-contract-support.ts
var MAX_PUBLIC_PROJECT_ASSET_CONTENT_BYTES = 8 * 1024;
function assetContractFailure() {
  throw new ContractValidationError("project_asset_contract_invalid");
}
function assetContractChecked(work) {
  try {
    return work();
  } catch {
    return assetContractFailure();
  }
}
function assetContractCopy(input, maxBytes) {
  return assetContractChecked(
    () => parsePluginUiJsonValue(input, { maxBytes })
  );
}
function assetContractRecord(input, fields) {
  return assetContractChecked(() => pluginUiFields(input, fields));
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
function assetContractDigest(input) {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    assetContractFailure();
  return input;
}
function assetContractTimestamp(input) {
  if (typeof input !== "string" || input.length !== 24 || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input)
    assetContractFailure();
  return input;
}
function assetContractKind(input) {
  if (input !== "character" && input !== "scene" && input !== "prop")
    assetContractFailure();
  return input;
}
function parsePublicProjectAssetContent(input) {
  return assetContractChecked(() => {
    const value = assetContractRecord(
      assetContractCopy(input, MAX_PUBLIC_PROJECT_ASSET_CONTENT_BYTES),
      ["name", "setting", "visualPrompt"]
    );
    const result = Object.freeze({
      name: creativeControlTitle(value.name),
      setting: assetContractText(value.setting, 6144),
      visualPrompt: assetContractText(value.visualPrompt, 2e3)
    });
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_PUBLIC_PROJECT_ASSET_CONTENT_BYTES)
      assetContractFailure();
    return result;
  });
}

// packages/contracts/src/project-assets-service.ts
var MAX_PROJECT_ASSET_UI_INPUT_BYTES = 24 * 1024;
var MAX_PROJECT_ASSET_UI_RESPONSE_BYTES = 60 * 1024;
var PROJECT_ASSET_UI_METHOD_ACTIONS = Object.freeze({
  getAsset: "crewon.project-assets.v1.getAsset",
  getRevision: "crewon.project-assets.v1.getRevision",
  getReferenceRevision: "crewon.project-assets.v1.getReferenceRevision",
  listAssets: "crewon.project-assets.v1.listAssets",
  listRevisions: "crewon.project-assets.v1.listRevisions",
  listReferences: "crewon.project-assets.v1.listReferences",
  saveCandidate: "crewon.project-assets.v1.saveCandidate",
  selectRevision: "crewon.project-assets.v1.selectRevision",
  setLocked: "crewon.project-assets.v1.setLocked",
  saveReferenceCandidate: "crewon.project-assets.v1.saveReferenceCandidate",
  selectReference: "crewon.project-assets.v1.selectReference"
});
var PROJECT_ASSET_UI_ACTIONS = Object.freeze(
  Object.values(PROJECT_ASSET_UI_METHOD_ACTIONS)
);
var PROJECT_ASSET_UI_MUTATION_ACTIONS = Object.freeze([
  PROJECT_ASSET_UI_METHOD_ACTIONS.saveCandidate,
  PROJECT_ASSET_UI_METHOD_ACTIONS.selectRevision,
  PROJECT_ASSET_UI_METHOD_ACTIONS.setLocked,
  PROJECT_ASSET_UI_METHOD_ACTIONS.saveReferenceCandidate,
  PROJECT_ASSET_UI_METHOD_ACTIONS.selectReference
]);
function isProjectAssetUiAction(input) {
  return typeof input === "string" && PROJECT_ASSET_UI_ACTIONS.some((value) => value === input);
}

// packages/contracts/src/project-asset-response-contract.ts
function parsePublicProjectAsset(input) {
  const value = assetContractRecord(assetContractCopy(input, 8192), [
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
    projectId: assetContractId(value.projectId),
    assetId: assetContractId(value.assetId),
    kind: assetContractKind(value.kind),
    revision: assetContractRevision(value.revision),
    latestContentRevision: assetContractRevision(value.latestContentRevision),
    selectedContentRevision: value.selectedContentRevision === null ? null : assetContractRevision(value.selectedContentRevision),
    latestReferenceRevision: assetContractRevision(value.latestReferenceRevision, 0),
    selectedReferenceRevision: value.selectedReferenceRevision === null ? null : assetContractRevision(value.selectedReferenceRevision),
    locked: value.locked,
    createdAt: assetContractTimestamp(value.createdAt),
    updatedAt: assetContractTimestamp(value.updatedAt)
  };
  if (typeof result.locked !== "boolean" || result.latestContentRevision + result.latestReferenceRevision > result.revision || result.selectedContentRevision !== null && result.selectedContentRevision > result.latestContentRevision || result.selectedReferenceRevision !== null && (result.selectedReferenceRevision > result.latestReferenceRevision || result.selectedContentRevision === null) || result.locked && result.selectedContentRevision === null || result.updatedAt < result.createdAt)
    assetContractFailure();
  return Object.freeze({ ...result, locked: result.locked });
}
function parsePublicProjectAssetRevision(input) {
  const value = assetContractRecord(assetContractCopy(input, 32 * 1024), [
    "projectId",
    "assetId",
    "kind",
    "contentRevision",
    "brief",
    "script",
    "content",
    "createdAt",
    "contentDigest"
  ]), brief = assetContractRecord(value.brief, ["briefRevision", "contentDigest"]), script = value.script === null ? null : assetContractRecord(value.script, [
    "artifactId",
    "episodeId",
    "contentRevision",
    "contentDigest"
  ]);
  return Object.freeze({
    projectId: assetContractId(value.projectId),
    assetId: assetContractId(value.assetId),
    kind: assetContractKind(value.kind),
    contentRevision: assetContractRevision(value.contentRevision),
    brief: Object.freeze({
      briefRevision: assetContractRevision(brief.briefRevision),
      contentDigest: assetContractDigest(brief.contentDigest)
    }),
    script: script === null ? null : Object.freeze({
      artifactId: assetContractId(script.artifactId),
      episodeId: assetContractId(script.episodeId),
      contentRevision: assetContractRevision(script.contentRevision),
      contentDigest: assetContractDigest(script.contentDigest)
    }),
    content: parsePublicProjectAssetContent(value.content),
    createdAt: assetContractTimestamp(value.createdAt),
    contentDigest: assetContractDigest(value.contentDigest)
  });
}
function parsePublicProjectAssetImageSource(input) {
  const value = assetContractRecord(assetContractCopy(input, 8192), [
    "conceptAssetId",
    "conceptAssetRevision",
    "selectionRevision",
    "conceptSelectionDigest",
    "resultLinkDigest",
    "generationLinkDigest",
    "sourceRunId",
    "sourceBindingDigest",
    "pluginId",
    "pluginVersion",
    "packageDigest",
    "configurationRevision",
    "configurationDigest",
    "operationId",
    "operationRevision",
    "operationDigest",
    "rawResultDigest",
    "resultIndex"
  ]);
  if (typeof value.operationId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
    value.operationId
  ))
    assetContractFailure();
  return Object.freeze({
    conceptAssetId: assetContractId(value.conceptAssetId),
    conceptAssetRevision: assetContractRevision(value.conceptAssetRevision),
    selectionRevision: assetContractRevision(value.selectionRevision),
    conceptSelectionDigest: assetContractDigest(value.conceptSelectionDigest),
    resultLinkDigest: assetContractDigest(value.resultLinkDigest),
    generationLinkDigest: assetContractDigest(value.generationLinkDigest),
    sourceRunId: assetContractOpaque(value.sourceRunId),
    sourceBindingDigest: assetContractDigest(value.sourceBindingDigest),
    pluginId: assetContractOpaque(value.pluginId),
    pluginVersion: assetContractOpaque(value.pluginVersion),
    packageDigest: assetContractDigest(value.packageDigest),
    configurationRevision: assetContractRevision(value.configurationRevision),
    configurationDigest: assetContractDigest(value.configurationDigest),
    operationId: value.operationId,
    operationRevision: assetContractRevision(value.operationRevision),
    operationDigest: assetContractDigest(value.operationDigest),
    rawResultDigest: assetContractDigest(value.rawResultDigest),
    resultIndex: assetContractRevision(value.resultIndex, 0, 15)
  });
}
function parsePublicProjectAssetReferenceRevision(input) {
  const value = assetContractRecord(assetContractCopy(input, 16 * 1024), [
    "projectId",
    "assetId",
    "referenceRevision",
    "assetContentRevision",
    "assetContentDigest",
    "source",
    "createdAt",
    "contentDigest"
  ]);
  return Object.freeze({
    projectId: assetContractId(value.projectId),
    assetId: assetContractId(value.assetId),
    referenceRevision: assetContractRevision(value.referenceRevision),
    assetContentRevision: assetContractRevision(value.assetContentRevision),
    assetContentDigest: assetContractDigest(value.assetContentDigest),
    source: parsePublicProjectAssetImageSource(value.source),
    createdAt: assetContractTimestamp(value.createdAt),
    contentDigest: assetContractDigest(value.contentDigest)
  });
}
function contentIdentity(asset, content) {
  if (asset.projectId !== content.projectId || asset.assetId !== content.assetId || asset.kind !== content.kind || content.contentRevision > asset.latestContentRevision)
    assetContractFailure();
}
function referenceIdentity(asset, reference) {
  if (asset.projectId !== reference.projectId || asset.assetId !== reference.assetId || reference.referenceRevision > asset.latestReferenceRevision || reference.assetContentRevision > asset.latestContentRevision)
    assetContractFailure();
}
function parsePublicProjectAssetView(input) {
  const value = assetContractRecord(assetContractCopy(input, MAX_PROJECT_ASSET_UI_RESPONSE_BYTES), [
    "asset",
    "selectedContentRevision",
    "selectedReferenceRevision",
    "dependencyState",
    "staleReasons",
    "referenceState"
  ]), asset = parsePublicProjectAsset(value.asset), content = value.selectedContentRevision === null ? null : parsePublicProjectAssetRevision(value.selectedContentRevision), reference = value.selectedReferenceRevision === null ? null : parsePublicProjectAssetReferenceRevision(
    value.selectedReferenceRevision
  );
  if (asset.selectedContentRevision !== (content?.contentRevision ?? null) || asset.selectedReferenceRevision !== (reference?.referenceRevision ?? null))
    assetContractFailure();
  if (content !== null) contentIdentity(asset, content);
  if (reference !== null) referenceIdentity(asset, reference);
  if (!Array.isArray(value.staleReasons) || value.staleReasons.length > 3 || new Set(value.staleReasons).size !== value.staleReasons.length || value.staleReasons.some(
    (reason) => reason !== "brief-changed" && reason !== "script-selection-changed" && reason !== "script-source-stale"
  ))
    assetContractFailure();
  const reasons = value.staleReasons;
  if (content === null && (value.dependencyState !== "unselected" || reasons.length !== 0) || content !== null && value.dependencyState !== (reasons.length ? "stale" : "current") || content?.script === null && (reasons.includes("script-selection-changed") || reasons.includes("script-source-stale")))
    assetContractFailure();
  const referenceState = reference === null ? "unselected" : content !== null && reference.assetContentRevision === content.contentRevision && reference.assetContentDigest === content.contentDigest ? "current" : "stale";
  if (value.referenceState !== referenceState) assetContractFailure();
  return Object.freeze({
    asset,
    selectedContentRevision: content,
    selectedReferenceRevision: reference,
    dependencyState: value.dependencyState,
    staleReasons: Object.freeze([...reasons]),
    referenceState
  });
}
function scope(input, result) {
  if (result.projectId !== input.projectId || input.assetId != null && result.assetId !== input.assetId)
    assetContractFailure();
}
function utf8Order(left, right) {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++)
    if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
function list(input, limit, parse) {
  if (!Array.isArray(input) || input.length > limit) assetContractFailure();
  return Object.freeze(input.map(parse));
}
function parseProjectAssetUiResponse(request, input) {
  return assetContractChecked(() => {
    switch (request.action) {
      case "crewon.project-assets.v1.getAsset": {
        const value = assetContractRecord(input, ["view"]), view = value.view === null ? null : parsePublicProjectAssetView(value.view);
        if (view !== null) scope(request.input, view.asset);
        return Object.freeze({ view });
      }
      case "crewon.project-assets.v1.getRevision": {
        const value = assetContractRecord(input, ["contentRevision"]), contentRevision = parsePublicProjectAssetRevision(
          value.contentRevision
        );
        scope(request.input, contentRevision);
        if (contentRevision.contentRevision !== request.input.contentRevision)
          assetContractFailure();
        return Object.freeze({ contentRevision });
      }
      case "crewon.project-assets.v1.getReferenceRevision": {
        const value = assetContractRecord(input, ["referenceRevision"]), referenceRevision = parsePublicProjectAssetReferenceRevision(
          value.referenceRevision
        );
        scope(request.input, referenceRevision);
        if (referenceRevision.referenceRevision !== request.input.referenceRevision)
          assetContractFailure();
        return Object.freeze({ referenceRevision });
      }
      case "crewon.project-assets.v1.listAssets": {
        const value = assetContractRecord(input, ["assets", "nextAssetId"]), assets = list(
          value.assets,
          request.input.limit,
          parsePublicProjectAsset
        );
        let previous = request.input.afterAssetId;
        for (const asset of assets) {
          scope(request.input, asset);
          if (previous !== null && utf8Order(previous, asset.assetId) >= 0)
            assetContractFailure();
          previous = asset.assetId;
        }
        const nextAssetId = value.nextAssetId === null ? null : assetContractId(value.nextAssetId);
        if (nextAssetId !== null && (assets.length === 0 || nextAssetId !== previous))
          assetContractFailure();
        return Object.freeze({ assets, nextAssetId });
      }
      case "crewon.project-assets.v1.listRevisions": {
        const value = assetContractRecord(input, ["revisions", "nextContentRevision"]), revisions = list(
          value.revisions,
          request.input.limit,
          parsePublicProjectAssetRevision
        );
        let previous = request.input.afterContentRevision;
        for (const item of revisions) {
          scope(request.input, item);
          if (item.contentRevision <= previous) assetContractFailure();
          previous = item.contentRevision;
        }
        const nextContentRevision = value.nextContentRevision === null ? null : assetContractRevision(value.nextContentRevision);
        if (nextContentRevision !== null && (revisions.length === 0 || nextContentRevision !== previous))
          assetContractFailure();
        return Object.freeze({ revisions, nextContentRevision });
      }
      case "crewon.project-assets.v1.listReferences": {
        const value = assetContractRecord(input, ["references", "nextReferenceRevision"]), references = list(
          value.references,
          request.input.limit,
          parsePublicProjectAssetReferenceRevision
        );
        let previous = request.input.afterReferenceRevision;
        for (const item of references) {
          scope(request.input, item);
          if (item.referenceRevision <= previous) assetContractFailure();
          previous = item.referenceRevision;
        }
        const nextReferenceRevision = value.nextReferenceRevision === null ? null : assetContractRevision(value.nextReferenceRevision);
        if (nextReferenceRevision !== null && (references.length === 0 || nextReferenceRevision !== previous))
          assetContractFailure();
        return Object.freeze({ references, nextReferenceRevision });
      }
      default:
        return mutation(request, input);
    }
  });
}
function mutation(request, input) {
  const value = assetContractRecord(input, [
    "kind",
    "disposition",
    "asset",
    "contentRevision",
    "referenceRevision"
  ]), asset = parsePublicProjectAsset(value.asset), content = value.contentRevision === null ? null : parsePublicProjectAssetRevision(value.contentRevision), reference = value.referenceRevision === null ? null : parsePublicProjectAssetReferenceRevision(value.referenceRevision);
  scope(request.input, asset);
  if (asset.revision !== request.input.request.expectedAssetRevision + 1 || value.disposition !== "committed" && value.disposition !== "replayed")
    assetContractFailure();
  if (content !== null) contentIdentity(asset, content);
  if (reference !== null) referenceIdentity(asset, reference);
  switch (request.action) {
    case "crewon.project-assets.v1.saveCandidate": {
      const expected = request.input.request;
      if (value.kind !== "save-content" || content === null || reference !== null || asset.kind !== expected.kind || content.contentRevision !== asset.latestContentRevision || content.brief.briefRevision !== expected.briefRevision || JSON.stringify(content.content) !== JSON.stringify(expected.content) || (expected.script === null ? content.script !== null : content.script === null || content.script.artifactId !== expected.script.artifactId || content.script.contentRevision !== expected.script.contentRevision) || request.input.assetId === null && (asset.latestContentRevision !== 1 || asset.latestReferenceRevision !== 0 || asset.selectedContentRevision !== null || asset.selectedReferenceRevision !== null || asset.locked))
        assetContractFailure();
      break;
    }
    case "crewon.project-assets.v1.selectRevision":
      if (value.kind !== "select-content" || content === null || reference !== null || content.contentRevision !== request.input.request.contentRevision || asset.selectedContentRevision !== content.contentRevision)
        assetContractFailure();
      break;
    case "crewon.project-assets.v1.setLocked":
      if (value.kind !== "set-lock" || content !== null || reference !== null || asset.locked !== request.input.request.locked)
        assetContractFailure();
      break;
    case "crewon.project-assets.v1.saveReferenceCandidate":
      if (value.kind !== "save-reference" || reference === null || content !== null || reference.referenceRevision !== asset.latestReferenceRevision || reference.assetContentRevision !== request.input.request.assetContentRevision || reference.source.conceptAssetId !== request.input.request.conceptAssetId || reference.source.selectionRevision !== request.input.request.selectionRevision)
        assetContractFailure();
      break;
    case "crewon.project-assets.v1.selectReference":
      if (value.kind !== "select-reference" || reference === null || content !== null || reference.referenceRevision !== request.input.request.referenceRevision || asset.selectedReferenceRevision !== reference.referenceRevision || asset.selectedContentRevision !== reference.assetContentRevision)
        assetContractFailure();
      break;
  }
  return Object.freeze({
    kind: value.kind,
    disposition: value.disposition,
    asset,
    contentRevision: content,
    referenceRevision: reference
  });
}

// packages/contracts/src/project-assets-contract.ts
function parseProjectAssetId(input) {
  return assetContractId(input);
}
function parseSaveProjectAssetCandidateRequest(input) {
  return assetContractChecked(() => {
    const value = assetContractRecord(assetContractCopy(input, MAX_PROJECT_ASSET_UI_INPUT_BYTES), [
      "kind",
      "expectedAssetRevision",
      "briefRevision",
      "script",
      "content"
    ]);
    const script = value.script === null ? null : assetContractRecord(value.script, ["artifactId", "contentRevision"]);
    return Object.freeze({
      kind: assetContractKind(value.kind),
      expectedAssetRevision: assetContractRevision(value.expectedAssetRevision, 0),
      briefRevision: assetContractRevision(value.briefRevision),
      script: script === null ? null : Object.freeze({
        artifactId: assetContractId(script.artifactId),
        contentRevision: assetContractRevision(script.contentRevision)
      }),
      content: parsePublicProjectAssetContent(value.content)
    });
  });
}
function parseSelectProjectAssetRevisionRequest(input) {
  const value = assetContractRecord(assetContractCopy(input, 1024), [
    "expectedAssetRevision",
    "contentRevision"
  ]);
  return Object.freeze({
    expectedAssetRevision: assetContractRevision(value.expectedAssetRevision),
    contentRevision: assetContractRevision(value.contentRevision)
  });
}
function parseSetProjectAssetLockedRequest(input) {
  const value = assetContractRecord(assetContractCopy(input, 1024), ["expectedAssetRevision", "locked"]);
  if (typeof value.locked !== "boolean") assetContractFailure();
  return Object.freeze({
    expectedAssetRevision: assetContractRevision(value.expectedAssetRevision),
    locked: value.locked
  });
}
function parseSaveProjectAssetReferenceCandidateRequest(input) {
  const value = assetContractRecord(assetContractCopy(input, 2048), [
    "expectedAssetRevision",
    "assetContentRevision",
    "conceptAssetId",
    "selectionRevision"
  ]);
  return Object.freeze({
    expectedAssetRevision: assetContractRevision(value.expectedAssetRevision),
    assetContentRevision: assetContractRevision(value.assetContentRevision),
    conceptAssetId: assetContractId(value.conceptAssetId),
    selectionRevision: assetContractRevision(value.selectionRevision)
  });
}
function parseSelectProjectAssetReferenceRequest(input) {
  const value = assetContractRecord(assetContractCopy(input, 1024), [
    "expectedAssetRevision",
    "referenceRevision"
  ]);
  return Object.freeze({
    expectedAssetRevision: assetContractRevision(value.expectedAssetRevision),
    referenceRevision: assetContractRevision(value.referenceRevision)
  });
}
function parseProjectAssetUiActionRequest(input) {
  return assetContractChecked(() => {
    const value = assetContractRecord(assetContractCopy(input, MAX_PROJECT_ASSET_UI_INPUT_BYTES), [
      "action",
      "input"
    ]), action = value.action;
    if (!isProjectAssetUiAction(action)) assetContractFailure();
    const base = ["projectId"];
    switch (action) {
      case "crewon.project-assets.v1.listAssets":
        base.push("afterAssetId", "limit");
        break;
      case "crewon.project-assets.v1.listRevisions":
        base.push("assetId", "afterContentRevision", "limit");
        break;
      case "crewon.project-assets.v1.listReferences":
        base.push("assetId", "afterReferenceRevision", "limit");
        break;
      case "crewon.project-assets.v1.getRevision":
        base.push("assetId", "contentRevision");
        break;
      case "crewon.project-assets.v1.getReferenceRevision":
        base.push("assetId", "referenceRevision");
        break;
      case "crewon.project-assets.v1.getAsset":
        base.push("assetId");
        break;
      default:
        base.push("assetId", "request", "idempotencyKey");
        break;
    }
    const body = assetContractRecord(value.input, base), projectId = assetContractId(body.projectId);
    if (action === "crewon.project-assets.v1.listAssets")
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId,
          afterAssetId: body.afterAssetId === null ? null : assetContractId(body.afterAssetId),
          limit: assetContractRevision(body.limit, 1, 16)
        })
      });
    const assetId = action === "crewon.project-assets.v1.saveCandidate" && body.assetId === null ? null : assetContractId(body.assetId);
    switch (action) {
      case "crewon.project-assets.v1.getAsset":
        return Object.freeze({
          action,
          input: Object.freeze({ projectId, assetId })
        });
      case "crewon.project-assets.v1.getRevision":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId,
            contentRevision: assetContractRevision(body.contentRevision)
          })
        });
      case "crewon.project-assets.v1.getReferenceRevision":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId,
            referenceRevision: assetContractRevision(body.referenceRevision)
          })
        });
      case "crewon.project-assets.v1.listRevisions":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId,
            afterContentRevision: assetContractRevision(body.afterContentRevision, 0),
            limit: assetContractRevision(body.limit, 1, 16)
          })
        });
      case "crewon.project-assets.v1.listReferences":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId,
            afterReferenceRevision: assetContractRevision(body.afterReferenceRevision, 0),
            limit: assetContractRevision(body.limit, 1, 16)
          })
        });
      default:
        break;
    }
    const idempotencyKey = assetContractId(
      parseCreativeProjectIdempotencyKey(body.idempotencyKey)
    );
    switch (action) {
      case "crewon.project-assets.v1.saveCandidate": {
        const request = parseSaveProjectAssetCandidateRequest(body.request);
        if (assetId === null !== (request.expectedAssetRevision === 0))
          assetContractFailure();
        return Object.freeze({
          action,
          input: Object.freeze({ projectId, assetId, request, idempotencyKey })
        });
      }
      case "crewon.project-assets.v1.selectRevision":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId,
            request: parseSelectProjectAssetRevisionRequest(body.request),
            idempotencyKey
          })
        });
      case "crewon.project-assets.v1.setLocked":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId,
            request: parseSetProjectAssetLockedRequest(body.request),
            idempotencyKey
          })
        });
      case "crewon.project-assets.v1.saveReferenceCandidate":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId,
            request: parseSaveProjectAssetReferenceCandidateRequest(
              body.request
            ),
            idempotencyKey
          })
        });
      case "crewon.project-assets.v1.selectReference":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId,
            request: parseSelectProjectAssetReferenceRequest(body.request),
            idempotencyKey
          })
        });
    }
    return assetContractFailure();
  });
}
function parseProjectAssetUiActionResponse(requestInput, input) {
  return assetContractChecked(
    () => parseProjectAssetUiResponse(
      parseProjectAssetUiActionRequest(requestInput),
      assetContractCopy(input, MAX_PROJECT_ASSET_UI_RESPONSE_BYTES)
    )
  );
}
var projectAssetsUiCodec = Object.freeze({
  parseRequest: parseProjectAssetUiActionRequest,
  parseResponse: parseProjectAssetUiActionResponse
});
export {
  parseProjectAssetId,
  parseProjectAssetUiActionRequest,
  parseProjectAssetUiActionResponse,
  parsePublicProjectAsset,
  parsePublicProjectAssetContent,
  parsePublicProjectAssetImageSource,
  parsePublicProjectAssetReferenceRevision,
  parsePublicProjectAssetRevision,
  parsePublicProjectAssetView,
  parseSaveProjectAssetCandidateRequest,
  parseSaveProjectAssetReferenceCandidateRequest,
  parseSelectProjectAssetReferenceRequest,
  parseSelectProjectAssetRevisionRequest,
  parseSetProjectAssetLockedRequest,
  projectAssetsUiCodec
};
