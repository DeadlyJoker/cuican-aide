/** Independent asset stage admission. This does not extend the frozen four text stages. */
export const CREWON_PROJECT_ASSET_STAGES_SERVICE =
  "crewon.project-asset-stages";
export const CREWON_PROJECT_ASSET_STAGES_API_VERSION = "1";
export const MAX_PROJECT_ASSET_STAGES_BYTES = 24 * 1024;
export const MAX_PROJECT_ASSET_STAGE_CONTENT_BYTES = 16 * 1024;
export const PROJECT_ASSET_STAGES_METHOD_ACTIONS = Object.freeze({
  startStage: "crewon.project-asset-stages.v1.startStage",
} as const);
export type ProjectAssetStagesAction =
  (typeof PROJECT_ASSET_STAGES_METHOD_ACTIONS)[keyof typeof PROJECT_ASSET_STAGES_METHOD_ACTIONS];
export function isProjectAssetStagesAction(
  input: unknown,
): input is ProjectAssetStagesAction {
  return input === PROJECT_ASSET_STAGES_METHOD_ACTIONS.startStage;
}
export function isProjectAssetStagesNamespaceAction(input: unknown): boolean {
  return (
    typeof input === "string" &&
    (input === CREWON_PROJECT_ASSET_STAGES_SERVICE ||
      input.startsWith(`${CREWON_PROJECT_ASSET_STAGES_SERVICE}.`))
  );
}
export type PublicProjectAssetStage = Readonly<{
  kind: "assets";
  assetKind: "character" | "scene" | "prop";
  briefRevision: number;
  script: Readonly<{
    artifactId: string;
    episodeId: string;
    contentRevision: number;
  }> | null;
}>;
export type ProjectAssetStageRequest = Readonly<{
  projectId: string;
  threadId: string;
  expectedThreadRevision: number;
  expectedBindingRevision: number;
  stage: PublicProjectAssetStage;
  content: string;
  idempotencyKey: string;
}>;
export type ProjectAssetStageResponse = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  runRevision: number;
  bindingRevision: number;
  stageAdmissionDigest: string;
}>;
export type ProjectAssetStagesRequests = Readonly<{
  startStage: ProjectAssetStageRequest;
}>;
export type ProjectAssetStagesResponses = Readonly<{
  startStage: ProjectAssetStageResponse;
}>;
export type ProjectAssetStagesActionRequest = Readonly<{
  action: ProjectAssetStagesAction;
  input: ProjectAssetStageRequest;
}>;
export interface ProjectAssetStagesCodec {
  parseRequest(input: unknown): ProjectAssetStagesActionRequest;
  parseResponse(
    request: ProjectAssetStagesActionRequest,
    input: unknown,
  ): ProjectAssetStageResponse;
}
export type ProjectAssetStagesJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectAssetStagesJsonValue[]
  | Readonly<{ [key: string]: ProjectAssetStagesJsonValue }>;
export type ProjectAssetStagesRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;
export interface PluginProjectAssetStagesServices {
  invoke(
    action: string,
    input: ProjectAssetStagesJsonValue,
    options: ProjectAssetStagesRequestOptions,
  ): Promise<ProjectAssetStagesJsonValue>;
}
export interface PluginProjectAssetStagesClient {
  startStage(
    input: ProjectAssetStageRequest,
    options?: ProjectAssetStagesRequestOptions,
  ): Promise<ProjectAssetStageResponse>;
}
/** Explicit invocation only; no default admission, authority, automatic write replay or selection. */
export function createPluginProjectAssetStagesClient(
  services: PluginProjectAssetStagesServices,
  codec: ProjectAssetStagesCodec,
): PluginProjectAssetStagesClient {
  const invoke = method(services, "invoke").bind(
      services,
    ) as PluginProjectAssetStagesServices["invoke"],
    parseRequest = method(codec, "parseRequest").bind(
      codec,
    ) as ProjectAssetStagesCodec["parseRequest"],
    parseResponse = method(codec, "parseResponse").bind(
      codec,
    ) as ProjectAssetStagesCodec["parseResponse"];
  return Object.freeze({
    async startStage(
      input: ProjectAssetStageRequest,
      options: ProjectAssetStagesRequestOptions = {},
    ) {
      if (
        options === null ||
        typeof options !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options))
      )
        invalid();
      const descriptors = Object.getOwnPropertyDescriptors(options);
      if (
        Reflect.ownKeys(options).some((key) => key !== "signal") ||
        (descriptors.signal !== undefined &&
          (!Object.hasOwn(descriptors.signal, "value") ||
            !descriptors.signal.enumerable))
      )
        invalid();
      const signal = descriptors.signal?.value as AbortSignal | undefined;
      if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
      signal?.throwIfAborted();
      const request = parseRequest({
        action: PROJECT_ASSET_STAGES_METHOD_ACTIONS.startStage,
        input,
      });
      const result = await invoke(
        request.action,
        request.input,
        signal === undefined ? {} : { signal },
      );
      signal?.throwIfAborted();
      return parseResponse(request, result);
    },
  });
}
function method(input: object, key: string): (...args: never[]) => unknown {
  if (input === null || typeof input !== "object") invalid();
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
      invalid();
    return descriptor.value;
  }
  return invalid();
}
function invalid(): never {
  throw new Error("plugin_project_asset_stages_client_invalid");
}

/** Read-only actual host availability; never a stage or execution grant. */
export type ProjectAssetStageAvailabilityResponse = Readonly<{
  available: boolean;
}>;
