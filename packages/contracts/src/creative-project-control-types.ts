import type { components } from "./generated/control-api.ts";

/** Public project records deliberately omit account, tenancy and audit identity. */
export const MAX_CREATIVE_PROJECT_RESPONSE_BYTES = 60 * 1024;
export type CreativeProjectState = PublicCreativeProject["state"];
export type CreativeProjectListState = CreativeProjectState | "all";
export type CreativeProjectCursor = Readonly<{
  updatedAt: string;
  projectId: string;
}>;
export type PublicCreativeProject = Readonly<
  components["schemas"]["PublicCreativeProject"]
>;
export type PublicProjectBrief = Readonly<
  components["schemas"]["PublicProjectBrief"]
>;
export type PublicConceptAsset = Readonly<
  components["schemas"]["PublicConceptAsset"]
>;
export type PublicConceptRevision = Readonly<
  components["schemas"]["PublicConceptRevision"]
>;
export type CreateCreativeProjectRequest = Readonly<
  components["schemas"]["CreateCreativeProjectRequest"]
>;
export type RenameCreativeProjectRequest = Readonly<
  components["schemas"]["RenameCreativeProjectRequest"]
>;
export type SetCreativeProjectStateRequest = Readonly<
  components["schemas"]["SetCreativeProjectStateRequest"]
>;
export type AppendProjectBriefRequest = Readonly<
  components["schemas"]["AppendProjectBriefRequest"]
>;
export type CreateConceptAssetRequest = Readonly<
  components["schemas"]["CreateConceptAssetRequest"]
>;
export type AppendConceptAssetRevisionRequest = Readonly<
  components["schemas"]["AppendConceptAssetRevisionRequest"]
>;
export type CreativeProjectListQuery = Readonly<{
  state: CreativeProjectListState;
  after: CreativeProjectCursor | null;
  limit: number;
}>;
export type ProjectBriefListQuery = Readonly<{
  afterBriefRevision: number;
  limit: number;
}>;
export type ConceptAssetListQuery = Readonly<{
  afterAssetId: string | null;
  limit: number;
}>;
export type ConceptRevisionListQuery = Readonly<{
  afterAssetRevision: number;
  limit: number;
}>;
export type CreativeProjectListResponse = Readonly<
  Omit<components["schemas"]["CreativeProjectListResponse"], "projects"> & {
    projects: readonly PublicCreativeProject[];
  }
>;
/** A continuation is the last returned item, not an exact claim that more records exist. */
export type ProjectBriefListResponse = Readonly<
  Omit<components["schemas"]["ProjectBriefListResponse"], "briefs"> & {
    briefs: readonly PublicProjectBrief[];
  }
>;
export type ConceptAssetListResponse = Readonly<
  Omit<components["schemas"]["ConceptAssetListResponse"], "assets"> & {
    assets: readonly PublicConceptAsset[];
  }
>;
export type ConceptRevisionListResponse = Readonly<
  Omit<components["schemas"]["ConceptRevisionListResponse"], "revisions"> & {
    revisions: readonly PublicConceptRevision[];
  }
>;
export type GetCreativeProjectResponse = Readonly<
  Omit<components["schemas"]["GetCreativeProjectResponse"], "project"> & {
    project: PublicCreativeProject;
  }
>;
export type GetProjectBriefResponse = Readonly<
  Omit<components["schemas"]["GetProjectBriefResponse"], "brief"> & {
    brief: PublicProjectBrief;
  }
>;
export type GetConceptAssetResponse = Readonly<
  Omit<components["schemas"]["GetConceptAssetResponse"], "asset"> & {
    asset: PublicConceptAsset;
  }
>;
export type GetConceptRevisionResponse = Readonly<
  Omit<components["schemas"]["GetConceptRevisionResponse"], "assetRevision"> & {
    assetRevision: PublicConceptRevision;
  }
>;
export type CreativeProjectMetadataMutationResponse = Readonly<
  Omit<
    components["schemas"]["CreativeProjectMetadataMutationResponse"],
    "project"
  > & { project: PublicCreativeProject }
>;
export type CreativeProjectBriefMutationResponse = Readonly<
  Omit<
    components["schemas"]["CreativeProjectBriefMutationResponse"],
    "project" | "brief"
  > & { project: PublicCreativeProject; brief: PublicProjectBrief }
>;
export type CreativeProjectConceptMutationResponse = Readonly<
  Omit<
    components["schemas"]["CreativeProjectConceptMutationResponse"],
    "project" | "asset" | "assetRevision"
  > & {
    project: PublicCreativeProject;
    asset: PublicConceptAsset;
    assetRevision: PublicConceptRevision;
  }
>;
export type CreativeProjectMutationResponse =
  | CreativeProjectMetadataMutationResponse
  | CreativeProjectBriefMutationResponse
  | CreativeProjectConceptMutationResponse;
export type CreativeProjectMutationExpectation =
  | Readonly<{ kind: "create-project"; request: CreateCreativeProjectRequest }>
  | Readonly<{
      kind: "rename-project";
      projectId: string;
      request: RenameCreativeProjectRequest;
    }>
  | Readonly<{
      kind: "set-project-state";
      projectId: string;
      request: SetCreativeProjectStateRequest;
    }>
  | Readonly<{
      kind: "append-brief";
      projectId: string;
      request: AppendProjectBriefRequest;
    }>
  | Readonly<{
      kind: "create-concept";
      projectId: string;
      request: CreateConceptAssetRequest;
    }>
  | Readonly<{
      kind: "append-concept";
      projectId: string;
      assetId: string;
      request: AppendConceptAssetRevisionRequest;
    }>;
