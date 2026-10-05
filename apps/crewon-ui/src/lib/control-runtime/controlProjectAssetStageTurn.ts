import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import {
  PROJECT_ASSET_STAGES_METHOD_ACTIONS,
  parseProjectAssetStagesActionRequest,
  type ProjectAssetStageRequest,
  type PublicProjectAssetStage,
} from "@crewon/contracts/project-asset-stages";
import {
  parsePublicProjectConversationBinding,
  type PublicProjectConversationBinding,
} from "@crewon/contracts/project-conversations";

export type ProjectAssetStageComposerSelection = Readonly<{
  binding: PublicProjectConversationBinding;
  stage: PublicProjectAssetStage;
}>;
type Pending = {
  request: ProjectAssetStageRequest;
  selection: ProjectAssetStageComposerSelection;
  physical: Promise<Readonly<{ threadId: string; runId: string }>> | null;
  accepted: Readonly<{ threadId: string; runId: string }> | null;
  unknown: boolean;
};

/** An ambiguous request retains its exact original body/key; hydration retries cannot submit a second Turn. */
export class ControlProjectAssetStageTurn {
  readonly #client: ControlApiClient;
  readonly #key: (operation: string) => string;
  readonly #controller = new AbortController();
  readonly #pending = new Map<string, Pending>();
  readonly #physical = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  constructor(client: ControlApiClient, key: (operation: string) => string) {
    this.#client = client;
    this.#key = key;
  }
  start(
    input: Readonly<{
      threadId: string;
      content: string;
      expectedThreadRevision: number;
      selection: ProjectAssetStageComposerSelection;
    }>,
  ): Promise<Readonly<{ threadId: string; runId: string }>> {
    this.#controller.signal.throwIfAborted();
    const binding = parsePublicProjectConversationBinding(
      input.selection.binding,
    );
    if (binding.threadId !== input.threadId || binding.state !== "active")
      throw new Error("control_project_asset_stage_binding_invalid");
    let pending = this.#pending.get(input.threadId);
    if (pending !== undefined) {
      const original = pending.request;
      if (
        original.content !== input.content ||
        original.projectId !== input.selection.binding.projectId ||
        original.stage.assetKind !== input.selection.stage.assetKind ||
        !sameBindingOwner(pending.selection.binding, binding) ||
        JSON.stringify(original.stage.script) !==
          JSON.stringify(input.selection.stage.script)
      )
        throw new Error("control_project_asset_stage_original_request_pending");
      if (pending.accepted !== null) return Promise.resolve(pending.accepted);
      if (pending.physical !== null) return pending.physical;
    } else {
      if (this.#pending.size >= 32)
        throw new Error("control_project_asset_stage_pending_limit");
      const parsed = parseProjectAssetStagesActionRequest({
        action: PROJECT_ASSET_STAGES_METHOD_ACTIONS.startStage,
        input: {
          projectId: binding.projectId,
          threadId: input.threadId,
          expectedThreadRevision: input.expectedThreadRevision,
          expectedBindingRevision: binding.revision,
          content: input.content,
          idempotencyKey: this.#key("project-asset-stage.start-stage"),
          stage: input.selection.stage,
        },
      });
      if (parsed.action !== PROJECT_ASSET_STAGES_METHOD_ACTIONS.startStage)
        throw new Error("control_project_asset_stage_request_invalid");
      pending = {
        request: parsed.input,
        selection: Object.freeze({
          binding,
          stage: parsed.input.stage,
        }),
        physical: null,
        accepted: null,
        unknown: false,
      };
      this.#pending.set(input.threadId, pending);
    }
    const original = pending;
    const work = this.#client.projectAssetStages
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
          // Only a first known rejection proves this intent was not admitted.
          // After an unknown ACK, a later CAS conflict cannot erase its original key.
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
  ): ProjectAssetStageComposerSelection | null {
    return this.#pending.get(threadId)?.selection ?? null;
  }
  close(): Promise<void> {
    this.#controller.abort();
    return (this.#closing ??= Promise.allSettled([...this.#physical]).then(
      () => {
        this.#pending.clear();
      },
    ));
  }
}
function sameBindingOwner(
  a: PublicProjectConversationBinding,
  b: PublicProjectConversationBinding,
): boolean {
  return (
    a.bindingId === b.bindingId &&
    a.projectId === b.projectId &&
    a.threadId === b.threadId &&
    a.workspaceId === b.workspaceId &&
    JSON.stringify(a.source) === JSON.stringify(b.source)
  );
}
