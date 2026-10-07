import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import {
  parsePublicProjectConversationBinding,
  type PublicProjectConversationBinding,
} from "@crewon/contracts/project-conversations";
import {
  parseGenerateProjectMediaRequest,
  type GenerateProjectMediaRequest,
  type GenerateProjectMediaResponse,
} from "@crewon/contracts/project-media-generations";
import type { ProjectMediaGenerationRecoveryHint } from "@crewon/contracts/project-media-generation-recovery";
import type {
  MediaInputSummary,
  MediaInputOptionsResponse,
} from "@crewon/contracts/project-media-input-catalog";
import type { LoadMediaInputResponse } from "@crewon/contracts/project-media-inputs";

export type ProjectMediaGenerationSnapshot = Readonly<{
  phase: "loading" | "ready" | "unavailable" | "error";
  operation: "idle" | "reading" | "preparing" | "adopting";
  inputs: readonly MediaInputSummary[];
  next: string | null;
  selected: LoadMediaInputResponse["state"];
  configuration: MediaInputOptionsResponse["configuration"];
  request: GenerateProjectMediaRequest | null;
  receipt: GenerateProjectMediaResponse | null;
  retryable: boolean;
  foreignPending: boolean;
  notice:
    | "none"
    | "refused"
    | "unknown"
    | "accepted"
    | "read-failed"
    | "adoption-failed"
    | "stale";
}>;
export type ProjectMediaGenerationPresenter = {
  adoptExtensionTask(
    receipt: Readonly<{ threadId: string; runId: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<void>;
};

/** One bound conversation view. Durable authority and exact replay live in the original server journal. */
export class ControlProjectMediaGeneration {
  readonly #client: ControlApiClient;
  readonly #binding: PublicProjectConversationBinding;
  readonly #briefRevision: number;
  readonly #presenter: ProjectMediaGenerationPresenter;
  readonly #key: () => string;
  readonly #listeners = new Set<() => void>();
  #controller: AbortController | null = null;
  #disposed = false;
  #state: ProjectMediaGenerationSnapshot = {
    phase: "loading",
    operation: "idle",
    inputs: [],
    next: null,
    selected: null,
    configuration: null,
    request: null,
    receipt: null,
    retryable: false,
    foreignPending: false,
    notice: "none",
  };
  constructor(input: {
    client: ControlApiClient;
    binding: PublicProjectConversationBinding;
    briefRevision: number;
    presenter: ProjectMediaGenerationPresenter;
    key?: () => string;
  }) {
    this.#client = input.client;
    this.#binding = parsePublicProjectConversationBinding(input.binding);
    if (this.#binding.state !== "active")
      throw new Error("project_media_binding_inactive");
    this.#briefRevision = input.briefRevision;
    this.#presenter = input.presenter;
    this.#key = input.key ?? (() => crypto.randomUUID());
  }
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.#state;
  get locked() {
    return (
      this.#state.foreignPending ||
      (this.#state.request !== null && this.#state.receipt === null)
    );
  }
  get canGenerate() {
    const s = this.#state,
      selected = s.selected;
    return (
      !this.#disposed &&
      s.phase === "ready" &&
      s.operation === "idle" &&
      !this.locked &&
      selected !== null &&
      selected.input.inputRevision === selected.latestInputRevision &&
      selected.input.briefRevision === this.#briefRevision &&
      selected.input.configurationRevision === s.configuration?.revision &&
      s.configuration.workflows.includes(selected.input.workflowId)
    );
  }
  #publish(patch: Partial<ProjectMediaGenerationSnapshot>) {
    if (this.#disposed) return;
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener();
  }
  #current(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#disposed) throw new Error("project_media_view_closed");
  }
  async #bindingCurrent(signal: AbortSignal) {
    const { binding } = await this.#client.projectConversations.getBinding(
      this.#binding.threadId,
      { signal },
    );
    this.#current(signal);
    if (JSON.stringify(binding) !== JSON.stringify(this.#binding))
      throw new Error("project_media_binding_changed");
  }
  async #recover(signal: AbortSignal) {
    await this.#bindingCurrent(signal);
    const { intent } = await this.#client.projectMediaGenerations.getRecovery(
      {
        projectId: this.#binding.projectId,
        threadId: this.#binding.threadId,
      },
      { signal },
    );
    this.#current(signal);
    this.#applyRecovery(intent);
  }
  #applyRecovery(intent: ProjectMediaGenerationRecoveryHint | null) {
    if (intent === null) {
      // A missing read never clears a locally ambiguous request.
      if (!this.locked || this.#state.request === null)
        this.#publish({ foreignPending: false });
      return;
    }
    const request = intent.request.input;
    const own =
      request.projectId === this.#binding.projectId &&
      request.threadId === this.#binding.threadId;
    const unresolved =
      intent.phase === "prepared" || intent.phase === "dispatched";
    if (!own) {
      this.#publish({ foreignPending: unresolved });
      return;
    }
    if (
      this.locked &&
      this.#state.request !== null &&
      JSON.stringify(this.#state.request) !== JSON.stringify(request)
    )
      throw new Error("project_media_original_request_mismatch");
    if (intent.phase === "refused") {
      this.#publish({
        request: null,
        receipt: null,
        retryable: false,
        foreignPending: false,
        notice: "refused",
      });
      return;
    }
    this.#publish({
      request,
      receipt: intent.receipt,
      retryable: intent.retryable,
      foreignPending: false,
      notice: intent.phase === "accepted" ? "accepted" : "unknown",
    });
  }
  async #work(
    operation: ProjectMediaGenerationSnapshot["operation"],
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    if (this.#disposed || this.#controller !== null) return;
    const controller = new AbortController();
    this.#controller = controller;
    this.#publish({ operation });
    try {
      await work(controller.signal);
    } catch (error) {
      if (this.#disposed) return;
      if (this.#state.receipt !== null && this.#state.operation === "adopting")
        this.#publish({ notice: "adoption-failed" });
      else if (this.#state.request !== null && this.#state.receipt === null)
        this.#publish({ phase: "error", notice: "unknown", retryable: false });
      else if (
        error instanceof ControlApiClientError &&
        [403, 404].includes(error.status)
      )
        this.#publish({ phase: "unavailable" });
      else this.#publish({ phase: "error", notice: "read-failed" });
    } finally {
      this.#controller = null;
      this.#publish({ operation: "idle" });
    }
  }
  refresh() {
    return this.#work("reading", async (signal) => {
      await this.#recover(signal);
      const original = this.locked ? this.#state.request : null;
      const selection =
        original === null ? this.#state.selected?.input : original;
      const [page, options, selected] = await Promise.all([
        this.#client.projectMediaInputs.listInputs(
          {
            projectId: this.#binding.projectId,
            afterMediaInputId: null,
            limit: 16,
          },
          { signal },
        ),
        this.#client.projectMediaInputs.getOptions(
          { projectId: this.#binding.projectId },
          { signal },
        ),
        selection === undefined || selection === null
          ? Promise.resolve({ state: null })
          : this.#client.projectMediaInputs.loadInput(
              {
                projectId: this.#binding.projectId,
                mediaInputId: selection.mediaInputId,
                inputRevision: original?.inputRevision ?? null,
              },
              { signal },
            ),
      ]);
      this.#current(signal);
      this.#publish({
        phase: "ready",
        selected: selected.state,
        inputs: page.inputs,
        next: page.nextMediaInputId,
        configuration: options.configuration,
      });
    });
  }
  nextPage() {
    if (this.#state.next === null || this.locked) return Promise.resolve();
    const afterMediaInputId = this.#state.next;
    return this.#work("reading", async (signal) => {
      const page = await this.#client.projectMediaInputs.listInputs(
        { projectId: this.#binding.projectId, afterMediaInputId, limit: 16 },
        { signal },
      );
      this.#current(signal);
      this.#publish({
        inputs: page.inputs,
        next: page.nextMediaInputId,
        selected: null,
      });
    });
  }
  select(mediaInputId: string) {
    if (this.locked || this.#disposed || this.#controller !== null)
      return Promise.resolve();
    const summary = this.#state.inputs.find(
      (input) => input.mediaInputId === mediaInputId,
    );
    if (summary === undefined) return Promise.resolve();
    this.#publish({ selected: null });
    return this.#work("reading", async (signal) => {
      const result = await this.#client.projectMediaInputs.loadInput(
        {
          projectId: this.#binding.projectId,
          mediaInputId,
          inputRevision: summary.latestInputRevision,
        },
        { signal },
      );
      this.#current(signal);
      this.#publish({ selected: result.state });
    });
  }
  generate() {
    if (!this.canGenerate) return Promise.resolve();
    const selected = this.#state.selected!;
    return this.#work("preparing", async (signal) => {
      await this.#recover(signal);
      if (this.locked) return;
      const current = await this.#client.getThread(this.#binding.threadId, {
        signal,
      });
      this.#current(signal);
      if (
        current.thread.threadId !== this.#binding.threadId ||
        current.thread.workspaceId !== this.#binding.workspaceId ||
        current.thread.status !== "active"
      )
        throw new Error("project_media_thread_changed");
      const request = parseGenerateProjectMediaRequest({
        projectId: this.#binding.projectId,
        threadId: this.#binding.threadId,
        mediaInputId: selected.input.mediaInputId,
        inputRevision: selected.input.inputRevision,
        expectedInputRevision: selected.latestInputRevision,
        expectedThreadRevision: current.thread.revision,
        executionId: this.#key(),
        idempotencyKey: this.#key(),
      });
      this.#publish({
        request,
        receipt: null,
        retryable: false,
        notice: "none",
      });
      await this.#submit(request, signal);
    });
  }
  retry() {
    if (
      !this.#state.retryable ||
      this.#state.request === null ||
      this.#state.foreignPending
    )
      return Promise.resolve();
    const original = this.#state.request;
    return this.#work("preparing", async (signal) => {
      await this.#recover(signal);
      if (this.#state.receipt !== null) return this.#adopt(signal);
      if (
        !this.#state.retryable ||
        this.#state.request === null ||
        this.#state.foreignPending
      )
        return;
      if (JSON.stringify(original) !== JSON.stringify(this.#state.request))
        throw new Error("project_media_original_request_mismatch");
      await this.#submit(original, signal);
    });
  }
  async #submit(request: GenerateProjectMediaRequest, signal: AbortSignal) {
    const receipt = await this.#client.projectMediaGenerations.generate(
      request,
      { signal },
    );
    // Preserve a confirmed late response; abort only stops presentation, never rewrites acceptance.
    this.#publish({
      receipt,
      notice: "accepted",
      retryable: false,
      operation: "adopting",
    });
    this.#current(signal);
    await this.#adopt(signal);
  }
  async #adopt(signal: AbortSignal) {
    const receipt = this.#state.receipt;
    if (receipt === null || receipt.threadId !== this.#binding.threadId) return;
    await this.#bindingCurrent(signal);
    this.#publish({ operation: "adopting" });
    await this.#presenter.adoptExtensionTask(receipt, { signal });
    this.#current(signal);
    this.#publish({ notice: "accepted" });
  }
  showTask() {
    return this.#work("adopting", (signal) => this.#adopt(signal));
  }
  stopWaiting() {
    this.#controller?.abort();
  }
  dispose() {
    this.#disposed = true;
    this.#controller?.abort();
    this.#listeners.clear();
  }
}
