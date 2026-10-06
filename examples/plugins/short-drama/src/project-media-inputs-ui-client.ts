/** Independent portable metadata client. No imports or SDK changes. */
export const CREWON_PROJECT_MEDIA_INPUTS_SERVICE =
  "crewon.project-media-inputs";
export const CREWON_PROJECT_MEDIA_INPUTS_API_VERSION = "1";
export const PROJECT_MEDIA_INPUT_UI_ACTIONS = Object.freeze({
  getOptions: "crewon.project-media-inputs.v1.getOptions",
  listInputs: "crewon.project-media-inputs.v1.listInputs",
  loadInput: "crewon.project-media-inputs.v1.loadInput",
  saveInput: "crewon.project-media-inputs.v1.saveInput",
} as const);
export type MediaInputWorkflowId =
  | "krea2-reference-four-view"
  | "flux2-three-reference-storyboard";
export type MediaInputRole =
  | "character"
  | "scene"
  | "characterOne"
  | "characterTwo";
export type MediaInputItem =
  | Readonly<{ kind: "character-reference"; assetId: string }>
  | Readonly<{ kind: "storyboard-frame-exploration"; episodeId: string }>;
export type MediaInputReference = Readonly<{
  projectId: string;
  assetId: string;
  kind: "character" | "scene";
  expectedAssetRevision: number;
  contentRevision: number;
  referenceRevision: number;
}>;
type Content = Readonly<{
  projectId: string;
  item: MediaInputItem;
  briefRevision: number;
  script: Readonly<{ artifactId: string; contentRevision: number }> | null;
  workflowId: MediaInputWorkflowId;
  configurationRevision: number;
  prompt: string;
  references: Readonly<Partial<Record<MediaInputRole, MediaInputReference>>>;
}>;
export type SaveMediaInputRequest = Content &
  Readonly<{
    mediaInputId: string | null;
    expectedInputRevision: number;
    idempotencyKey: string;
  }>;
export type LoadMediaInputRequest = Readonly<{
  projectId: string;
  mediaInputId: string;
  inputRevision: number | null;
}>;
export type PublicMediaInput = Content &
  Readonly<{
    mediaInputId: string;
    inputRevision: number;
    createdAt: string;
    contentDigest: string;
  }>;
export type SaveMediaInputResponse = Readonly<{
  disposition: "committed" | "replayed";
  input: PublicMediaInput;
}>;
export type LoadMediaInputResponse = Readonly<{
  state: Readonly<{
    input: PublicMediaInput;
    latestInputRevision: number;
  }> | null;
}>;
export type ListMediaInputsRequest = Readonly<{
  projectId: string;
  afterMediaInputId: string | null;
  limit: number;
}>;
export type MediaInputSummary = Readonly<{
  projectId: string;
  mediaInputId: string;
  latestInputRevision: number;
  item: MediaInputItem;
  workflowId: MediaInputWorkflowId;
  createdAt: string;
}>;
export type ListMediaInputsResponse = Readonly<{
  inputs: readonly MediaInputSummary[];
  nextMediaInputId: string | null;
}>;
export type MediaInputOptionsRequest = Readonly<{ projectId: string }>;
export type MediaInputOptionsResponse = Readonly<{
  configuration: Readonly<{
    revision: number;
    workflows: readonly MediaInputWorkflowId[];
  }> | null;
}>;

export type MediaInputUiInputMap = {
  getOptions: MediaInputOptionsRequest;
  listInputs: ListMediaInputsRequest;
  loadInput: LoadMediaInputRequest;
  saveInput: SaveMediaInputRequest;
};
export type MediaInputUiResponseMap = {
  getOptions: MediaInputOptionsResponse;
  listInputs: ListMediaInputsResponse;
  loadInput: LoadMediaInputResponse;
  saveInput: SaveMediaInputResponse;
};
export type MediaInputUiMethod = keyof MediaInputUiInputMap;
export type MediaInputUiRequest = {
  [M in MediaInputUiMethod]: Readonly<{
    action: (typeof PROJECT_MEDIA_INPUT_UI_ACTIONS)[M];
    input: MediaInputUiInputMap[M];
  }>;
}[MediaInputUiMethod];
export type MediaInputUiOptions = Readonly<{ signal?: AbortSignal }>;
export type MediaInputUiJson =
  | null
  | boolean
  | number
  | string
  | readonly MediaInputUiJson[]
  | Readonly<{ [key: string]: MediaInputUiJson }>;
export interface MediaInputUiServices {
  invoke(
    action: string,
    input: MediaInputUiJson,
    options: MediaInputUiOptions,
  ): Promise<MediaInputUiJson>;
}
export interface MediaInputUiCodec {
  parseRequest(input: unknown): MediaInputUiRequest;
  parseResponse(
    request: MediaInputUiRequest,
    input: unknown,
  ): MediaInputUiResponseMap[MediaInputUiMethod];
}
export type PluginMediaInputUiClient = Readonly<{
  [M in MediaInputUiMethod]: (
    input: MediaInputUiInputMap[M],
    options?: MediaInputUiOptions,
  ) => Promise<MediaInputUiResponseMap[M]>;
}>;
export function createPluginMediaInputUiClient(
  services: MediaInputUiServices,
  codec: MediaInputUiCodec,
): PluginMediaInputUiClient {
  const invoke = method(services, "invoke").bind(
      services,
    ) as MediaInputUiServices["invoke"],
    parse = method(codec, "parseRequest").bind(
      codec,
    ) as MediaInputUiCodec["parseRequest"],
    response = method(codec, "parseResponse").bind(
      codec,
    ) as MediaInputUiCodec["parseResponse"];
  return Object.freeze(
    Object.fromEntries(
      Object.entries(PROJECT_MEDIA_INPUT_UI_ACTIONS).map(([name, action]) => [
        name,
        async (input: unknown, options: MediaInputUiOptions = {}) => {
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
          if (signal !== undefined && !(signal instanceof AbortSignal))
            invalid();
          signal?.throwIfAborted();
          const request = parse({ action, input }),
            result = await invoke(
              request.action,
              request.input as unknown as MediaInputUiJson,
              signal === undefined ? {} : { signal },
            );
          signal?.throwIfAborted();
          return response(request, result);
        },
      ]),
    ),
  ) as PluginMediaInputUiClient;
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
  throw new Error("plugin_media_input_ui_client_invalid");
}
