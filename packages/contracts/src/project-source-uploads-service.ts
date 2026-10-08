/** Portable, independent upload protocol. It declares no route, identity, installation or byte access. */
export const CREWON_PROJECT_SOURCE_UPLOAD_SERVICE =
  "crewon.project-source-uploads";
export const CREWON_PROJECT_SOURCE_UPLOAD_API_VERSION = "1";
export const MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES = 8 * 1024;
export const MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES = 60 * 1024;
export const PROJECT_SOURCE_UPLOAD_PART_BYTES = 65_536;
export const PROJECT_SOURCE_UPLOAD_MAX_BYTES = 20_000_000;
export const PROJECT_SOURCE_UPLOAD_MAX_PARTS = 306;
export const PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS = Object.freeze({
  begin: "crewon.project-source-uploads.v1.begin",
  status: "crewon.project-source-uploads.v1.status",
  prepare: "crewon.project-source-uploads.v1.prepare",
  cancel: "crewon.project-source-uploads.v1.cancel",
} as const);
export type ProjectSourceUploadMethod =
  keyof typeof PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS;
export type ProjectSourceUploadAction =
  (typeof PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS)[ProjectSourceUploadMethod];
export const PROJECT_SOURCE_UPLOAD_ACTIONS = Object.freeze(
  Object.values(PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS),
);
export function isProjectSourceUploadAction(
  value: unknown,
): value is ProjectSourceUploadAction {
  return (
    typeof value === "string" &&
    PROJECT_SOURCE_UPLOAD_ACTIONS.some((action) => action === value)
  );
}
export type ProjectSourceUploadFormat = "txt" | "md" | "html";
export type ProjectSourceUploadPhase =
  | "receiving"
  | "raw-sealed"
  | "preparing"
  | "ready"
  | "rejected"
  | "cancelled"
  | "expired";
export type PublicProjectSourceUploadPart = Readonly<{
  index: number;
  byteLength: number;
  rawDigest: string;
}>;
export type PublicProjectSourceUploadPrepared = Readonly<{
  digest: string;
  characterLength: number;
  normalizedByteLength: number;
  chunkCount: number;
  chapterCount: number;
}>;
/** Original byte metadata and acknowledged descriptors only; no original or normalized body. */
export type PublicProjectSourceUpload = Readonly<{
  uploadId: string;
  revision: number;
  phase: ProjectSourceUploadPhase;
  fileName: string;
  format: ProjectSourceUploadFormat;
  byteLength: number;
  fileDigest: string;
  partBytes: 65_536;
  partCount: number;
  receivedParts: readonly PublicProjectSourceUploadPart[];
  prepared: PublicProjectSourceUploadPrepared | null;
  failureCode: string | null;
  updatedAt: string;
}>;
export type ProjectSourceUploadPartLocator = Readonly<{
  uploadId: string;
  partIndex: number;
  rawDigest: string;
}>;
export type ProjectSourceUploadInputMap = {
  begin: Readonly<{
    idempotencyKey: string;
    fileName: string;
    format: ProjectSourceUploadFormat;
    byteLength: number;
    fileDigest: string;
  }>;
  status: Readonly<{ uploadId: string }>;
  prepare: Readonly<{ uploadId: string; expectedRevision: number }>;
  cancel: Readonly<{ uploadId: string; expectedRevision: number }>;
};
export type ProjectSourceUploadMutationResponse = Readonly<{
  disposition: "committed" | "replayed";
  upload: PublicProjectSourceUpload;
}>;
export type ProjectSourceUploadPreparationResponse = Readonly<{
  disposition: "ready" | "pending" | "rejected";
  upload: PublicProjectSourceUpload;
}>;
export type ProjectSourceUploadResponseMap = {
  begin: ProjectSourceUploadMutationResponse;
  status: Readonly<{ upload: PublicProjectSourceUpload }>;
  prepare: ProjectSourceUploadPreparationResponse;
  cancel: ProjectSourceUploadMutationResponse;
};
export type ProjectSourceUploadRequestFor<M extends ProjectSourceUploadMethod> =
  Readonly<{
    action: (typeof PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS)[M];
    input: ProjectSourceUploadInputMap[M];
  }>;
export type ProjectSourceUploadRequest = {
  [M in ProjectSourceUploadMethod]: ProjectSourceUploadRequestFor<M>;
}[ProjectSourceUploadMethod];
export type ProjectSourceUploadResponseFor<
  R extends ProjectSourceUploadRequest,
> = R extends unknown
  ? {
      [M in ProjectSourceUploadMethod]: R["action"] extends (typeof PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS)[M]
        ? ProjectSourceUploadResponseMap[M]
        : never;
    }[ProjectSourceUploadMethod]
  : never;
export interface ProjectSourceUploadsCodec {
  parseRequest(input: unknown): ProjectSourceUploadRequest;
  parseResponse<R extends ProjectSourceUploadRequest>(
    input: unknown,
    expected: R,
  ): ProjectSourceUploadResponseFor<R>;
}
