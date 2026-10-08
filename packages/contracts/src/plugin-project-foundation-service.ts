/**
 * Portable independent project-foundation UI protocol. No SDK, domain or host imports.
 * Requests are business data only: installation, principal, project scope and raw source bytes
 * belong to the host. Registering this contract does not enable the service or grant access.
 */
export const CREWON_PROJECT_FOUNDATION_SERVICE = "crewon.project-foundation";
export const CREWON_PROJECT_FOUNDATION_API_VERSION = "1";
export const MAX_PROJECT_FOUNDATION_UI_INPUT_BYTES = 24 * 1024;
export const MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES = 60 * 1024;
// Even fully escaped, maximum-sized proposal text must fit this protocol's response budget.
export const MAX_PROJECT_FOUNDATION_PROPOSAL_PAGE_SIZE = 3;
export const MAX_PROJECT_SOURCE_UI_PAGE_SCALARS = 1024;
// Domain chapter pages allow 50; UI DTOs also carry titles and project identities.
export const MAX_PROJECT_SOURCE_UI_CHAPTER_PAGE_SIZE = 16;
export const PROJECT_FOUNDATION_UI_METHOD_ACTIONS = Object.freeze({
  createProject: "crewon.project-foundation.v1.createProject",
  getFoundation: "crewon.project-foundation.v1.getFoundation",
  updateParameters: "crewon.project-foundation.v1.updateParameters",
  appendSource: "crewon.project-foundation.v1.appendSource",
  getSource: "crewon.project-foundation.v1.getSource",
  readSourcePage: "crewon.project-foundation.v1.readSourcePage",
  listSourceChapters: "crewon.project-foundation.v1.listSourceChapters",
  saveProposal: "crewon.project-foundation.v1.saveProposal",
  confirmProposal: "crewon.project-foundation.v1.confirmProposal",
  chooseCreativeStartMode: "crewon.project-foundation.v1.chooseDirectScript",
  getProposal: "crewon.project-foundation.v1.getProposal",
  listProposals: "crewon.project-foundation.v1.listProposals",
} as const);
export type ProjectFoundationUiMethod =
  keyof typeof PROJECT_FOUNDATION_UI_METHOD_ACTIONS;
export type ProjectFoundationUiAction =
  (typeof PROJECT_FOUNDATION_UI_METHOD_ACTIONS)[ProjectFoundationUiMethod];
export const PROJECT_FOUNDATION_UI_ACTIONS = Object.freeze(
  Object.values(PROJECT_FOUNDATION_UI_METHOD_ACTIONS),
);
export const PROJECT_FOUNDATION_UI_MUTATION_ACTIONS = Object.freeze([
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS.createProject,
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS.updateParameters,
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS.appendSource,
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS.saveProposal,
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS.confirmProposal,
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS.chooseCreativeStartMode,
] as const);
export type ProjectFoundationMutationAction =
  (typeof PROJECT_FOUNDATION_UI_MUTATION_ACTIONS)[number];
export function isProjectFoundationUiAction(
  value: unknown,
): value is ProjectFoundationUiAction {
  return (
    typeof value === "string" &&
    PROJECT_FOUNDATION_UI_ACTIONS.some((a) => a === value)
  );
}
export function isProjectFoundationUiMutationAction(
  value: unknown,
): value is ProjectFoundationMutationAction {
  return (
    typeof value === "string" &&
    PROJECT_FOUNDATION_UI_MUTATION_ACTIONS.some((a) => a === value)
  );
}

export type ProjectFoundationOrigin = "creative" | "novel";
export type ProjectFoundationCreationParameters = Readonly<{
  genre: string | null;
  episodeMode: "single" | "series";
  episodeCount: number | null;
  episodeDurationSeconds: Readonly<{ minimum: number; maximum: number }> | null;
  aspectRatio: "16:9" | "9:16";
  visualStyle: "semi-realistic" | "hand-drawn" | null;
  needsCharacters: boolean;
  needsArt: boolean;
  adaptation: Readonly<{
    strategy: "faithful" | "core" | "reimagined";
    retainedCharacters: readonly string[];
    retainedScenes: readonly string[];
  }> | null;
}>;
export type ProjectFoundationRevisionPointer = Readonly<{
  revision: number;
  digest: string;
}>;
export type ProjectFoundationSourceUpload = Readonly<{
  uploadId: string;
  fileDigest: string;
}>;
export type PublicProjectFoundation = Readonly<{
  schemaVersion: "crewon.project-foundation.v1";
  projectId: string;
  origin: ProjectFoundationOrigin;
  revision: number;
  parametersRevision: number;
  parameters: ProjectFoundationCreationParameters;
  source: ProjectFoundationRevisionPointer | null;
  confirmedProposal: ProjectFoundationRevisionPointer | null;
  creativeStartMode: "confirm-plan" | "direct-script" | null;
  createdAt: string;
  updatedAt: string;
}>;
export type PublicProjectSource = Readonly<{
  schemaVersion: "crewon.project-source.v1";
  projectId: string;
  revision: number;
  digest: string;
  fileDigest: string;
  fileName: string;
  format: "txt" | "md" | "html";
  byteLength: number;
  characterLength: number;
  createdAt: string;
}>;
export type PublicProjectSourceChapter = Readonly<{
  projectId: string;
  sourceRevision: number;
  chapterId: string;
  title: string;
  startOffset: number;
  endOffset: number;
}>;
export type PublicProjectSourcePage = Readonly<{
  sourceRevision: number;
  startOffset: number;
  endOffset: number;
  content: string;
  nextOffset: number | null;
}>;
export type PublicProjectProposal = Readonly<{
  schemaVersion: "crewon.project-proposal.v1";
  projectId: string;
  revision: number;
  kind: "creative-plan" | "novel-adaptation";
  foundationRevision: number;
  parametersRevision: number;
  source: ProjectFoundationRevisionPointer | null;
  text: string;
  contentDigest: string;
  createdAt: string;
}>;
/** Original public project/brief shapes remain exact; foundation is a separate response field. */
export type FoundationPublicProject = Readonly<{
  projectId: string;
  kind: "short-drama";
  title: string;
  revision: number;
  state: "active" | "archived";
  latestBriefRevision: number;
  createdAt: string;
  updatedAt: string;
}>;
export type FoundationPublicBrief = Readonly<{
  projectId: string;
  briefRevision: number;
  text: string;
  contentDigest: string;
  createdAt: string;
}>;
export type ProjectFoundationMutationResponse = Readonly<{
  kind:
    | "create-project"
    | "update-parameters"
    | "append-source"
    | "save-proposal"
    | "confirm-proposal"
    | "choose-direct-script";
  disposition: "committed" | "replayed";
  project: FoundationPublicProject;
  foundation: PublicProjectFoundation;
  brief: FoundationPublicBrief | null;
  source: PublicProjectSource | null;
  proposal: PublicProjectProposal | null;
}>;

type ProjectQuery = Readonly<{ projectId: string }>;
type FoundationChange = ProjectQuery &
  Readonly<{
    expectedFoundationRevision: number;
    idempotencyKey: string;
  }>;
type SourceQuery = ProjectQuery & Readonly<{ sourceRevision: number }>;
export type ProjectFoundationUiInputMap = {
  createProject: Readonly<{
    title: string;
    briefText: string;
    origin: ProjectFoundationOrigin;
    parameters: ProjectFoundationCreationParameters;
    creativeStartMode: "confirm-plan" | "direct-script" | null;
    sourceUpload: ProjectFoundationSourceUpload | null;
    idempotencyKey: string;
  }>;
  getFoundation: ProjectQuery;
  updateParameters: FoundationChange &
    Readonly<{ parameters: ProjectFoundationCreationParameters }>;
  appendSource: FoundationChange &
    Readonly<{ sourceUpload: ProjectFoundationSourceUpload }>;
  getSource: SourceQuery;
  readSourcePage: SourceQuery &
    Readonly<{ sourceDigest: string; startOffset: number; limit: number }>;
  listSourceChapters: SourceQuery &
    Readonly<{
      sourceDigest: string;
      afterStartOffset: number | null;
      limit: number;
    }>;
  saveProposal: FoundationChange &
    Readonly<{
      expectedProposalRevision: number;
      kind: "creative-plan" | "novel-adaptation";
      text: string;
    }>;
  confirmProposal: FoundationChange &
    Readonly<{ proposalRevision: number; proposalDigest: string }>;
  chooseCreativeStartMode: FoundationChange &
    Readonly<{ creativeStartMode: "confirm-plan" | "direct-script" }>;
  getProposal: ProjectQuery & Readonly<{ proposalRevision: number }>;
  listProposals: ProjectQuery &
    Readonly<{ afterProposalRevision: number; limit: number }>;
};
export type ProjectFoundationUiResponseMap = {
  createProject: ProjectFoundationMutationResponse;
  getFoundation: Readonly<{ foundation: PublicProjectFoundation | null }>;
  updateParameters: ProjectFoundationMutationResponse;
  appendSource: ProjectFoundationMutationResponse;
  getSource: Readonly<{ source: PublicProjectSource | null }>;
  readSourcePage: Readonly<{ page: PublicProjectSourcePage }>;
  listSourceChapters: Readonly<{
    chapters: readonly PublicProjectSourceChapter[];
    nextStartOffset: number | null;
  }>;
  saveProposal: ProjectFoundationMutationResponse;
  confirmProposal: ProjectFoundationMutationResponse;
  chooseCreativeStartMode: ProjectFoundationMutationResponse;
  getProposal: Readonly<{ proposal: PublicProjectProposal | null }>;
  listProposals: Readonly<{
    proposals: readonly PublicProjectProposal[];
    nextRevision: number | null;
  }>;
};
export type ProjectFoundationUiRequestFor<M extends ProjectFoundationUiMethod> =
  Readonly<{
    action: (typeof PROJECT_FOUNDATION_UI_METHOD_ACTIONS)[M];
    input: ProjectFoundationUiInputMap[M];
  }>;
export type ProjectFoundationUiRequest = {
  [M in ProjectFoundationUiMethod]: ProjectFoundationUiRequestFor<M>;
}[ProjectFoundationUiMethod];
export type ProjectFoundationUiResponse =
  ProjectFoundationUiResponseMap[ProjectFoundationUiMethod];
export type ProjectFoundationUiResponseFor<
  R extends ProjectFoundationUiRequest,
> = R extends unknown
  ? {
      [M in ProjectFoundationUiMethod]: R["action"] extends (typeof PROJECT_FOUNDATION_UI_METHOD_ACTIONS)[M]
        ? ProjectFoundationUiResponseMap[M]
        : never;
    }[ProjectFoundationUiMethod]
  : never;
export interface ProjectFoundationUiCodec {
  parseRequest(input: unknown): ProjectFoundationUiRequest;
  parseResponse<R extends ProjectFoundationUiRequest>(
    input: unknown,
    expected: R,
  ): ProjectFoundationUiResponseFor<R>;
}
