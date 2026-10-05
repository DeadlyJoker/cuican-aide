import type {
  PublicProjectAsset,
  PublicProjectAssetRevision,
  PublicProjectAssetReferenceRevision,
  ProjectAssetUiActionRequest,
} from "./project-assets-service.ts";

export const assetPublicDigest = `sha256:${"a".repeat(64)}`;
export const assetPublicAt = "2026-10-06T00:00:00.000Z";
export function assetPublicFixture() {
  const asset: PublicProjectAsset = {
    projectId: "project",
    assetId: "character",
    kind: "character",
    revision: 1,
    latestContentRevision: 1,
    selectedContentRevision: null,
    latestReferenceRevision: 0,
    selectedReferenceRevision: null,
    locked: false,
    createdAt: assetPublicAt,
    updatedAt: assetPublicAt,
  };
  const content: PublicProjectAssetRevision = {
    projectId: "project",
    assetId: "character",
    kind: "character",
    contentRevision: 1,
    brief: { briefRevision: 1, contentDigest: assetPublicDigest },
    script: null,
    content: {
      name: "角色",
      setting: "雨夜\n沉默的侦探",
      visualPrompt: "A detective\nin the rain",
    },
    createdAt: assetPublicAt,
    contentDigest: assetPublicDigest,
  };
  const reference: PublicProjectAssetReferenceRevision = {
    projectId: "project",
    assetId: "character",
    referenceRevision: 1,
    assetContentRevision: 1,
    assetContentDigest: assetPublicDigest,
    createdAt: assetPublicAt,
    contentDigest: assetPublicDigest,
    source: {
      conceptAssetId: "concept",
      conceptAssetRevision: 1,
      selectionRevision: 1,
      conceptSelectionDigest: assetPublicDigest,
      resultLinkDigest: assetPublicDigest,
      generationLinkDigest: assetPublicDigest,
      sourceRunId: "-legacyRun",
      sourceBindingDigest: assetPublicDigest,
      pluginId: "crewon.comfyui-krea2",
      pluginVersion: "1.0.0",
      packageDigest: assetPublicDigest,
      configurationRevision: 1,
      configurationDigest: assetPublicDigest,
      operationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      operationRevision: 3,
      operationDigest: assetPublicDigest,
      rawResultDigest: assetPublicDigest,
      resultIndex: 0,
    },
  };
  const request: Extract<
    ProjectAssetUiActionRequest,
    { action: "crewon.project-assets.v1.saveCandidate" }
  > = {
    action: "crewon.project-assets.v1.saveCandidate",
    input: {
      projectId: "project",
      assetId: null,
      request: {
        kind: "character",
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: content.content,
      },
      idempotencyKey: "save-character",
    },
  };
  const response = {
    kind: "save-content" as const,
    disposition: "committed" as const,
    asset,
    contentRevision: content,
    referenceRevision: null,
  };
  return { asset, content, reference, request, response };
}
