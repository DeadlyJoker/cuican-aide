/** Independent public protocol; no Host source or runtime import. */
export const PROJECT_CONVERSATION_ASSOCIATION_SERVICE =
  "crewon.project-conversation-association";
export const PROJECT_CONVERSATION_ASSOCIATION_API_VERSION = "1";
export const PROJECT_CONVERSATION_ASSOCIATION_ACTIONS = {
  inspect: "crewon.project-conversation-association.v1.inspect",
  attach: "crewon.project-conversation-association.v1.attach",
} as const;
export type AssociationCandidate = Readonly<{
  threadId: string;
  threadRevision: number;
  workspaceId: string | null;
}>;
export type AssociationInspectInput = Readonly<{
  projectId: string;
  threadId: string;
}>;
export type AssociationAttachInput = AssociationInspectInput &
  Readonly<{
    expectedThreadRevision: number;
    workspaceId: string | null;
    idempotencyKey: string;
  }>;
export type AssociationRequest =
  | Readonly<{
      action: typeof PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.inspect;
      input: AssociationInspectInput;
    }>
  | Readonly<{
      action: typeof PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.attach;
      input: AssociationAttachInput;
    }>;
import type {
  PublicProjectConversationBinding,
  ProjectConversationsUiJsonValue,
} from "./project-conversations-service";
export type AssociationResponse =
  | Readonly<{ candidate: AssociationCandidate | null }>
  | Readonly<{
      disposition: "committed" | "replayed";
      binding: PublicProjectConversationBinding;
    }>;
export interface AssociationClient {
  inspect(
    input: AssociationInspectInput,
    options?: { signal?: AbortSignal },
  ): Promise<Readonly<{ candidate: AssociationCandidate | null }>>;
  attach(
    input: AssociationAttachInput,
    options?: { signal?: AbortSignal },
  ): Promise<
    Readonly<{
      disposition: "committed" | "replayed";
      binding: PublicProjectConversationBinding;
    }>
  >;
}
export function createAssociationClient(
  services: {
    invoke(
      action: string,
      input: ProjectConversationsUiJsonValue,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  },
  codec: {
    parseProjectConversationAssociationRequest(
      input: unknown,
    ): AssociationRequest;
    parseProjectConversationAssociationResponse(
      request: AssociationRequest,
      input: unknown,
    ): AssociationResponse;
  },
): AssociationClient {
  const invoke = services.invoke.bind(services);
  const parseRequest = codec.parseProjectConversationAssociationRequest;
  const parseResponse = codec.parseProjectConversationAssociationResponse;
  async function call(request: AssociationRequest, signal?: AbortSignal) {
    const parsed = parseRequest(request);
    signal?.throwIfAborted();
    const response = await invoke(parsed.action, parsed.input, { signal });
    signal?.throwIfAborted();
    return parseResponse(parsed, response);
  }
  return Object.freeze({
    async inspect(
      input: AssociationInspectInput,
      options: { signal?: AbortSignal } = {},
    ) {
      const response = await call(
        { action: PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.inspect, input },
        options.signal,
      );
      if (!("candidate" in response))
        throw new Error("project_conversation_association_invalid");
      return response;
    },
    async attach(
      input: AssociationAttachInput,
      options: { signal?: AbortSignal } = {},
    ) {
      const response = await call(
        { action: PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.attach, input },
        options.signal,
      );
      if (!("binding" in response))
        throw new Error("project_conversation_association_invalid");
      return response;
    },
  });
}
