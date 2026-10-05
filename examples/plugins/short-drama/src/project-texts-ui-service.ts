/** Portable public UI protocol. This file has no imports and does not change SDK v1. */
export const CREWON_PROJECT_TEXTS_SERVICE = "crewon.project-texts";
export const CREWON_PROJECT_TEXTS_API_VERSION = "1";
export const MAX_PROJECT_TEXT_UI_INPUT_BYTES = 60 * 1024;
export const MAX_PROJECT_TEXT_UI_RESPONSE_BYTES = 60 * 1024;
export const PROJECT_TEXT_UI_METHOD_ACTIONS = Object.freeze({
  getOutline: "crewon.project-texts.v1.getOutline",
  getScript: "crewon.project-texts.v1.getScript",
  getArtifact: "crewon.project-texts.v1.getArtifact",
  getRevision: "crewon.project-texts.v1.getRevision",
  listArtifacts: "crewon.project-texts.v1.listArtifacts",
  listRevisions: "crewon.project-texts.v1.listRevisions",
  saveOutlineCandidate: "crewon.project-texts.v1.saveOutlineCandidate",
  saveScriptCandidate: "crewon.project-texts.v1.saveScriptCandidate",
  selectRevision: "crewon.project-texts.v1.selectRevision",
  setLocked: "crewon.project-texts.v1.setLocked",
} as const);
export type ProjectTextUiMethod = keyof typeof PROJECT_TEXT_UI_METHOD_ACTIONS;
export type ProjectTextUiAction =
  (typeof PROJECT_TEXT_UI_METHOD_ACTIONS)[ProjectTextUiMethod];
export const PROJECT_TEXT_UI_ACTIONS = Object.freeze(
  Object.values(PROJECT_TEXT_UI_METHOD_ACTIONS),
);
export const PROJECT_TEXT_UI_MUTATION_ACTIONS = Object.freeze([
  PROJECT_TEXT_UI_METHOD_ACTIONS.saveOutlineCandidate,
  PROJECT_TEXT_UI_METHOD_ACTIONS.saveScriptCandidate,
  PROJECT_TEXT_UI_METHOD_ACTIONS.selectRevision,
  PROJECT_TEXT_UI_METHOD_ACTIONS.setLocked,
] as const);
export type ProjectTextUiMutationAction =
  (typeof PROJECT_TEXT_UI_MUTATION_ACTIONS)[number];
export function isProjectTextUiAction(
  action: unknown,
): action is ProjectTextUiAction {
  return (
    typeof action === "string" &&
    PROJECT_TEXT_UI_ACTIONS.some((value) => value === action)
  );
}
export function isProjectTextUiMutationAction(
  action: unknown,
): action is ProjectTextUiMutationAction {
  return (
    typeof action === "string" &&
    PROJECT_TEXT_UI_MUTATION_ACTIONS.some((value) => value === action)
  );
}
export function isProjectTextUiNamespaceAction(action: unknown): boolean {
  return (
    typeof action === "string" &&
    (action === CREWON_PROJECT_TEXTS_SERVICE ||
      action.startsWith(`${CREWON_PROJECT_TEXTS_SERVICE}.`))
  );
}
/** Unknown actions keep the existing budget; merely claiming a namespace grants nothing. */
export function pluginUiActionInputMaximumBytes(action: unknown): number {
  return isProjectTextUiAction(action)
    ? MAX_PROJECT_TEXT_UI_INPUT_BYTES
    : 24 * 1024;
}

export type ProjectTextOutlineContent = Readonly<{
  title: string;
  logline: string;
  synopsis: string;
  episodes: readonly Readonly<{
    episodeId: string;
    title: string;
    summary: string;
  }>[];
}>;
export type ProjectTextScriptContent = Readonly<{
  title: string;
  scenes: readonly Readonly<{
    sceneId: string;
    location: string;
    timeOfDay: string;
    action: string;
    dialogue: readonly Readonly<{ speaker: string; text: string }>[];
  }>[];
}>;
export type PublicProjectTextArtifact = Readonly<{
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
type RevisionCommon = Readonly<{
  projectId: string;
  artifactId: string;
  contentRevision: number;
  brief: Readonly<{ briefRevision: number; contentDigest: string }>;
  contentDigest: string;
  createdAt: string;
}>;
export type PublicProjectTextRevision = RevisionCommon &
  (
    | Readonly<{
        kind: "outline";
        episodeId: null;
        outline: null;
        content: ProjectTextOutlineContent;
      }>
    | Readonly<{
        kind: "script";
        episodeId: string;
        outline: Readonly<{
          artifactId: string;
          contentRevision: number;
          contentDigest: string;
        }> | null;
        content: ProjectTextScriptContent;
      }>
  );
export type PublicProjectTextArtifactView = Readonly<{
  artifact: PublicProjectTextArtifact;
  selectedRevision: PublicProjectTextRevision | null;
  dependencyState: "unselected" | "current" | "stale";
  staleReasons: readonly ("brief-changed" | "outline-selection-changed")[];
}>;
export type ProjectTextMutationResponse = Readonly<{
  kind: "save-outline" | "save-script" | "select-revision" | "set-lock";
  disposition: "committed" | "replayed";
  artifact: PublicProjectTextArtifact;
  contentRevision: PublicProjectTextRevision | null;
}>;
export type SaveProjectOutlineCandidateRequest = Readonly<{
  expectedArtifactRevision: number;
  briefRevision: number;
  content: ProjectTextOutlineContent;
}>;
export type SaveProjectScriptCandidateRequest = Readonly<{
  expectedArtifactRevision: number;
  briefRevision: number;
  outline: Readonly<{ artifactId: string; contentRevision: number }> | null;
  content: ProjectTextScriptContent;
}>;
export type SelectProjectTextRevisionRequest = Readonly<{
  expectedArtifactRevision: number;
  contentRevision: number;
}>;
export type SetProjectTextArtifactLockedRequest = Readonly<{
  expectedArtifactRevision: number;
  locked: boolean;
}>;
type ProjectQuery = Readonly<{ projectId: string }>;
type ArtifactQuery = ProjectQuery & Readonly<{ artifactId: string }>;
export type ProjectTextUiInputMap = Readonly<{
  "crewon.project-texts.v1.getOutline": ProjectQuery;
  "crewon.project-texts.v1.getScript": ProjectQuery &
    Readonly<{ episodeId: string }>;
  "crewon.project-texts.v1.getArtifact": ArtifactQuery;
  "crewon.project-texts.v1.getRevision": ArtifactQuery &
    Readonly<{ contentRevision: number }>;
  "crewon.project-texts.v1.listArtifacts": ProjectQuery &
    Readonly<{ afterArtifactId: string | null; limit: number }>;
  "crewon.project-texts.v1.listRevisions": ArtifactQuery &
    Readonly<{ afterContentRevision: number; limit: number }>;
  "crewon.project-texts.v1.saveOutlineCandidate": ProjectQuery &
    Readonly<{
      request: SaveProjectOutlineCandidateRequest;
      idempotencyKey: string;
    }>;
  "crewon.project-texts.v1.saveScriptCandidate": ProjectQuery &
    Readonly<{
      episodeId: string;
      request: SaveProjectScriptCandidateRequest;
      idempotencyKey: string;
    }>;
  "crewon.project-texts.v1.selectRevision": ArtifactQuery &
    Readonly<{
      request: SelectProjectTextRevisionRequest;
      idempotencyKey: string;
    }>;
  "crewon.project-texts.v1.setLocked": ArtifactQuery &
    Readonly<{
      request: SetProjectTextArtifactLockedRequest;
      idempotencyKey: string;
    }>;
}>;
type ViewResponse = Readonly<{ view: PublicProjectTextArtifactView | null }>;
export type ProjectTextUiResponseMap = Readonly<{
  "crewon.project-texts.v1.getOutline": ViewResponse;
  "crewon.project-texts.v1.getScript": ViewResponse;
  "crewon.project-texts.v1.getArtifact": ViewResponse;
  "crewon.project-texts.v1.getRevision": Readonly<{
    contentRevision: PublicProjectTextRevision;
  }>;
  "crewon.project-texts.v1.listArtifacts": Readonly<{
    artifacts: readonly PublicProjectTextArtifact[];
    nextArtifactId: string | null;
  }>;
  "crewon.project-texts.v1.listRevisions": Readonly<{
    revisions: readonly PublicProjectTextRevision[];
    nextContentRevision: number | null;
  }>;
  "crewon.project-texts.v1.saveOutlineCandidate": ProjectTextMutationResponse;
  "crewon.project-texts.v1.saveScriptCandidate": ProjectTextMutationResponse;
  "crewon.project-texts.v1.selectRevision": ProjectTextMutationResponse;
  "crewon.project-texts.v1.setLocked": ProjectTextMutationResponse;
}>;
export type ProjectTextUiActionRequest = {
  [A in ProjectTextUiAction]: Readonly<{
    action: A;
    input: ProjectTextUiInputMap[A];
  }>;
}[ProjectTextUiAction];
export type ProjectTextUiRequestOptions = Readonly<{ signal?: AbortSignal }>;
export type ProjectTextUiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectTextUiJsonValue[]
  | Readonly<{ [key: string]: ProjectTextUiJsonValue }>;
export interface PluginProjectTextUiServices {
  invoke(
    action: string,
    input: ProjectTextUiJsonValue,
    options: ProjectTextUiRequestOptions,
  ): Promise<ProjectTextUiJsonValue>;
}
/** Bundle the independent public codec, without modifying or rebuilding the frozen SDK. */
export interface ProjectTextUiCodec {
  parseRequest(input: unknown): ProjectTextUiActionRequest;
  parseResponse(
    request: ProjectTextUiActionRequest,
    input: unknown,
  ): ProjectTextUiResponseMap[ProjectTextUiAction];
}
export type PluginProjectTextUiClient = Readonly<{
  [M in ProjectTextUiMethod]: (
    input: ProjectTextUiInputMap[(typeof PROJECT_TEXT_UI_METHOD_ACTIONS)[M]],
    options?: ProjectTextUiRequestOptions,
  ) => Promise<
    ProjectTextUiResponseMap[(typeof PROJECT_TEXT_UI_METHOD_ACTIONS)[M]]
  >;
}>;

/** Capture the dispatcher and strict codec once. There is no automatic mutation retry. */
export function createPluginProjectTextUiClient(
  services: PluginProjectTextUiServices,
  codec: ProjectTextUiCodec,
): PluginProjectTextUiClient {
  const invoke = method(services, "invoke").bind(
    services,
  ) as PluginProjectTextUiServices["invoke"];
  const parseRequest = method(codec, "parseRequest").bind(
    codec,
  ) as ProjectTextUiCodec["parseRequest"];
  const parseResponse = method(codec, "parseResponse").bind(
    codec,
  ) as ProjectTextUiCodec["parseResponse"];
  const entries = Object.entries(PROJECT_TEXT_UI_METHOD_ACTIONS).map(
    ([name, action]) => [
      name,
      async (input: unknown, options: ProjectTextUiRequestOptions = {}) => {
        const descriptors = Object.getOwnPropertyDescriptors(options);
        if (
          Reflect.ownKeys(options).some((key) => key !== "signal") ||
          (descriptors.signal !== undefined &&
            (!Object.hasOwn(descriptors.signal, "value") ||
              !descriptors.signal.enumerable))
        )
          invalidClient();
        const signal = descriptors.signal?.value as AbortSignal | undefined;
        if (signal !== undefined && !(signal instanceof AbortSignal))
          invalidClient();
        if (signal?.aborted)
          throw new DOMException("The operation was aborted", "AbortError");
        const request = parseRequest({ action, input });
        const output = await invoke(
          request.action,
          request.input as unknown as ProjectTextUiJsonValue,
          signal === undefined ? {} : { signal },
        );
        if (signal?.aborted)
          throw new DOMException("The operation was aborted", "AbortError");
        return parseResponse(request, output);
      },
    ],
  );
  return Object.freeze(
    Object.fromEntries(entries),
  ) as PluginProjectTextUiClient;
}
function method(input: object, key: string): (...args: never[]) => unknown {
  if (input === null || typeof input !== "object") invalidClient();
  let owner: object | null = input;
  for (
    let depth = 0;
    owner !== null && depth < 16;
    depth++, owner = Object.getPrototypeOf(owner)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor === undefined) continue;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      invalidClient();
    return descriptor.value;
  }
  return invalidClient();
}
function invalidClient(): never {
  throw new Error("plugin_project_text_ui_client_invalid");
}
