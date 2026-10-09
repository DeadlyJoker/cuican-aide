/** Deliberate independent public protocol. Portable: no runtime or type imports. */
export const CREWON_PROJECT_CONVERSATIONS_SERVICE =
  "crewon.project-conversations";
export const CREWON_PROJECT_CONVERSATIONS_API_VERSION = "1";
export const MAX_PROJECT_CONVERSATIONS_BYTES = 24 * 1024;
export const MAX_PROJECT_CONVERSATION_CONTENT_BYTES = 16 * 1024;
export const PROJECT_CONVERSATIONS_METHOD_ACTIONS = {
  getBinding: "crewon.project-conversations.v1.getBinding",
  listConversations: "crewon.project-conversations.v1.listConversations",
  createConversation: "crewon.project-conversations.v1.createConversation",
  openConversation: "crewon.project-conversations.v1.openConversation",
  refreshSource: "crewon.project-conversations.v1.refreshSource",
  setState: "crewon.project-conversations.v1.setState",
  startStage: "crewon.project-conversations.v1.startStage",
} as const;
export type ProjectConversationStage =
  | Readonly<{ kind: "discussion" }>
  | Readonly<{ kind: "brief" | "outline"; briefRevision: number }>
  | Readonly<{
      kind: "script";
      episodeId: string;
      briefRevision: number;
      outline: Readonly<{ artifactId: string; contentRevision: number }> | null;
    }>;
export type PublicProjectConversationBinding = Readonly<{
  bindingId: string;
  projectId: string;
  threadId: string;
  workspaceId: string | null;
  revision: number;
  state: "active" | "revoked";
  source: Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
    selectionRevision: number;
  }>;
  createdAt: string;
  updatedAt: string;
}>;
export type ProjectConversationsRequests = {
  getBinding: Readonly<{ threadId: string }>;
  listConversations: Readonly<{
    projectId: string;
    afterThreadId: string | null;
    limit: number;
  }>;
  createConversation: Readonly<{
    projectId: string;
    workspaceId: string | null;
    title: string | null;
    idempotencyKey: string;
  }>;
  openConversation: Readonly<{ projectId: string; threadId: string }>;
  refreshSource: Readonly<{
    projectId: string;
    threadId: string;
    expectedBindingRevision: number;
    idempotencyKey: string;
  }>;
  setState: Readonly<{
    projectId: string;
    threadId: string;
    expectedBindingRevision: number;
    state: "active" | "revoked";
    idempotencyKey: string;
  }>;
  startStage: Readonly<{
    projectId: string;
    threadId: string;
    expectedThreadRevision: number;
    expectedBindingRevision: number;
    content: string;
    idempotencyKey: string;
    stage: ProjectConversationStage;
    /** Optional per-turn model; absence preserves the original request contract. */
    modelId?: string;
  }>;
};
export type ProjectConversationMutationResponse = Readonly<{
  disposition: "committed" | "replayed";
  binding: PublicProjectConversationBinding;
}>;
export type ProjectConversationStageResponse = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  runRevision: number;
  bindingRevision: number;
  stageAdmissionDigest: string;
}>;
export type ProjectConversationsResponses = {
  getBinding: Readonly<{ binding: PublicProjectConversationBinding | null }>;
  listConversations: Readonly<{
    bindings: readonly PublicProjectConversationBinding[];
    nextThreadId: string | null;
  }>;
  createConversation: ProjectConversationMutationResponse;
  openConversation: Readonly<{ binding: PublicProjectConversationBinding }>;
  refreshSource: ProjectConversationMutationResponse;
  setState: ProjectConversationMutationResponse;
  startStage: ProjectConversationStageResponse;
};
export type ProjectConversationsUiMethod =
  keyof typeof PROJECT_CONVERSATIONS_METHOD_ACTIONS;
export type ProjectConversationsUiAction =
  (typeof PROJECT_CONVERSATIONS_METHOD_ACTIONS)[ProjectConversationsUiMethod];
export type ProjectConversationsUiInputMap = {
  [M in ProjectConversationsUiMethod as (typeof PROJECT_CONVERSATIONS_METHOD_ACTIONS)[M]]: ProjectConversationsRequests[M];
};
export type ProjectConversationsUiResponseMap = {
  [M in ProjectConversationsUiMethod as (typeof PROJECT_CONVERSATIONS_METHOD_ACTIONS)[M]]: ProjectConversationsResponses[M];
};
export type ProjectConversationsUiActionRequest = {
  [A in ProjectConversationsUiAction]: Readonly<{
    action: A;
    input: ProjectConversationsUiInputMap[A];
  }>;
}[ProjectConversationsUiAction];
export type ProjectConversationsUiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectConversationsUiJsonValue[]
  | { readonly [key: string]: ProjectConversationsUiJsonValue };
export interface PluginProjectConversationsUiServices {
  invoke(
    action: string,
    input: ProjectConversationsUiJsonValue,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}
export type ProjectConversationsUiRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;
export interface ProjectConversationsCodec {
  parseRequest(input: unknown): ProjectConversationsUiActionRequest;
  parseResponse(
    request: ProjectConversationsUiActionRequest,
    input: unknown,
  ): ProjectConversationsUiResponseMap[ProjectConversationsUiAction];
}
export type PluginProjectConversationsClient = Readonly<{
  [M in ProjectConversationsUiMethod]: (
    input: ProjectConversationsUiInputMap[(typeof PROJECT_CONVERSATIONS_METHOD_ACTIONS)[M]],
    options?: ProjectConversationsUiRequestOptions,
  ) => Promise<
    ProjectConversationsUiResponseMap[(typeof PROJECT_CONVERSATIONS_METHOD_ACTIONS)[M]]
  >;
}>;

/** Capture the dispatcher and strict codec once. There is no automatic mutation retry. */
export function createPluginProjectConversationsClient(
  services: PluginProjectConversationsUiServices,
  codec: ProjectConversationsCodec,
): PluginProjectConversationsClient {
  const invoke = method(services, "invoke").bind(
    services,
  ) as PluginProjectConversationsUiServices["invoke"];
  const parseRequest = method(codec, "parseRequest").bind(
    codec,
  ) as ProjectConversationsCodec["parseRequest"];
  const parseResponse = method(codec, "parseResponse").bind(
    codec,
  ) as ProjectConversationsCodec["parseResponse"];
  const entries = Object.entries(PROJECT_CONVERSATIONS_METHOD_ACTIONS).map(
    ([name, action]) => [
      name,
      async (
        input: unknown,
        options: ProjectConversationsUiRequestOptions = {},
      ) => {
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
          request.input as unknown as ProjectConversationsUiJsonValue,
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
  ) as PluginProjectConversationsClient;
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
  throw new Error("plugin_project_conversations_client_invalid");
}
