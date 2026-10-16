import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import {
  PROJECT_CONVERSATIONS_METHOD_ACTIONS,
  parseProjectConversationsActionRequest,
  parsePublicProjectConversationBinding,
  type ProjectConversationsRequests,
  type PublicProjectConversationBinding,
  type ProjectConversationStage,
} from "@crewon/contracts/project-conversations";

export type ProjectConversationComposerSelection = Readonly<{
  binding: PublicProjectConversationBinding;
  stage: ProjectConversationStage;
}>;
type Pending = {
  request: ProjectConversationsRequests["startStage"];
  selection: ProjectConversationComposerSelection;
  physical: Promise<Readonly<{ threadId: string; runId: string }>> | null;
  accepted: Readonly<{ threadId: string; runId: string }> | null;
  unknown: boolean;
};

/** An ambiguous request retains its exact original body/key; hydration retries cannot submit a second Turn. */
export class ControlProjectConversationTurn {
  readonly #client: ControlApiClient;
  readonly #key: (operation: string) => string;
  readonly #controller = new AbortController();
  readonly #pending = new Map<string, Pending>();
  readonly #physical = new Set<Promise<unknown>>();
  constructor(client: ControlApiClient, key: (operation: string) => string) {
    this.#client = client;
    this.#key = key;
  }
  start(
    input: Readonly<{
      threadId: string;
      content: string;
      modelId?: string;
      expectedThreadRevision: number;
      selection: ProjectConversationComposerSelection;
    }>,
  ): Promise<Readonly<{ threadId: string; runId: string }>> {
    this.#controller.signal.throwIfAborted();
    let pending = this.#pending.get(input.threadId);
    if (pending !== undefined) {
      const original = pending.request;
      if (
        original.content !== input.content ||
        original.modelId !== input.modelId ||
        original.projectId !== input.selection.binding.projectId ||
        original.stage.kind !== input.selection.stage.kind ||
        (original.stage.kind === "script" &&
          (input.selection.stage.kind !== "script" ||
            original.stage.episodeId !== input.selection.stage.episodeId))
      )
        throw new Error(
          "control_project_conversation_original_request_pending",
        );
      if (pending.accepted !== null) return Promise.resolve(pending.accepted);
      if (pending.physical !== null) return pending.physical;
    } else {
      if (this.#pending.size >= 32)
        throw new Error("control_project_conversation_pending_limit");
      const parsed = parseProjectConversationsActionRequest({
        action: PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage,
        input: {
          projectId: input.selection.binding.projectId,
          threadId: input.threadId,
          expectedThreadRevision: input.expectedThreadRevision,
          expectedBindingRevision: input.selection.binding.revision,
          content: input.content,
          ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          idempotencyKey: this.#key("project-conversation.start-stage"),
          stage: input.selection.stage,
        },
      });
      if (parsed.action !== PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage)
        throw new Error("control_project_conversation_request_invalid");
      pending = {
        request: parsed.input,
        selection: Object.freeze({
          binding: parsePublicProjectConversationBinding(
            input.selection.binding,
          ),
          stage: parsed.input.stage,
        }),
        physical: null,
        accepted: null,
        unknown: false,
      };
      this.#pending.set(input.threadId, pending);
    }
    const original = pending;
    const work = this.#client.projectConversations
      .startStage(input.threadId, original.request, {
        signal: this.#controller.signal,
      })
      .then(
        (result) => {
          original.accepted = Object.freeze({
            threadId: result.threadId,
            runId: result.runId,
          });
          this.#controller.signal.throwIfAborted();
          return original.accepted;
        },
        (error: unknown) => {
          // Only an initial known rejection proves this intent was not admitted.
          // A later CAS failure cannot resolve an earlier unknown acknowledgement.
          if (
            !original.unknown &&
            error instanceof ControlApiClientError &&
            error.status === 409 &&
            [
              "project_conversation_revision_conflict",
              "thread_revision_conflict",
            ].includes(error.code)
          )
            this.#pending.delete(input.threadId);
          else original.unknown = true;
          throw error;
        },
      )
      .finally(() => {
        original.physical = null;
        this.#physical.delete(work);
      });
    original.physical = work;
    this.#physical.add(work);
    return work;
  }
  adopted(threadId: string, runId: string): void {
    if (this.#pending.get(threadId)?.accepted?.runId === runId)
      this.#pending.delete(threadId);
  }
  retainedSelection(
    threadId: string,
  ): ProjectConversationComposerSelection | null {
    return this.#pending.get(threadId)?.selection ?? null;
  }
  close(): Promise<void> {
    this.#controller.abort();
    return Promise.allSettled([...this.#physical]).then(() => {
      this.#pending.clear();
    });
  }
}
