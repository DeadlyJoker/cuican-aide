import type {
  PublicProjectAsset,
  PublicProjectAssetImageSource,
  PublicProjectAssetReferenceRevision,
  PublicProjectAssetView,
  ProjectAssetUiAction,
  ProjectAssetUiInputMap,
  ProjectAssetMutationResponse,
  PublicProjectAssetRevision,
} from "./project-assets-service.ts";

export const CREWON_PROJECT_ASSETS_V2_API_VERSION = "2";
export const PROJECT_ASSET_V2_ACTIONS = Object.freeze({
  getAsset: "crewon.project-assets.v2.getAsset",
  getRevision: "crewon.project-assets.v2.getRevision",
  getReferenceRevision: "crewon.project-assets.v2.getReferenceRevision",
  listAssets: "crewon.project-assets.v2.listAssets",
  listRevisions: "crewon.project-assets.v2.listRevisions",
  listReferences: "crewon.project-assets.v2.listReferences",
  saveCandidate: "crewon.project-assets.v2.saveCandidate",
  selectRevision: "crewon.project-assets.v2.selectRevision",
  setLocked: "crewon.project-assets.v2.setLocked",
  saveReferenceCandidate: "crewon.project-assets.v2.saveReferenceCandidate",
  selectReference: "crewon.project-assets.v2.selectReference",
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
type V2Action<A extends ProjectAssetUiAction> =
  A extends `crewon.project-assets.v1.${infer M}`
    ? `crewon.project-assets.v2.${M}`
    : never;
export type ProjectAssetV2LegacyRequest = {
  [A in ProjectAssetUiAction]: Readonly<{
    action: V2Action<A>;
    input: ProjectAssetUiInputMap[A];
  }>;
}[ProjectAssetUiAction];
export type ProjectAssetV2Request =
  | ProjectAssetV2LegacyRequest
  | Readonly<{
      action: typeof PROJECT_ASSET_V2_ACTIONS.adoptMediaReference;
      input: AdoptProjectAssetMediaReferenceRequest;
    }>;
export type ProjectAssetV2MutationRequest = Extract<
  ProjectAssetV2LegacyRequest,
  { input: { request: unknown } }
>;
export type ProjectAssetV2ReadRequest = Exclude<
  ProjectAssetV2LegacyRequest,
  ProjectAssetV2MutationRequest
>;
export type ProjectAssetV2MutationResponse = Readonly<
  Omit<ProjectAssetMutationResponse, "referenceRevision"> & {
    referenceRevision: PublicProjectAssetReferenceRevisionV2 | null;
  }
>;
export function isProjectAssetV2Action(
  action: unknown,
): action is ProjectAssetV2Request["action"] {
  return (
    typeof action === "string" &&
    Object.values(PROJECT_ASSET_V2_ACTIONS).some((a) => a === action)
  );
}
export function isProjectAssetV2MutationAction(
  action: string,
): action is ProjectAssetV2MutationRequest["action"] {
  return (
    action === PROJECT_ASSET_V2_ACTIONS.saveCandidate ||
    action === PROJECT_ASSET_V2_ACTIONS.selectRevision ||
    action === PROJECT_ASSET_V2_ACTIONS.setLocked ||
    action === PROJECT_ASSET_V2_ACTIONS.saveReferenceCandidate ||
    action === PROJECT_ASSET_V2_ACTIONS.selectReference
  );
}
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
  | Readonly<{ contentRevision: PublicProjectAssetRevision }>
  | Readonly<{
      assets: readonly PublicProjectAsset[];
      nextAssetId: string | null;
    }>
  | Readonly<{
      revisions: readonly PublicProjectAssetRevision[];
      nextContentRevision: number | null;
    }>
  | ProjectAssetV2MutationResponse
  | ProjectAssetV2AdoptionResponse;
