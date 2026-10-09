/** Independent media-input preparation admission. This does not extend the frozen four text stages. */
export const CREWON_PROJECT_MEDIA_INPUT_STAGES_SERVICE =
  "crewon.project-media-input-stages";
export const CREWON_PROJECT_MEDIA_INPUT_STAGES_API_VERSION = "1";
export const MAX_PROJECT_MEDIA_INPUT_STAGES_BYTES = 24 * 1024;
export const MAX_PROJECT_MEDIA_INPUT_STAGE_CONTENT_BYTES = 16 * 1024;
export const PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS = Object.freeze({
  startStage: "crewon.project-media-input-stages.v1.startStage",
} as const);
export type ProjectMediaInputStagesAction =
  (typeof PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS)[keyof typeof PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS];
export function isProjectMediaInputStagesAction(
  input: unknown,
): input is ProjectMediaInputStagesAction {
  return input === PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS.startStage;
}
export function isProjectMediaInputStagesNamespaceAction(
  input: unknown,
): boolean {
  return (
    typeof input === "string" &&
    (input === CREWON_PROJECT_MEDIA_INPUT_STAGES_SERVICE ||
      input.startsWith(`${CREWON_PROJECT_MEDIA_INPUT_STAGES_SERVICE}.`))
  );
}
export type PublicProjectMediaInputStage = Readonly<{
  kind: "media-input";
  workflowId: "krea2-reference-four-view" | "flux2-three-reference-storyboard";
  configurationRevision: number;
  briefRevision: number;
  script: Readonly<{
    artifactId: string;
    episodeId: string;
    contentRevision: number;
  }> | null;
}>;
export type ProjectMediaInputStageRequest = Readonly<{
  projectId: string;
  threadId: string;
  expectedThreadRevision: number;
  expectedBindingRevision: number;
  stage: PublicProjectMediaInputStage;
  content: string;
  modelId?: string;
  idempotencyKey: string;
}>;
export type ProjectMediaInputStageResponse = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  runRevision: number;
  bindingRevision: number;
  stageAdmissionDigest: string;
}>;
export type ProjectMediaInputStagesRequests = Readonly<{
  startStage: ProjectMediaInputStageRequest;
}>;
export type ProjectMediaInputStagesResponses = Readonly<{
  startStage: ProjectMediaInputStageResponse;
}>;
export type ProjectMediaInputStagesActionRequest = Readonly<{
  action: ProjectMediaInputStagesAction;
  input: ProjectMediaInputStageRequest;
}>;
export interface ProjectMediaInputStagesCodec {
  parseRequest(input: unknown): ProjectMediaInputStagesActionRequest;
  parseResponse(
    request: ProjectMediaInputStagesActionRequest,
    input: unknown,
  ): ProjectMediaInputStageResponse;
}
export type ProjectMediaInputStagesJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectMediaInputStagesJsonValue[]
  | Readonly<{ [key: string]: ProjectMediaInputStagesJsonValue }>;
export type ProjectMediaInputStagesRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;
export interface PluginProjectMediaInputStagesServices {
  invoke(
    action: string,
    input: ProjectMediaInputStagesJsonValue,
    options: ProjectMediaInputStagesRequestOptions,
  ): Promise<ProjectMediaInputStagesJsonValue>;
}
export interface PluginProjectMediaInputStagesClient {
  startStage(
    input: ProjectMediaInputStageRequest,
    options?: ProjectMediaInputStagesRequestOptions,
  ): Promise<ProjectMediaInputStageResponse>;
}
/** Explicit invocation only; no default admission, authority, automatic write replay or selection. */
export function createPluginProjectMediaInputStagesClient(
  services: PluginProjectMediaInputStagesServices,
  codec: ProjectMediaInputStagesCodec,
): PluginProjectMediaInputStagesClient {
  const invoke = method(services, "invoke").bind(
      services,
    ) as PluginProjectMediaInputStagesServices["invoke"],
    parseRequest = method(codec, "parseRequest").bind(
      codec,
    ) as ProjectMediaInputStagesCodec["parseRequest"],
    parseResponse = method(codec, "parseResponse").bind(
      codec,
    ) as ProjectMediaInputStagesCodec["parseResponse"];
  return Object.freeze({
    async startStage(
      input: ProjectMediaInputStageRequest,
      options: ProjectMediaInputStagesRequestOptions = {},
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
        action: PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS.startStage,
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
  throw new Error("plugin_project_media_input_stages_client_invalid");
}

/** Read-only actual host availability; never a stage or execution grant. */
export type ProjectMediaInputStageAvailabilityResponse = Readonly<{
  available: boolean;
}>;
