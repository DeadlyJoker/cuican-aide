import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { ProjectMediaGenerationReference } from "./project-media-generation-port.ts";
import type {
  ProjectMediaItem,
  ProjectMediaWorkflow,
  ProjectMediaWorkflowReview,
} from "./project-media-input-port.ts";

/** Business selectors; callers never provide URLs, filenames or result bytes. */
export type ProjectMediaResultQuery = Readonly<{
  projectId: string;
  runId: string;
  resultIndex: number;
}>;
export type ProjectMediaResultRequest = Readonly<{
  actor: ActorContext;
  query: ProjectMediaResultQuery;
}>;
/** Compact immutable accepted history, with no credentials or current adopted pointers. */
export type ProjectMediaResultSource = Readonly<{
  schemaVersion: "crewon.project-media-result-source.v1";
  request: ProjectMediaResultRequest;
  reference: ProjectMediaGenerationReference;
  item: ProjectMediaItem;
  workflow: ProjectMediaWorkflow;
  targetIdentity: ProjectMediaWorkflowReview["targetIdentity"];
  configuration: Readonly<{
    revision: number;
    contentDigest: string;
    origin: string;
  }>;
  generationDigest: string;
  operationLinkDigest: string;
  operation: Readonly<{
    operationId: string;
    providerOperationId: string;
    revision: number;
    contentDigest: string;
  }>;
  image: Readonly<{
    filename: string;
    subfolder: string;
    type: "output";
    url: string;
  }>;
  contentDigest: string;
}>;
export type FrozenProjectMediaResult = Readonly<{
  schemaVersion: "crewon.project-media-result-frozen.v1";
  archiveId: string;
  materialId: string;
  requestDigest: string;
  request: ProjectMediaResultRequest;
  source: Readonly<{
    projection: ProjectMediaResultSource;
    byteDigest: string;
    byteLength: number;
    width: number;
    height: number;
    mediaType: "image/png";
    observedAt: string;
  }>;
}>;
export type FrozenProjectMediaResultContent = Readonly<{
  record: FrozenProjectMediaResult;
  bytes: Uint8Array;
}>;
export interface ProjectMediaResultArchivePort {
  readonly archiveId: string;
  load(
    request: ProjectMediaResultRequest,
  ): Promise<FrozenProjectMediaResultContent | null>;
  save(input: FrozenProjectMediaResultContent): Promise<
    Readonly<{
      disposition: "created" | "replayed";
      record: FrozenProjectMediaResult;
    }>
  >;
}
/** Saving a candidate never adopts it or changes upstream project pointers. */
export type ProjectMediaResultCandidate = Readonly<{
  schemaVersion: "crewon.project-media-result-candidate.v1";
  candidateId: string;
  frozen: FrozenProjectMediaResult;
  contentDigest: string;
}>;
export type ProjectMediaResultPermission = Readonly<{
  actor: ActorContext;
  action: "projectMediaResult:read" | "projectMediaResult:publish";
  resource: ProjectMediaResultQuery;
}>;
export interface ProjectMediaResultAuthorizationPort {
  authorize(
    input: ProjectMediaResultPermission,
  ): Promise<AuthorizationDecision>;
  assertActive(input: ProjectMediaResultPermission): void;
}
export type ProjectMediaResultAuthority = Readonly<{
  request: ProjectMediaResultRequest;
  action: "read" | "publish";
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
export interface ProjectMediaResultStore {
  /** Native project state check before fetching a new result; existing candidates may replay after archive. */
  qualifyPublication(
    request: ProjectMediaResultRequest,
    authority: ProjectMediaResultAuthority,
  ): Promise<ProjectMediaResultSource>;
  loadSource(
    request: ProjectMediaResultRequest,
    authority: ProjectMediaResultAuthority,
  ): Promise<ProjectMediaResultSource>;
  loadCandidate(
    request: ProjectMediaResultRequest,
    authority: ProjectMediaResultAuthority,
  ): Promise<ProjectMediaResultCandidate | null>;
  saveCandidate(
    candidate: ProjectMediaResultCandidate,
    authority: ProjectMediaResultAuthority,
  ): Promise<
    Readonly<{
      disposition: "created" | "replayed";
      candidate: ProjectMediaResultCandidate;
    }>
  >;
}
