/**
 * Portable, independent Node service protocol. It deliberately has no imports
 * from the SDK, application, store or HTTP schemas. Plugin developers may vendor
 * this public file; the example verifies its copy byte for byte at build time.
 * A command is opaque host evidence, never JSON authorization. Only a live
 * Worker dispatch may call these methods; setup and copied commands are denied.
 */
export const CREWON_PROJECT_TOOLS_SERVICE = "crewon.project-tools";
export const CREWON_PROJECT_TOOLS_API_VERSION = "1";
export const MAX_PROJECT_TOOLS_RESPONSE_BYTES = 8192;
export const MAX_PROJECT_TOOLS_PAGE_SIZE = 4;
export const PROJECT_TOOLS_CONTENT_CHUNK_CODE_POINTS = 1024;

export const PROJECT_TOOL_OPERATIONS = Object.freeze({
  listProjects: "project_list",
  readProject: "project_read",
  createProject: "project_create",
  appendBrief: "brief_append",
  readOutline: "outline_read",
  readScript: "script_read",
  readContent: "content_read",
  listRevisions: "text_history",
  saveOutlineCandidate: "outline_save",
  saveScriptCandidate: "script_save",
  selectRevision: "text_select",
  setLocked: "text_lock",
} as const);
export type ProjectToolsMethod = keyof typeof PROJECT_TOOL_OPERATIONS;
export type ProjectToolsInvocation<T> = Readonly<{
  /** Forward the actual execution command object; constructing a DTO grants nothing. */
  command: unknown;
  request: T;
}>;
export type ProjectToolsProject = Readonly<{
  projectId: string;
  kind: "short-drama";
  title: string;
  revision: number;
  state: "active" | "archived";
  latestBriefRevision: number;
  createdAt: string;
  updatedAt: string;
}>;
export type ProjectToolsBriefMetadata = Readonly<{
  projectId: string;
  briefRevision: number;
  contentDigest: string;
  createdAt: string;
}>;
export type ProjectToolsArtifact = Readonly<{
  projectId: string;
  artifactId: string;
  revision: number;
  latestContentRevision: number;
  selectedContentRevision: number | null;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}> &
  (
    | Readonly<{ kind: "outline"; episodeId: null }>
    | Readonly<{ kind: "script"; episodeId: string }>
  );
export type ProjectToolsRevisionMetadata = Readonly<{
  projectId: string;
  artifactId: string;
  contentRevision: number;
  brief: Readonly<{ briefRevision: number; contentDigest: string }>;
  contentDigest: string;
  createdAt: string;
}> &
  (
    | Readonly<{ kind: "outline"; episodeId: null; outline: null }>
    | Readonly<{
        kind: "script";
        episodeId: string;
        outline: Readonly<{
          artifactId: string;
          contentRevision: number;
          contentDigest: string;
        }> | null;
      }>
  );
export type ProjectToolsArtifactView = Readonly<{
  artifact: ProjectToolsArtifact;
  selectedRevision: ProjectToolsRevisionMetadata | null;
  dependencyState: "unselected" | "current" | "stale";
  staleReasons: readonly ("brief-changed" | "outline-selection-changed")[];
}>;
export type ProjectToolsOutlineContent = Readonly<{
  title: string;
  logline: string;
  synopsis: string;
  episodes: readonly Readonly<{
    episodeId: string;
    title: string;
    summary: string;
  }>[];
}>;
export type ProjectToolsScriptContent = Readonly<{
  title: string;
  scenes: readonly Readonly<{
    sceneId: string;
    location: string;
    timeOfDay: string;
    action: string;
    dialogue: readonly Readonly<{ speaker: string; text: string }>[];
  }>[];
}>;
export type ProjectToolsContentSource =
  | Readonly<{ kind: "brief"; briefRevision: number }>
  | Readonly<{ kind: "text"; artifactId: string; contentRevision: number }>;
export type ProjectToolsContentChunk = Readonly<{
  contentDigest: string;
  format: "text" | "canonical-json";
  /** Unicode scalar offsets, never byte offsets or UTF-16 offsets. */
  offset: number;
  nextOffset: number | null;
  totalCodePoints: number;
  /** Concatenate every page for this exact immutable source; no silent truncation. */
  text: string;
}>;
export type ProjectToolsTextMutation = Readonly<{
  kind: "save-outline" | "save-script" | "select-revision" | "set-lock";
  disposition: "committed" | "replayed";
  artifact: ProjectToolsArtifact;
  /** Metadata only. A committed write never echoes the full creative content. */
  contentRevision: ProjectToolsRevisionMetadata | null;
}>;
export type ProjectToolsBriefMutation = Readonly<{
  kind: "create-project" | "append-brief";
  disposition: "committed" | "replayed";
  project: ProjectToolsProject;
  brief: ProjectToolsBriefMetadata;
}>;
export type ProjectToolsListRequest = Readonly<{
  state: "active" | "archived" | "all";
  after: Readonly<{ updatedAt: string; projectId: string }> | null;
  /** 1 through 4. */
  limit: number;
}>;
export type ProjectToolsSaveOutlineRequest = Readonly<{
  projectId: string;
  expectedArtifactRevision: number;
  briefRevision: number;
  content: ProjectToolsOutlineContent;
}>;
export type ProjectToolsSaveScriptRequest = Readonly<{
  projectId: string;
  episodeId: string;
  expectedArtifactRevision: number;
  briefRevision: number;
  outline: Readonly<{ artifactId: string; contentRevision: number }> | null;
  content: ProjectToolsScriptContent;
}>;

/** Actor, cancellation signal and retry identity always come from the host. */
export interface PluginProjectToolsService {
  listProjects(input: ProjectToolsInvocation<ProjectToolsListRequest>): Promise<
    Readonly<{
      projects: readonly ProjectToolsProject[];
      next: Readonly<{ updatedAt: string; projectId: string }> | null;
    }>
  >;
  readProject(
    input: ProjectToolsInvocation<Readonly<{ projectId: string }>>,
  ): Promise<
    Readonly<{
      project: ProjectToolsProject;
      brief: ProjectToolsBriefMetadata | null;
    }>
  >;
  createProject(
    input: ProjectToolsInvocation<
      Readonly<{ title: string; briefText: string }>
    >,
  ): Promise<ProjectToolsBriefMutation>;
  appendBrief(
    input: ProjectToolsInvocation<
      Readonly<{
        projectId: string;
        expectedProjectRevision: number;
        text: string;
      }>
    >,
  ): Promise<ProjectToolsBriefMutation>;
  readOutline(
    input: ProjectToolsInvocation<Readonly<{ projectId: string }>>,
  ): Promise<Readonly<{ view: ProjectToolsArtifactView | null }>>;
  readScript(
    input: ProjectToolsInvocation<
      Readonly<{ projectId: string; episodeId: string }>
    >,
  ): Promise<Readonly<{ view: ProjectToolsArtifactView | null }>>;
  readContent(
    input: ProjectToolsInvocation<
      Readonly<{
        projectId: string;
        source: ProjectToolsContentSource;
        offset: number;
      }>
    >,
  ): Promise<ProjectToolsContentChunk>;
  listRevisions(
    input: ProjectToolsInvocation<
      Readonly<{
        projectId: string;
        artifactId: string;
        afterContentRevision: number;
        limit: number;
      }>
    >,
  ): Promise<
    Readonly<{
      revisions: readonly ProjectToolsRevisionMetadata[];
      nextContentRevision: number | null;
    }>
  >;
  saveOutlineCandidate(
    input: ProjectToolsInvocation<ProjectToolsSaveOutlineRequest>,
  ): Promise<ProjectToolsTextMutation>;
  saveScriptCandidate(
    input: ProjectToolsInvocation<ProjectToolsSaveScriptRequest>,
  ): Promise<ProjectToolsTextMutation>;
  selectRevision(
    input: ProjectToolsInvocation<
      Readonly<{
        projectId: string;
        artifactId: string;
        expectedArtifactRevision: number;
        contentRevision: number;
      }>
    >,
  ): Promise<ProjectToolsTextMutation>;
  setLocked(
    input: ProjectToolsInvocation<
      Readonly<{
        projectId: string;
        artifactId: string;
        expectedArtifactRevision: number;
        locked: boolean;
      }>
    >,
  ): Promise<ProjectToolsTextMutation>;
}
