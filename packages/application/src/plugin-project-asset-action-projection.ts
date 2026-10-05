import type {
  ProjectAsset,
  ProjectAssetRevision,
  ProjectAssetReferenceRevision,
} from "@crewon/domain";
import {
  MAX_PROJECT_ASSET_UI_RESPONSE_BYTES,
  type PublicProjectAsset,
  type PublicProjectAssetRevision,
  type PublicProjectAssetReferenceRevision,
  type PublicProjectAssetView,
  type ProjectAssetMutationResponse,
} from "@crewon/contracts/project-assets";
import type {
  ProjectAssetView,
  ProjectAssetMutationResult,
} from "./project-asset-store-port.ts";

/** Public projection deliberately excludes actor, owner, tenant, profile and invocation authority. */
export function projectAssetPublicHead(a: ProjectAsset): PublicProjectAsset {
  return Object.freeze({
    projectId: a.projectId,
    assetId: a.assetId,
    kind: a.kind,
    revision: a.revision,
    latestContentRevision: a.latestContentRevision,
    selectedContentRevision: a.selectedContentRevision,
    latestReferenceRevision: a.latestReferenceRevision,
    selectedReferenceRevision: a.selectedReferenceRevision,
    locked: a.locked,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  });
}
export function projectAssetPublicRevision(
  r: ProjectAssetRevision,
): PublicProjectAssetRevision {
  return Object.freeze({
    projectId: r.projectId,
    assetId: r.assetId,
    kind: r.kind,
    contentRevision: r.contentRevision,
    brief: r.brief,
    script: r.script,
    content: r.content,
    createdAt: r.createdAt,
    contentDigest: r.contentDigest,
  });
}
export function projectAssetPublicReference(
  r: ProjectAssetReferenceRevision,
): PublicProjectAssetReferenceRevision {
  return Object.freeze({
    projectId: r.projectId,
    assetId: r.assetId,
    referenceRevision: r.referenceRevision,
    assetContentRevision: r.assetContentRevision,
    assetContentDigest: r.assetContentDigest,
    source: r.source,
    createdAt: r.createdAt,
    contentDigest: r.contentDigest,
  });
}
export function projectAssetPublicView(
  v: ProjectAssetView | null,
): PublicProjectAssetView | null {
  return v === null
    ? null
    : Object.freeze({
        asset: projectAssetPublicHead(v.asset),
        selectedContentRevision:
          v.selectedRevision === null
            ? null
            : projectAssetPublicRevision(v.selectedRevision),
        selectedReferenceRevision:
          v.selectedReference === null
            ? null
            : projectAssetPublicReference(v.selectedReference),
        dependencyState: v.dependencyState,
        staleReasons: v.staleReasons,
        referenceState: v.referenceState,
      });
}
export function projectAssetPublicMutation(
  v: ProjectAssetMutationResult,
): ProjectAssetMutationResponse {
  return Object.freeze({
    kind: v.kind,
    disposition: v.disposition,
    asset: projectAssetPublicHead(v.asset),
    contentRevision:
      v.contentRevision === null
        ? null
        : projectAssetPublicRevision(v.contentRevision),
    referenceRevision:
      v.referenceRevision === null
        ? null
        : projectAssetPublicReference(v.referenceRevision),
  });
}
/** Trim whole read records; the returned continuation always refers to the last item actually returned. */
export function projectAssetPublicPage<T, C, R>(
  input: Readonly<{
    items: readonly T[];
    continuation: C | null;
    cursorOf(item: T): C;
    response(items: readonly T[], continuation: C | null): R;
  }>,
): R {
  const items = [...input.items];
  for (;;) {
    const continuation =
      items.length < input.items.length
        ? items.length === 0
          ? null
          : input.cursorOf(items.at(-1)!)
        : input.continuation;
    const output = input.response(Object.freeze([...items]), continuation);
    if (
      Buffer.byteLength(JSON.stringify(output), "utf8") <=
      MAX_PROJECT_ASSET_UI_RESPONSE_BYTES
    )
      return output;
    if (items.length < 2) throw new Error("project_asset_response_limit");
    items.pop();
  }
}
