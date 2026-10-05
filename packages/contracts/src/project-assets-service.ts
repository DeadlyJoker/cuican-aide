/** Independent portable protocol. No imports, credentials or extensions of SDK v1. */
export const CREWON_PROJECT_ASSETS_SERVICE = "crewon.project-assets";
export const CREWON_PROJECT_ASSETS_API_VERSION = "1";
export const MAX_PROJECT_ASSET_UI_INPUT_BYTES = 24 * 1024;
export const MAX_PROJECT_ASSET_UI_RESPONSE_BYTES = 60 * 1024;
export const MAX_PROJECT_ASSET_PAGE_SIZE = 16;
export const PROJECT_ASSET_UI_METHOD_ACTIONS = Object.freeze({
  getAsset: "crewon.project-assets.v1.getAsset",
  getRevision: "crewon.project-assets.v1.getRevision",
  getReferenceRevision: "crewon.project-assets.v1.getReferenceRevision",
  listAssets: "crewon.project-assets.v1.listAssets",
  listRevisions: "crewon.project-assets.v1.listRevisions",
  listReferences: "crewon.project-assets.v1.listReferences",
  saveCandidate: "crewon.project-assets.v1.saveCandidate",
  selectRevision: "crewon.project-assets.v1.selectRevision",
  setLocked: "crewon.project-assets.v1.setLocked",
  saveReferenceCandidate: "crewon.project-assets.v1.saveReferenceCandidate",
  selectReference: "crewon.project-assets.v1.selectReference",
} as const);
export type ProjectAssetUiMethod = keyof typeof PROJECT_ASSET_UI_METHOD_ACTIONS;
export type ProjectAssetUiAction =
  (typeof PROJECT_ASSET_UI_METHOD_ACTIONS)[ProjectAssetUiMethod];
export const PROJECT_ASSET_UI_ACTIONS = Object.freeze(
  Object.values(PROJECT_ASSET_UI_METHOD_ACTIONS),
);
export const PROJECT_ASSET_UI_MUTATION_ACTIONS = Object.freeze([
  PROJECT_ASSET_UI_METHOD_ACTIONS.saveCandidate,
  PROJECT_ASSET_UI_METHOD_ACTIONS.selectRevision,
  PROJECT_ASSET_UI_METHOD_ACTIONS.setLocked,
  PROJECT_ASSET_UI_METHOD_ACTIONS.saveReferenceCandidate,
  PROJECT_ASSET_UI_METHOD_ACTIONS.selectReference,
] as const);
export type ProjectAssetUiMutationAction =
  (typeof PROJECT_ASSET_UI_MUTATION_ACTIONS)[number];
export function isProjectAssetUiAction(
  input: unknown,
): input is ProjectAssetUiAction {
  return (
    typeof input === "string" &&
    PROJECT_ASSET_UI_ACTIONS.some((value) => value === input)
  );
}
export function isProjectAssetUiMutationAction(
  input: unknown,
): input is ProjectAssetUiMutationAction {
  return (
    typeof input === "string" &&
    PROJECT_ASSET_UI_MUTATION_ACTIONS.some((value) => value === input)
  );
}
export function isProjectAssetUiNamespaceAction(input: unknown): boolean {
  return (
    typeof input === "string" &&
    (input === CREWON_PROJECT_ASSETS_SERVICE ||
      input.startsWith(`${CREWON_PROJECT_ASSETS_SERVICE}.`))
  );
}
export type ProjectAssetKind = "character" | "scene" | "prop";
export type ProjectAssetContent = Readonly<{
  name: string;
  setting: string;
  visualPrompt: string;
}>;
export type PublicProjectAsset = Readonly<{
  projectId: string;
  assetId: string;
  kind: ProjectAssetKind;
  revision: number;
  latestContentRevision: number;
  selectedContentRevision: number | null;
  latestReferenceRevision: number;
  selectedReferenceRevision: number | null;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}>;
export type PublicProjectAssetRevision = Readonly<{
  projectId: string;
  assetId: string;
  kind: ProjectAssetKind;
  contentRevision: number;
  brief: Readonly<{ briefRevision: number; contentDigest: string }>;
  script: Readonly<{
    artifactId: string;
    episodeId: string;
    contentRevision: number;
    contentDigest: string;
  }> | null;
  content: ProjectAssetContent;
  createdAt: string;
  contentDigest: string;
}>;
/** Read-only metadata, never a proof supplied with a write command or an image-byte hash. */
export type PublicProjectAssetImageSource = Readonly<{
  conceptAssetId: string;
  conceptAssetRevision: number;
  selectionRevision: number;
  conceptSelectionDigest: string;
  resultLinkDigest: string;
  generationLinkDigest: string;
  sourceRunId: string;
  sourceBindingDigest: string;
  pluginId: string;
  pluginVersion: string;
  packageDigest: string;
  configurationRevision: number;
  configurationDigest: string;
  operationId: string;
  operationRevision: number;
  operationDigest: string;
  rawResultDigest: string;
  resultIndex: number;
}>;
export type PublicProjectAssetReferenceRevision = Readonly<{
  projectId: string;
  assetId: string;
  referenceRevision: number;
  assetContentRevision: number;
  assetContentDigest: string;
  source: PublicProjectAssetImageSource;
  createdAt: string;
  contentDigest: string;
}>;
export type PublicProjectAssetView = Readonly<{
  asset: PublicProjectAsset;
  selectedContentRevision: PublicProjectAssetRevision | null;
  selectedReferenceRevision: PublicProjectAssetReferenceRevision | null;
  dependencyState: "unselected" | "current" | "stale";
  staleReasons: readonly (
    | "brief-changed"
    | "script-selection-changed"
    | "script-source-stale"
  )[];
  referenceState: "unselected" | "current" | "stale";
}>;
export type SaveProjectAssetCandidateRequest = Readonly<{
  kind: ProjectAssetKind;
  expectedAssetRevision: number;
  briefRevision: number;
  script: Readonly<{ artifactId: string; contentRevision: number }> | null;
  content: ProjectAssetContent;
}>;
export type SelectProjectAssetRevisionRequest = Readonly<{
  expectedAssetRevision: number;
  contentRevision: number;
}>;
export type SetProjectAssetLockedRequest = Readonly<{
  expectedAssetRevision: number;
  locked: boolean;
}>;
export type SaveProjectAssetReferenceCandidateRequest = Readonly<{
  expectedAssetRevision: number;
  assetContentRevision: number;
  conceptAssetId: string;
  selectionRevision: number;
}>;
export type SelectProjectAssetReferenceRequest = Readonly<{
  expectedAssetRevision: number;
  referenceRevision: number;
}>;
export type ProjectAssetMutationKind =
  | "save-content"
  | "select-content"
  | "set-lock"
  | "save-reference"
  | "select-reference";
export type ProjectAssetMutationResponse = Readonly<{
  kind: ProjectAssetMutationKind;
  disposition: "committed" | "replayed";
  asset: PublicProjectAsset;
  contentRevision: PublicProjectAssetRevision | null;
  referenceRevision: PublicProjectAssetReferenceRevision | null;
}>;
type ProjectQuery = Readonly<{ projectId: string }>;
type AssetQuery = ProjectQuery & Readonly<{ assetId: string }>;
export type ProjectAssetUiInputMap = Readonly<{
  "crewon.project-assets.v1.getAsset": AssetQuery;
  "crewon.project-assets.v1.getRevision": AssetQuery &
    Readonly<{ contentRevision: number }>;
  "crewon.project-assets.v1.getReferenceRevision": AssetQuery &
    Readonly<{ referenceRevision: number }>;
  "crewon.project-assets.v1.listAssets": ProjectQuery &
    Readonly<{ afterAssetId: string | null; limit: number }>;
  "crewon.project-assets.v1.listRevisions": AssetQuery &
    Readonly<{ afterContentRevision: number; limit: number }>;
  "crewon.project-assets.v1.listReferences": AssetQuery &
    Readonly<{ afterReferenceRevision: number; limit: number }>;
  "crewon.project-assets.v1.saveCandidate": ProjectQuery &
    Readonly<{
      assetId: string | null;
      request: SaveProjectAssetCandidateRequest;
      idempotencyKey: string;
    }>;
  "crewon.project-assets.v1.selectRevision": AssetQuery &
    Readonly<{
      request: SelectProjectAssetRevisionRequest;
      idempotencyKey: string;
    }>;
  "crewon.project-assets.v1.setLocked": AssetQuery &
    Readonly<{ request: SetProjectAssetLockedRequest; idempotencyKey: string }>;
  "crewon.project-assets.v1.saveReferenceCandidate": AssetQuery &
    Readonly<{
      request: SaveProjectAssetReferenceCandidateRequest;
      idempotencyKey: string;
    }>;
  "crewon.project-assets.v1.selectReference": AssetQuery &
    Readonly<{
      request: SelectProjectAssetReferenceRequest;
      idempotencyKey: string;
    }>;
}>;
export type ProjectAssetUiResponseMap = Readonly<{
  "crewon.project-assets.v1.getAsset": Readonly<{
    view: PublicProjectAssetView | null;
  }>;
  "crewon.project-assets.v1.getRevision": Readonly<{
    contentRevision: PublicProjectAssetRevision;
  }>;
  "crewon.project-assets.v1.getReferenceRevision": Readonly<{
    referenceRevision: PublicProjectAssetReferenceRevision;
  }>;
  "crewon.project-assets.v1.listAssets": Readonly<{
    assets: readonly PublicProjectAsset[];
    nextAssetId: string | null;
  }>;
  "crewon.project-assets.v1.listRevisions": Readonly<{
    revisions: readonly PublicProjectAssetRevision[];
    nextContentRevision: number | null;
  }>;
  "crewon.project-assets.v1.listReferences": Readonly<{
    references: readonly PublicProjectAssetReferenceRevision[];
    nextReferenceRevision: number | null;
  }>;
  "crewon.project-assets.v1.saveCandidate": ProjectAssetMutationResponse;
  "crewon.project-assets.v1.selectRevision": ProjectAssetMutationResponse;
  "crewon.project-assets.v1.setLocked": ProjectAssetMutationResponse;
  "crewon.project-assets.v1.saveReferenceCandidate": ProjectAssetMutationResponse;
  "crewon.project-assets.v1.selectReference": ProjectAssetMutationResponse;
}>;
export type ProjectAssetUiActionRequest = {
  [A in ProjectAssetUiAction]: Readonly<{
    action: A;
    input: ProjectAssetUiInputMap[A];
  }>;
}[ProjectAssetUiAction];
export type ProjectAssetUiRequestOptions = Readonly<{ signal?: AbortSignal }>;
export type ProjectAssetUiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectAssetUiJsonValue[]
  | Readonly<{ [key: string]: ProjectAssetUiJsonValue }>;
export interface ProjectAssetUiCodec {
  parseRequest(input: unknown): ProjectAssetUiActionRequest;
  parseResponse(
    request: ProjectAssetUiActionRequest,
    input: unknown,
  ): ProjectAssetUiResponseMap[ProjectAssetUiAction];
}
export interface PluginProjectAssetUiServices {
  invoke(
    action: string,
    input: ProjectAssetUiJsonValue,
    options: ProjectAssetUiRequestOptions,
  ): Promise<ProjectAssetUiJsonValue>;
}
export type PluginProjectAssetUiClient = Readonly<{
  [M in ProjectAssetUiMethod]: (
    input: ProjectAssetUiInputMap[(typeof PROJECT_ASSET_UI_METHOD_ACTIONS)[M]],
    options?: ProjectAssetUiRequestOptions,
  ) => Promise<
    ProjectAssetUiResponseMap[(typeof PROJECT_ASSET_UI_METHOD_ACTIONS)[M]]
  >;
}>;
/** Capture actual callbacks; neither this client nor its codec creates invocation authority. */
export function createPluginProjectAssetUiClient(
  services: PluginProjectAssetUiServices,
  codec: ProjectAssetUiCodec,
): PluginProjectAssetUiClient {
  const invoke = method(services, "invoke").bind(
      services,
    ) as PluginProjectAssetUiServices["invoke"],
    parseRequest = method(codec, "parseRequest").bind(
      codec,
    ) as ProjectAssetUiCodec["parseRequest"],
    parseResponse = method(codec, "parseResponse").bind(
      codec,
    ) as ProjectAssetUiCodec["parseResponse"];
  return Object.freeze(
    Object.fromEntries(
      Object.entries(PROJECT_ASSET_UI_METHOD_ACTIONS).map(([name, action]) => [
        name,
        async (input: unknown, options: ProjectAssetUiRequestOptions = {}) => {
          if (
            options === null ||
            typeof options !== "object" ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(options))
          )
            invalidClient();
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
          signal?.throwIfAborted();
          const request = parseRequest({ action, input });
          const result = await invoke(
            request.action,
            request.input as unknown as ProjectAssetUiJsonValue,
            signal === undefined ? {} : { signal },
          );
          signal?.throwIfAborted();
          return parseResponse(request, result);
        },
      ]),
    ),
  ) as PluginProjectAssetUiClient;
}
function method(input: object, key: string): (...args: never[]) => unknown {
  if (input === null || typeof input !== "object") invalidClient();
  for (
    let owner: object | null = input, depth = 0;
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
  throw new Error("plugin_project_asset_ui_client_invalid");
}
