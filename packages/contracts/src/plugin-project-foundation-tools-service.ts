import type {
  ProjectFoundationRevisionPointer,
  PublicProjectFoundation,
  PublicProjectSource,
  PublicProjectSourceChapter,
} from "./plugin-project-foundation-service.ts";

/** Independent portable Node ABI. Live command identity is enforced by the original Worker. */
export const CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE =
  "crewon.project-foundation-tools";
export const CREWON_PROJECT_FOUNDATION_TOOLS_API_VERSION = "1";
export const MAX_PROJECT_FOUNDATION_TOOLS_INPUT_BYTES = 24 * 1024;
export const MAX_PROJECT_FOUNDATION_TOOLS_RESPONSE_BYTES = 32 * 1024;
export const MAX_PROJECT_FOUNDATION_TOOLS_SCOPE_BYTES = 8192;
export const MAX_PROJECT_FOUNDATION_TOOLS_PAGE_SCALARS = 1024;
export const MAX_PROJECT_FOUNDATION_TOOLS_CHAPTER_PAGE_SIZE = 16;
export const MAX_PROJECT_FOUNDATION_TOOLS_PROPOSAL_PAGE_SIZE = 4;
export const PROJECT_FOUNDATION_TOOL_OPERATIONS = Object.freeze({
  readScope: "foundation_scope",
  getFoundation: "foundation_read",
  getSource: "foundation_source",
  readSourcePage: "foundation_source_page",
  listSourceChapters: "foundation_chapters",
  getProposal: "foundation_proposal",
  listProposals: "foundation_proposals",
  saveProposal: "foundation_proposal_save",
} as const);
export type ProjectFoundationToolsMethod =
  keyof typeof PROJECT_FOUNDATION_TOOL_OPERATIONS;
export type ProjectFoundationToolsOperation =
  (typeof PROJECT_FOUNDATION_TOOL_OPERATIONS)[ProjectFoundationToolsMethod];
export const PROJECT_FOUNDATION_TOOL_OPERATION_IDS = Object.freeze(
  Object.values(PROJECT_FOUNDATION_TOOL_OPERATIONS),
);
export const PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS = Object.freeze({
  foundation_scope: MAX_PROJECT_FOUNDATION_TOOLS_SCOPE_BYTES,
  foundation_read: MAX_PROJECT_FOUNDATION_TOOLS_RESPONSE_BYTES,
  foundation_source: 8192,
  foundation_source_page: 8192,
  foundation_chapters: MAX_PROJECT_FOUNDATION_TOOLS_RESPONSE_BYTES,
  foundation_proposal: 8192,
  foundation_proposals: 8192,
  foundation_proposal_save: 8192,
} as const);
export type ProjectFoundationToolsInvocation<T> = Readonly<{
  /** Forward the original execution command object. A copy or JSON DTO is not authority. */
  command: unknown;
  request: T;
}>;

/** Bounded data hints only. Owner, installation, policy callbacks and private markers stay host-owned. */
export type PublicProjectFoundationRunScope = Readonly<{
  projectId: string;
  threadId: string;
  runId: string;
  bindingId: string;
  bindingRevision: number;
  foundationRevision: number;
  parametersRevision: number;
  parametersDigest: string;
  source: ProjectFoundationRevisionPointer | null;
  confirmedProposal: ProjectFoundationRevisionPointer | null;
  latestProposal: ProjectFoundationRevisionPointer | null;
  allowedOperations: readonly ProjectFoundationToolsOperation[];
  contentDigest: string;
}>;
export type ProjectFoundationToolsProposalMetadata = Readonly<{
  schemaVersion: "crewon.project-proposal.v1";
  projectId: string;
  revision: number;
  kind: "creative-plan" | "novel-adaptation";
  foundationRevision: number;
  parametersRevision: number;
  source: ProjectFoundationRevisionPointer | null;
  contentDigest: string;
  characterLength: number;
  createdAt: string;
}>;
/** Scalar offsets; concatenate pages for the same immutable digest without silent truncation. */
export type ProjectFoundationToolsTextPage = Readonly<{
  startOffset: number;
  endOffset: number;
  content: string;
  nextOffset: number | null;
  characterLength: number;
}>;
type ProjectQuery = Readonly<{ projectId: string }>;
type SourceQuery = ProjectQuery &
  Readonly<{ sourceRevision: number; sourceDigest: string }>;
export type ProjectFoundationToolsInputMap = {
  readScope: Readonly<Record<string, never>>;
  getFoundation: ProjectQuery &
    Readonly<{ parametersStartOffset?: number; parametersLimit?: number }>;
  getSource: SourceQuery;
  readSourcePage: SourceQuery &
    Readonly<{ startOffset: number; limit: number }>;
  listSourceChapters: SourceQuery &
    Readonly<{ afterStartOffset?: number; limit: number }>;
  getProposal: ProjectQuery &
    Readonly<{
      proposalRevision: number;
      proposalDigest: string;
      startOffset: number;
      limit: number;
    }>;
  listProposals: ProjectQuery &
    Readonly<{ afterProposalRevision: number; limit: number }>;
  /** The host derives retry identity from the genuine original Tool receipt. Never confirms a candidate. */
  saveProposal: ProjectQuery &
    Readonly<{
      expectedFoundationRevision: number;
      expectedProposalRevision: number;
      kind: "creative-plan" | "novel-adaptation";
      text: string;
    }>;
};
export type ProjectFoundationToolsResponseMap = {
  readScope: Readonly<{ scope: PublicProjectFoundationRunScope }>;
  getFoundation: Readonly<{ foundation: PublicProjectFoundation }>;
  getSource: Readonly<{ source: PublicProjectSource }>;
  readSourcePage: Readonly<{
    sourceRevision: number;
    sourceDigest: string;
    page: ProjectFoundationToolsTextPage;
  }>;
  listSourceChapters: Readonly<{
    chapters: readonly PublicProjectSourceChapter[];
    nextStartOffset: number | null;
  }>;
  getProposal:
    | Readonly<{
        proposal: ProjectFoundationToolsProposalMetadata;
        page: ProjectFoundationToolsTextPage;
      }>
    | Readonly<{ proposal: null; page: null }>;
  listProposals: Readonly<{
    proposals: readonly ProjectFoundationToolsProposalMetadata[];
    nextRevision: number | null;
  }>;
  saveProposal: Readonly<{
    kind: "save-proposal";
    disposition: "committed" | "replayed";
    /** Saving a candidate leaves this Foundation revision unchanged. */
    foundationRevision: number;
    proposal: ProjectFoundationToolsProposalMetadata;
  }>;
};
export type ProjectFoundationToolsRequestFor<
  M extends ProjectFoundationToolsMethod,
> = Readonly<{
  operation: (typeof PROJECT_FOUNDATION_TOOL_OPERATIONS)[M];
  request: ProjectFoundationToolsInputMap[M];
}>;
export type ProjectFoundationToolsRequest = {
  [M in ProjectFoundationToolsMethod]: ProjectFoundationToolsRequestFor<M>;
}[ProjectFoundationToolsMethod];
export type ProjectFoundationToolsResponseFor<
  R extends ProjectFoundationToolsRequest,
> = R extends unknown
  ? {
      [M in ProjectFoundationToolsMethod]: R["operation"] extends (typeof PROJECT_FOUNDATION_TOOL_OPERATIONS)[M]
        ? ProjectFoundationToolsResponseMap[M]
        : never;
    }[ProjectFoundationToolsMethod]
  : never;
export type PluginProjectFoundationToolsService = Readonly<{
  [M in ProjectFoundationToolsMethod]: (
    input: ProjectFoundationToolsInvocation<ProjectFoundationToolsInputMap[M]>,
  ) => Promise<ProjectFoundationToolsResponseMap[M]>;
}>;
export interface ProjectFoundationToolsCodec {
  parseRequest(input: unknown): ProjectFoundationToolsRequest;
  parseResponse<R extends ProjectFoundationToolsRequest>(
    input: unknown,
    expected: R,
  ): ProjectFoundationToolsResponseFor<R>;
}
