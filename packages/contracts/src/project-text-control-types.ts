import type { components } from "./generated/control-api.ts";

/** Independent project text protocol; ownership and audit identity remain on the server. */
export const MAX_PROJECT_TEXT_RESPONSE_BYTES = 60 * 1024;
export const MAX_PROJECT_TEXT_PAGE_SIZE = 16;
/** Generated OpenAPI shapes are recursively immutable at the public parser boundary. */
type Immutable<T> = T extends readonly unknown[]
  ? readonly Immutable<T[number]>[]
  : T extends object
    ? { readonly [K in keyof T]: Immutable<T[K]> }
    : T;
export type ProjectTextOutlineContent = Immutable<
  components["schemas"]["ProjectTextOutlineContent"]
>;
export type ProjectTextScriptContent = Immutable<
  components["schemas"]["ProjectTextScriptContent"]
>;
export type PublicProjectTextArtifact = Immutable<
  components["schemas"]["PublicProjectTextArtifact"]
>;
export type PublicProjectTextRevision = Immutable<
  components["schemas"]["PublicProjectTextRevision"]
>;
export type SaveProjectOutlineCandidateRequest = Immutable<
  components["schemas"]["SaveProjectOutlineCandidateRequest"]
>;
export type SaveProjectScriptCandidateRequest = Immutable<
  components["schemas"]["SaveProjectScriptCandidateRequest"]
>;
export type SelectProjectTextRevisionRequest = Immutable<
  components["schemas"]["SelectProjectTextRevisionRequest"]
>;
export type SetProjectTextArtifactLockedRequest = Immutable<
  components["schemas"]["SetProjectTextArtifactLockedRequest"]
>;
export type PublicProjectTextArtifactView = Immutable<
  components["schemas"]["PublicProjectTextArtifactView"]
>;
export type GetProjectTextArtifactResponse = Immutable<
  components["schemas"]["GetProjectTextArtifactResponse"]
>;
export type GetProjectTextRevisionResponse = Immutable<
  components["schemas"]["GetProjectTextRevisionResponse"]
>;
export type ProjectTextArtifactListResponse = Immutable<
  components["schemas"]["ProjectTextArtifactListResponse"]
>;
export type ProjectTextRevisionListResponse = Immutable<
  components["schemas"]["ProjectTextRevisionListResponse"]
>;
export type ProjectTextMutationResponse = Immutable<
  components["schemas"]["ProjectTextMutationResponse"]
>;
export type ProjectTextArtifactListQuery = Readonly<{
  afterArtifactId: string | null;
  limit: number;
}>;
export type ProjectTextRevisionListQuery = Readonly<{
  afterContentRevision: number;
  limit: number;
}>;
export type ProjectTextMutationExpectation = Readonly<{ projectId: string }> &
  (
    | Readonly<{
        kind: "save-outline";
        request: SaveProjectOutlineCandidateRequest;
      }>
    | Readonly<{
        kind: "save-script";
        episodeId: string;
        request: SaveProjectScriptCandidateRequest;
      }>
    | Readonly<{
        kind: "select-revision";
        artifactId: string;
        request: SelectProjectTextRevisionRequest;
      }>
    | Readonly<{
        kind: "set-lock";
        artifactId: string;
        request: SetProjectTextArtifactLockedRequest;
      }>
  );
