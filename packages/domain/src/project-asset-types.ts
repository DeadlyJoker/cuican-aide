import type { CreativeProjectScope } from "./creative-project.ts";
import type { ProjectAssetMediaImageSource } from "./project-asset-media-source.ts";

export type ProjectAssetKind = "character" | "scene" | "prop";
export type ProjectAssetContent = Readonly<{
  name: string;
  setting: string;
  visualPrompt: string;
}>;
export type ProjectAssetBriefSource = Readonly<{
  briefRevision: number;
  contentDigest: string;
}>;
export type ProjectAssetScriptSource = Readonly<{
  artifactId: string;
  episodeId: string;
  contentRevision: number;
  contentDigest: string;
}>;
export type ProjectAsset = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.project-asset.v1";
    ownerPrincipalId: string;
    assetId: string;
    kind: ProjectAssetKind;
    revision: number;
    latestContentRevision: number;
    selectedContentRevision: number | null;
    latestReferenceRevision: number;
    selectedReferenceRevision: number | null;
    locked: boolean;
    createdByActorId: string;
    createdAt: string;
    updatedByActorId: string;
    updatedAt: string;
  }>;
export type ProjectAssetRevision = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.project-asset-revision.v1";
    assetId: string;
    kind: ProjectAssetKind;
    contentRevision: number;
    brief: ProjectAssetBriefSource;
    script: ProjectAssetScriptSource | null;
    content: ProjectAssetContent;
    createdByActorId: string;
    createdAt: string;
    contentDigest: string;
  }>;
/** Frozen server-derived result identity. These digests are not media-byte digests. */
export type ProjectAssetImageSource = Readonly<{
  conceptAssetId: string;
  conceptAssetRevision: number;
  selectionRevision: number;
  conceptSelectionDigest: string;
  resultLinkDigest: string;
  generationLinkDigest: string;
  sourceRunId: string;
  sourceBindingDigest: string;
  pluginId: string;
  pluginVersion: string;
  packageDigest: string;
  configurationRevision: number;
  configurationDigest: string;
  operationId: string;
  operationRevision: number;
  operationDigest: string;
  rawResultDigest: string;
  resultIndex: number;
}>;
export type ProjectConceptAssetReferenceRevision = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.project-asset-reference.v1";
    ownerPrincipalId: string;
    assetId: string;
    referenceRevision: number;
    assetContentRevision: number;
    assetContentDigest: string;
    source: ProjectAssetImageSource;
    createdByActorId: string;
    createdAt: string;
    contentDigest: string;
  }>;
export type ProjectMediaAssetReferenceRevision = Omit<
  ProjectConceptAssetReferenceRevision,
  "schemaVersion" | "source"
> &
  Readonly<{
    schemaVersion: "crewon.project-asset-reference.v2";
    source: ProjectAssetMediaImageSource;
  }>;
export type ProjectAssetReferenceRevision =
  | ProjectConceptAssetReferenceRevision
  | ProjectMediaAssetReferenceRevision;
export interface ProjectAssetDigester {
  sha256(input: string): string;
}
export type ProjectAssetCandidateMutation = Readonly<{
  asset: ProjectAsset;
  contentRevision: ProjectAssetRevision;
}>;
export type ProjectAssetReferenceMutation = Readonly<{
  asset: ProjectAsset;
  referenceRevision: ProjectAssetReferenceRevision;
}>;
export type ProjectAssetDependencyReason =
  | "brief-changed"
  | "script-selection-changed"
  | "script-source-stale";
export type ProjectAssetDependencyStatus = Readonly<{
  dependencyState: "unselected" | "current" | "stale";
  staleReasons: readonly ProjectAssetDependencyReason[];
}>;
