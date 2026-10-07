import type {
  PublicProjectAsset,
  PublicProjectAssetImageSource,
  PublicProjectAssetReferenceRevision,
  PublicProjectAssetView,
} from "./project-assets-service.ts";

export const CREWON_PROJECT_ASSETS_V2_API_VERSION = "2";
export const PROJECT_ASSET_V2_ACTIONS = Object.freeze({
  getAsset: "crewon.project-assets.v2.getAsset",
  getReferenceRevision: "crewon.project-assets.v2.getReferenceRevision",
  listReferences: "crewon.project-assets.v2.listReferences",
  adoptMediaReference: "crewon.project-assets.v2.adoptMediaReference",
} as const);
/** Bounded display provenance. It excludes suppliers, file paths, identity and execution authority. */
export type PublicProjectAssetMediaSource = Readonly<{
  kind: "media-result";
  candidateId: string;
  candidateDigest: string;
  sourceRunId: string;
  resultIndex: number;
  mediaInputId: string;
  inputRevision: number;
  workflowId: "krea2-reference-four-view";
  generatedFor: Readonly<{
    assetId: string;
    contentRevision: number;
    contentDigest: string;
    referenceRevision: number;
    referenceDigest: string;
  }>;
  observedAt: string;
}>;
export type PublicProjectAssetReferenceRevisionV2 = Readonly<
  Omit<PublicProjectAssetReferenceRevision, "source"> & {
    source:
      | (PublicProjectAssetImageSource &
          Readonly<{ kind: "concept-selection" }>)
      | PublicProjectAssetMediaSource;
  }
>;
export type PublicProjectAssetViewV2 = Readonly<
  Omit<PublicProjectAssetView, "selectedReferenceRevision"> & {
    selectedReferenceRevision: PublicProjectAssetReferenceRevisionV2 | null;
  }
>;
export type AdoptProjectAssetMediaReferenceRequest = Readonly<{
  projectId: string;
  assetId: string;
  expectedAssetRevision: number;
  assetContentRevision: number;
  runId: string;
  resultIndex: number;
  candidateId: string;
  candidateDigest: string;
  idempotencyKey: string;
}>;
type AssetQuery = Readonly<{ projectId: string; assetId: string }>;
export type ProjectAssetV2Request =
  | Readonly<{
      action: typeof PROJECT_ASSET_V2_ACTIONS.getAsset;
      input: AssetQuery;
    }>
  | Readonly<{
      action: typeof PROJECT_ASSET_V2_ACTIONS.getReferenceRevision;
      input: AssetQuery & Readonly<{ referenceRevision: number }>;
    }>
  | Readonly<{
      action: typeof PROJECT_ASSET_V2_ACTIONS.listReferences;
      input: AssetQuery &
        Readonly<{ afterReferenceRevision: number; limit: number }>;
    }>
  | Readonly<{
      action: typeof PROJECT_ASSET_V2_ACTIONS.adoptMediaReference;
      input: AdoptProjectAssetMediaReferenceRequest;
    }>;
export type ProjectAssetV2ReadRequest = Exclude<
  ProjectAssetV2Request,
  { action: typeof PROJECT_ASSET_V2_ACTIONS.adoptMediaReference }
>;
export type ProjectAssetV2AdoptionResponse = Readonly<{
  disposition: "committed" | "replayed";
  asset: PublicProjectAsset;
  referenceRevision: PublicProjectAssetReferenceRevisionV2 &
    Readonly<{ source: PublicProjectAssetMediaSource }>;
}>;
export type ProjectAssetV2Response =
  | Readonly<{ view: PublicProjectAssetViewV2 | null }>
  | Readonly<{ referenceRevision: PublicProjectAssetReferenceRevisionV2 }>
  | Readonly<{
      references: readonly PublicProjectAssetReferenceRevisionV2[];
      nextReferenceRevision: number | null;
    }>
  | ProjectAssetV2AdoptionResponse;
