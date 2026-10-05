import {
  assetContractChecked as checked,
  assetContractCopy as copy,
  assetContractRecord as record,
  assetContractRevision as revision,
  assetContractId as id,
  assetContractOpaque as opaque,
  assetContractDigest as digest,
  assetContractTimestamp as timestamp,
  assetContractKind as kind,
  assetContractFailure as fail,
  parsePublicProjectAssetContent,
} from "./project-asset-contract-support.ts";
import {
  MAX_PROJECT_ASSET_UI_RESPONSE_BYTES,
  type PublicProjectAsset,
  type PublicProjectAssetRevision,
  type PublicProjectAssetReferenceRevision,
  type PublicProjectAssetImageSource,
  type PublicProjectAssetView,
  type ProjectAssetUiActionRequest,
  type ProjectAssetUiAction,
  type ProjectAssetUiResponseMap,
  type ProjectAssetMutationResponse,
} from "./project-assets-service.ts";
export function parsePublicProjectAsset(input: unknown): PublicProjectAsset {
  const value = record(copy(input, 8192), [
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
    "updatedAt",
  ]);
  const result = {
    projectId: id(value.projectId),
    assetId: id(value.assetId),
    kind: kind(value.kind),
    revision: revision(value.revision),
    latestContentRevision: revision(value.latestContentRevision),
    selectedContentRevision:
      value.selectedContentRevision === null
        ? null
        : revision(value.selectedContentRevision),
    latestReferenceRevision: revision(value.latestReferenceRevision, 0),
    selectedReferenceRevision:
      value.selectedReferenceRevision === null
        ? null
        : revision(value.selectedReferenceRevision),
    locked: value.locked,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
  if (
    typeof result.locked !== "boolean" ||
    result.latestContentRevision + result.latestReferenceRevision >
      result.revision ||
    (result.selectedContentRevision !== null &&
      result.selectedContentRevision > result.latestContentRevision) ||
    (result.selectedReferenceRevision !== null &&
      (result.selectedReferenceRevision > result.latestReferenceRevision ||
        result.selectedContentRevision === null)) ||
    (result.locked && result.selectedContentRevision === null) ||
    result.updatedAt < result.createdAt
  )
    fail();
  return Object.freeze({ ...result, locked: result.locked });
}
export function parsePublicProjectAssetRevision(
  input: unknown,
): PublicProjectAssetRevision {
  const value = record(copy(input, 32 * 1024), [
      "projectId",
      "assetId",
      "kind",
      "contentRevision",
      "brief",
      "script",
      "content",
      "createdAt",
      "contentDigest",
    ]),
    brief = record(value.brief, ["briefRevision", "contentDigest"]),
    script =
      value.script === null
        ? null
        : record(value.script, [
            "artifactId",
            "episodeId",
            "contentRevision",
            "contentDigest",
          ]);
  return Object.freeze({
    projectId: id(value.projectId),
    assetId: id(value.assetId),
    kind: kind(value.kind),
    contentRevision: revision(value.contentRevision),
    brief: Object.freeze({
      briefRevision: revision(brief.briefRevision),
      contentDigest: digest(brief.contentDigest),
    }),
    script:
      script === null
        ? null
        : Object.freeze({
            artifactId: id(script.artifactId),
            episodeId: id(script.episodeId),
            contentRevision: revision(script.contentRevision),
            contentDigest: digest(script.contentDigest),
          }),
    content: parsePublicProjectAssetContent(value.content),
    createdAt: timestamp(value.createdAt),
    contentDigest: digest(value.contentDigest),
  });
}
export function parsePublicProjectAssetImageSource(
  input: unknown,
): PublicProjectAssetImageSource {
  const value = record(copy(input, 8192), [
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
    "resultIndex",
  ]);
  if (
    typeof value.operationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      value.operationId,
    )
  )
    fail();
  return Object.freeze({
    conceptAssetId: id(value.conceptAssetId),
    conceptAssetRevision: revision(value.conceptAssetRevision),
    selectionRevision: revision(value.selectionRevision),
    conceptSelectionDigest: digest(value.conceptSelectionDigest),
    resultLinkDigest: digest(value.resultLinkDigest),
    generationLinkDigest: digest(value.generationLinkDigest),
    sourceRunId: opaque(value.sourceRunId),
    sourceBindingDigest: digest(value.sourceBindingDigest),
    pluginId: opaque(value.pluginId),
    pluginVersion: opaque(value.pluginVersion),
    packageDigest: digest(value.packageDigest),
    configurationRevision: revision(value.configurationRevision),
    configurationDigest: digest(value.configurationDigest),
    operationId: value.operationId,
    operationRevision: revision(value.operationRevision),
    operationDigest: digest(value.operationDigest),
    rawResultDigest: digest(value.rawResultDigest),
    resultIndex: revision(value.resultIndex, 0, 15),
  });
}
export function parsePublicProjectAssetReferenceRevision(
  input: unknown,
): PublicProjectAssetReferenceRevision {
  const value = record(copy(input, 16 * 1024), [
    "projectId",
    "assetId",
    "referenceRevision",
    "assetContentRevision",
    "assetContentDigest",
    "source",
    "createdAt",
    "contentDigest",
  ]);
  return Object.freeze({
    projectId: id(value.projectId),
    assetId: id(value.assetId),
    referenceRevision: revision(value.referenceRevision),
    assetContentRevision: revision(value.assetContentRevision),
    assetContentDigest: digest(value.assetContentDigest),
    source: parsePublicProjectAssetImageSource(value.source),
    createdAt: timestamp(value.createdAt),
    contentDigest: digest(value.contentDigest),
  });
}
function contentIdentity(
  asset: PublicProjectAsset,
  content: PublicProjectAssetRevision,
): void {
  if (
    asset.projectId !== content.projectId ||
    asset.assetId !== content.assetId ||
    asset.kind !== content.kind ||
    content.contentRevision > asset.latestContentRevision
  )
    fail();
}
function referenceIdentity(
  asset: PublicProjectAsset,
  reference: PublicProjectAssetReferenceRevision,
): void {
  if (
    asset.projectId !== reference.projectId ||
    asset.assetId !== reference.assetId ||
    reference.referenceRevision > asset.latestReferenceRevision ||
    reference.assetContentRevision > asset.latestContentRevision
  )
    fail();
}
export function parsePublicProjectAssetView(
  input: unknown,
): PublicProjectAssetView {
  const value = record(copy(input, MAX_PROJECT_ASSET_UI_RESPONSE_BYTES), [
      "asset",
      "selectedContentRevision",
      "selectedReferenceRevision",
      "dependencyState",
      "staleReasons",
      "referenceState",
    ]),
    asset = parsePublicProjectAsset(value.asset),
    content =
      value.selectedContentRevision === null
        ? null
        : parsePublicProjectAssetRevision(value.selectedContentRevision),
    reference =
      value.selectedReferenceRevision === null
        ? null
        : parsePublicProjectAssetReferenceRevision(
            value.selectedReferenceRevision,
          );
  if (
    asset.selectedContentRevision !== (content?.contentRevision ?? null) ||
    asset.selectedReferenceRevision !== (reference?.referenceRevision ?? null)
  )
    fail();
  if (content !== null) contentIdentity(asset, content);
  if (reference !== null) referenceIdentity(asset, reference);
  if (
    !Array.isArray(value.staleReasons) ||
    value.staleReasons.length > 3 ||
    new Set(value.staleReasons).size !== value.staleReasons.length ||
    value.staleReasons.some(
      (reason) =>
        reason !== "brief-changed" &&
        reason !== "script-selection-changed" &&
        reason !== "script-source-stale",
    )
  )
    fail();
  const reasons = value.staleReasons as readonly (
    | "brief-changed"
    | "script-selection-changed"
    | "script-source-stale"
  )[];
  if (
    (content === null &&
      (value.dependencyState !== "unselected" || reasons.length !== 0)) ||
    (content !== null &&
      value.dependencyState !== (reasons.length ? "stale" : "current")) ||
    (content?.script === null &&
      (reasons.includes("script-selection-changed") ||
        reasons.includes("script-source-stale")))
  )
    fail();
  const referenceState =
    reference === null
      ? "unselected"
      : content !== null &&
          reference.assetContentRevision === content.contentRevision &&
          reference.assetContentDigest === content.contentDigest
        ? "current"
        : "stale";
  if (value.referenceState !== referenceState) fail();
  return Object.freeze({
    asset,
    selectedContentRevision: content,
    selectedReferenceRevision: reference,
    dependencyState:
      value.dependencyState as PublicProjectAssetView["dependencyState"],
    staleReasons: Object.freeze([...reasons]),
    referenceState,
  });
}
function scope(
  input: Readonly<{ projectId: string; assetId?: string | null }>,
  result: Readonly<{ projectId: string; assetId: string }>,
): void {
  if (
    result.projectId !== input.projectId ||
    (input.assetId != null && result.assetId !== input.assetId)
  )
    fail();
}
function utf8Order(left: string, right: string): number {
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++)
    if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
function list<T>(
  input: unknown,
  limit: number,
  parse: (input: unknown) => T,
): readonly T[] {
  if (!Array.isArray(input) || input.length > limit) fail();
  return Object.freeze(input.map(parse));
}
/** The outer request is already copied and parsed by the public codec. */
export function parseProjectAssetUiResponse(
  request: ProjectAssetUiActionRequest,
  input: unknown,
): ProjectAssetUiResponseMap[ProjectAssetUiAction] {
  return checked(() => {
    switch (request.action) {
      case "crewon.project-assets.v1.getAsset": {
        const value = record(input, ["view"]),
          view =
            value.view === null
              ? null
              : parsePublicProjectAssetView(value.view);
        if (view !== null) scope(request.input, view.asset);
        return Object.freeze({ view });
      }
      case "crewon.project-assets.v1.getRevision": {
        const value = record(input, ["contentRevision"]),
          contentRevision = parsePublicProjectAssetRevision(
            value.contentRevision,
          );
        scope(request.input, contentRevision);
        if (contentRevision.contentRevision !== request.input.contentRevision)
          fail();
        return Object.freeze({ contentRevision });
      }
      case "crewon.project-assets.v1.getReferenceRevision": {
        const value = record(input, ["referenceRevision"]),
          referenceRevision = parsePublicProjectAssetReferenceRevision(
            value.referenceRevision,
          );
        scope(request.input, referenceRevision);
        if (
          referenceRevision.referenceRevision !==
          request.input.referenceRevision
        )
          fail();
        return Object.freeze({ referenceRevision });
      }
      case "crewon.project-assets.v1.listAssets": {
        const value = record(input, ["assets", "nextAssetId"]),
          assets = list(
            value.assets,
            request.input.limit,
            parsePublicProjectAsset,
          );
        let previous = request.input.afterAssetId;
        for (const asset of assets) {
          scope(request.input, asset);
          if (previous !== null && utf8Order(previous, asset.assetId) >= 0)
            fail();
          previous = asset.assetId;
        }
        const nextAssetId =
          value.nextAssetId === null ? null : id(value.nextAssetId);
        if (
          nextAssetId !== null &&
          (assets.length === 0 || nextAssetId !== previous)
        )
          fail();
        return Object.freeze({ assets, nextAssetId });
      }
      case "crewon.project-assets.v1.listRevisions": {
        const value = record(input, ["revisions", "nextContentRevision"]),
          revisions = list(
            value.revisions,
            request.input.limit,
            parsePublicProjectAssetRevision,
          );
        let previous = request.input.afterContentRevision;
        for (const item of revisions) {
          scope(request.input, item);
          if (item.contentRevision <= previous) fail();
          previous = item.contentRevision;
        }
        const nextContentRevision =
          value.nextContentRevision === null
            ? null
            : revision(value.nextContentRevision);
        if (
          nextContentRevision !== null &&
          (revisions.length === 0 || nextContentRevision !== previous)
        )
          fail();
        return Object.freeze({ revisions, nextContentRevision });
      }
      case "crewon.project-assets.v1.listReferences": {
        const value = record(input, ["references", "nextReferenceRevision"]),
          references = list(
            value.references,
            request.input.limit,
            parsePublicProjectAssetReferenceRevision,
          );
        let previous = request.input.afterReferenceRevision;
        for (const item of references) {
          scope(request.input, item);
          if (item.referenceRevision <= previous) fail();
          previous = item.referenceRevision;
        }
        const nextReferenceRevision =
          value.nextReferenceRevision === null
            ? null
            : revision(value.nextReferenceRevision);
        if (
          nextReferenceRevision !== null &&
          (references.length === 0 || nextReferenceRevision !== previous)
        )
          fail();
        return Object.freeze({ references, nextReferenceRevision });
      }
      default:
        return mutation(request, input);
    }
  });
}
function mutation(
  request: Extract<
    ProjectAssetUiActionRequest,
    { input: { request: unknown } }
  >,
  input: unknown,
): ProjectAssetMutationResponse {
  const value = record(input, [
      "kind",
      "disposition",
      "asset",
      "contentRevision",
      "referenceRevision",
    ]),
    asset = parsePublicProjectAsset(value.asset),
    content =
      value.contentRevision === null
        ? null
        : parsePublicProjectAssetRevision(value.contentRevision),
    reference =
      value.referenceRevision === null
        ? null
        : parsePublicProjectAssetReferenceRevision(value.referenceRevision);
  scope(request.input, asset);
  if (
    asset.revision !== request.input.request.expectedAssetRevision + 1 ||
    (value.disposition !== "committed" && value.disposition !== "replayed")
  )
    fail();
  if (content !== null) contentIdentity(asset, content);
  if (reference !== null) referenceIdentity(asset, reference);
  switch (request.action) {
    case "crewon.project-assets.v1.saveCandidate": {
      const expected = request.input.request;
      if (
        value.kind !== "save-content" ||
        content === null ||
        reference !== null ||
        asset.kind !== expected.kind ||
        content.contentRevision !== asset.latestContentRevision ||
        content.brief.briefRevision !== expected.briefRevision ||
        JSON.stringify(content.content) !== JSON.stringify(expected.content) ||
        (expected.script === null
          ? content.script !== null
          : content.script === null ||
            content.script.artifactId !== expected.script.artifactId ||
            content.script.contentRevision !==
              expected.script.contentRevision) ||
        (request.input.assetId === null &&
          (asset.latestContentRevision !== 1 ||
            asset.latestReferenceRevision !== 0 ||
            asset.selectedContentRevision !== null ||
            asset.selectedReferenceRevision !== null ||
            asset.locked))
      )
        fail();
      break;
    }
    case "crewon.project-assets.v1.selectRevision":
      if (
        value.kind !== "select-content" ||
        content === null ||
        reference !== null ||
        content.contentRevision !== request.input.request.contentRevision ||
        asset.selectedContentRevision !== content.contentRevision
      )
        fail();
      break;
    case "crewon.project-assets.v1.setLocked":
      if (
        value.kind !== "set-lock" ||
        content !== null ||
        reference !== null ||
        asset.locked !== request.input.request.locked
      )
        fail();
      break;
    case "crewon.project-assets.v1.saveReferenceCandidate":
      if (
        value.kind !== "save-reference" ||
        reference === null ||
        content !== null ||
        reference.referenceRevision !== asset.latestReferenceRevision ||
        reference.assetContentRevision !==
          request.input.request.assetContentRevision ||
        reference.source.conceptAssetId !==
          request.input.request.conceptAssetId ||
        reference.source.selectionRevision !==
          request.input.request.selectionRevision
      )
        fail();
      break;
    case "crewon.project-assets.v1.selectReference":
      if (
        value.kind !== "select-reference" ||
        reference === null ||
        content !== null ||
        reference.referenceRevision !==
          request.input.request.referenceRevision ||
        asset.selectedReferenceRevision !== reference.referenceRevision ||
        asset.selectedContentRevision !== reference.assetContentRevision
      )
        fail();
      break;
  }
  return Object.freeze({
    kind: value.kind as ProjectAssetMutationResponse["kind"],
    disposition: value.disposition,
    asset,
    contentRevision: content,
    referenceRevision: reference,
  });
}
