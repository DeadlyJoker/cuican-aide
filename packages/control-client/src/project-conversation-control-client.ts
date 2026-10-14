import {
  MAX_PROJECT_CONVERSATIONS_BYTES,
  PROJECT_CONVERSATIONS_METHOD_ACTIONS,
  parseProjectConversationsActionRequest,
  parseProjectConversationsActionResponse,
  type ProjectConversationsRequests,
  type ProjectConversationsResponses,
  MAX_PROJECT_CONVERSATION_CONTEXT_BYTES,
  parseProjectConversationContextResponse,
  type ProjectConversationContextResponse,
} from "@crewon/contracts/project-conversations";
import type { CreativeProjectControlTransport } from "./creative-project-control-client.ts";

export type ProjectConversationControlRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

/** Original authenticated HTTP transport. No UI mount or caller-supplied authority is synthesized. */
export class ProjectConversationControlClient {
  readonly #transport: CreativeProjectControlTransport;
  constructor(transport: CreativeProjectControlTransport) {
    this.#transport = transport;
  }
  async getBinding(
    threadId: string,
    options: ProjectConversationControlRequestOptions = {},
  ): Promise<ProjectConversationsResponses["getBinding"]> {
    const request = this.#input(() =>
      parseProjectConversationsActionRequest({
        action: PROJECT_CONVERSATIONS_METHOD_ACTIONS.getBinding,
        input: { threadId },
      }),
    );
    const value = await this.#transport.json(
      "GET",
      path(threadId),
      null,
      this.#options(options, [200]),
    );
    return this.#output(() =>
      parseProjectConversationsActionResponse(request, value),
    ) as ProjectConversationsResponses["getBinding"];
  }
  async getContext(
    threadId: string,
    options: ProjectConversationControlRequestOptions = {},
  ): Promise<ProjectConversationContextResponse> {
    this.#input(() =>
      parseProjectConversationsActionRequest({
        action: PROJECT_CONVERSATIONS_METHOD_ACTIONS.getBinding,
        input: { threadId },
      }),
    );
    const value = await this.#transport.json(
      "GET",
      `${path(threadId)}/context`,
      null,
      this.#options(options, [200], MAX_PROJECT_CONVERSATION_CONTEXT_BYTES),
    );
    return this.#output(() =>
      parseProjectConversationContextResponse(threadId, value),
    );
  }
  async startStage(
    threadId: string,
    input: ProjectConversationsRequests["startStage"],
    options: ProjectConversationControlRequestOptions = {},
  ): Promise<ProjectConversationsResponses["startStage"]> {
    const request = this.#input(() => {
      const parsed = parseProjectConversationsActionRequest({
        action: PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage,
        input,
      });
      if (
        parsed.action !== PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage ||
        parsed.input.threadId !== threadId
      )
        throw new Error("thread_mismatch");
      return parsed;
    });
    const value = await this.#transport.json(
      "POST",
      `${path(threadId)}/stages`,
      request.input,
      {
        ...this.#options(options, [200, 201]),
        requireCsrf: true,
        requireIdempotency: true,
        idempotencyKey: request.input.idempotencyKey,
      },
    );
    return this.#output(() =>
      parseProjectConversationsActionResponse(request, value),
    ) as ProjectConversationsResponses["startStage"];
  }
  #options(
    input: ProjectConversationControlRequestOptions,
    expectedStatuses: readonly number[],
    maximumResponseBytes = MAX_PROJECT_CONVERSATIONS_BYTES,
  ) {
    const signal = this.#input(() => {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      )
        throw new Error("options_invalid");
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (
        Reflect.ownKeys(input).some((key) => key !== "signal") ||
        (descriptors.signal !== undefined &&
          (!descriptors.signal.enumerable ||
            !Object.hasOwn(descriptors.signal, "value")))
      )
        throw new Error("options_invalid");
      const signal: unknown = descriptors.signal?.value;
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw new Error("signal_invalid");
      return signal;
    });
    signal?.throwIfAborted();
    return {
      signal:
        signal === undefined
          ? AbortSignal.timeout(30_000)
          : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      maximumResponseBytes,
      redirect: "manual" as const,
      expectedStatuses,
    };
  }
  #input<T>(read: () => T): T {
    try {
      return read();
    } catch {
      throw this.#transport.protocolError(
        "control_client_project_conversation_request_invalid",
      );
    }
  }
  #output<T>(read: () => T): T {
    try {
      return read();
    } catch {
      throw this.#transport.protocolError(
        "control_client_project_conversation_response_invalid",
      );
    }
  }
}
function path(threadId: string): string {
  return `/api/v1/threads/${encodeURIComponent(threadId)}/project-conversation`;
}
