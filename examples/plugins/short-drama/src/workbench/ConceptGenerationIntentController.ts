import type {
  PluginProjectGenerationClient,
  PluginProjectGenerationContextClient,
  ProjectGenerationHostContext,
} from "@crewon/plugin-sdk/ui";
import type {
  ConceptGenerationLocator,
  ProjectGenerationUiInput,
  ProjectGenerationUiReceipt,
  ProjectGenerationUiReference,
} from "@crewon/plugin-sdk/contracts";
import type { ConceptGenerationSnapshot } from "./ConceptGenerationController";
import type { ConceptOriginalRetryPolicy } from "./ConceptImageSelectionController.types";

export type ConceptGenerationIntentSnapshot = Readonly<{
  phase: "idle" | "checking" | "ready" | "unavailable";
  intentPhase: "pending" | "uncertain" | "accepted" | "refused" | null;
  request: ProjectGenerationUiInput | null;
  receipt: ProjectGenerationUiReceipt | null;
  retryable: boolean;
  recovery: "idle" | "loading" | "unavailable";
  reason: string | null;
  canGenerate: boolean;
}>;
const key = (value: unknown) => JSON.stringify(value);
export const generationSourceKey = (source: ConceptGenerationLocator) =>
  key([source.projectId, source.assetId, source.assetRevision]);

/** Keeps one exact intent. Display hints never authorize a paid task. */
export class ConceptGenerationIntentController {
  readonly #generate: PluginProjectGenerationClient["generateConcept"];
  readonly #readiness: PluginProjectGenerationContextClient["getReadiness"];
  readonly #ports: Readonly<{
    lockChanged(): void;
    accepted(
      request: ProjectGenerationUiInput,
      receipt: ProjectGenerationUiReceipt,
    ): void;
    restore(request: ProjectGenerationUiInput): Promise<boolean>;
    restored(): void;
  }>;
  readonly #listeners = new Set<() => void>();
  #snapshot: ConceptGenerationIntentSnapshot = {
    phase: "idle",
    intentPhase: null,
    request: null,
    receipt: null,
    retryable: false,
    recovery: "idle",
    reason: null,
    canGenerate: false,
  };
  #host: ProjectGenerationHostContext | null = null;
  #seenHostIntent: string | null = null;
  #source: ProjectGenerationUiReference | null = null;
  #active = false;
  #originalRetryBlocked: (() => boolean) | null = null;
  #ready = false;
  #record: ConceptGenerationSnapshot | null = null;
  #binding: string | null = null;
  #check: AbortController | null = null;
  #write: AbortController | null = null;
  #recoveryEpoch = 0;
  #disposed = false;
  constructor(ports: {
    client: PluginProjectGenerationClient;
    contexts: PluginProjectGenerationContextClient;
    lockChanged(): void;
    accepted(
      request: ProjectGenerationUiInput,
      receipt: ProjectGenerationUiReceipt,
    ): void;
    restore(request: ProjectGenerationUiInput): Promise<boolean>;
    restored(): void;
  }) {
    this.#generate = ports.client.generateConcept.bind(ports.client);
    this.#readiness = ports.contexts.getReadiness.bind(ports.contexts);
    this.#ports = Object.freeze({
      lockChanged: ports.lockChanged.bind(ports),
      accepted: ports.accepted.bind(ports),
      restore: ports.restore.bind(ports),
      restored: ports.restored.bind(ports),
    });
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  get locked() {
    return (
      this.#write !== null ||
      this.#snapshot.intentPhase === "pending" ||
      this.#snapshot.intentPhase === "uncertain" ||
      this.#snapshot.recovery === "loading"
    );
  }
  get hasHostContext() {
    return this.#host !== null;
  }
  get originalRequestBusy() {
    return (
      this.#disposed ||
      !this.#ready ||
      this.#write !== null ||
      this.#snapshot.intentPhase === "pending" ||
      this.#snapshot.recovery === "loading"
    );
  }
  blocksOriginalRetry(source: ConceptGenerationLocator | null) {
    if (this.originalRequestBusy) return true;
    if (this.#snapshot.intentPhase !== "uncertain") return false;
    const request = this.#snapshot.request,
      intent = this.#host?.intent;
    return !(
      source &&
      this.#source &&
      request &&
      this.#snapshot.recovery === "idle" &&
      this.#snapshot.retryable &&
      intent?.phase === "uncertain" &&
      intent.retryable &&
      key(intent.request) === key(request) &&
      generationSourceKey(this.#source) ===
        generationSourceKey(request.reference) &&
      generationSourceKey(source) === generationSourceKey(request.reference)
    );
  }
  refreshOriginalRetryGate() {
    this.#update({});
  }
  #update(change: Partial<ConceptGenerationIntentSnapshot>) {
    if (this.#disposed) return;
    const locked = this.locked;
    this.#snapshot = { ...this.#snapshot, ...change };
    if (locked !== this.locked) this.#ports.lockChanged();
    for (const listener of this.#listeners) listener();
  }
  bindSource(
    source: ProjectGenerationUiReference | null,
    active: boolean,
    ready: boolean,
    retryPolicy?: ConceptOriginalRetryPolicy,
  ) {
    if (this.#disposed) return;
    this.#source = source ? Object.freeze({ ...source }) : null;
    this.#active = active;
    this.#originalRetryBlocked = retryPolicy
      ? retryPolicy.originalRetryBlocked.bind(retryPolicy)
      : null;
    const wasReady = this.#ready;
    this.#ready = ready;
    if (!ready) {
      this.#write?.abort();
      if (this.#snapshot.intentPhase === "pending")
        this.#update({ intentPhase: "uncertain", retryable: false });
      if (wasReady) {
        ++this.#recoveryEpoch;
        // A canceled generation of reads cannot block a new ready lifetime or publish into it.
        this.#update({ recovery: "idle" });
      }
    }
    if (
      source &&
      this.#snapshot.request &&
      generationSourceKey(source) !==
        generationSourceKey(this.#snapshot.request.reference) &&
      !this.locked
    )
      this.#update({
        request: null,
        receipt: null,
        intentPhase: null,
        retryable: false,
        recovery: "idle",
      });
    this.#rebind();
  }
  setRecord(record: ConceptGenerationSnapshot) {
    this.#record = record;
    this.#rebind();
  }
  setHostContext(context: ProjectGenerationHostContext | null) {
    if (this.#disposed) return;
    this.#host = context;
    const intent = context?.intent;
    if (intent) {
      const signature = key(intent);
      const request = this.#snapshot.request;
      if (request && this.locked && key(request) !== key(intent.request)) {
        this.#update({
          retryable: false,
          reason: "原生成请求尚未确认，不能切换请求。",
        });
      } else if (signature !== this.#seenHostIntent) {
        const changed = !request || key(request) !== key(intent.request);
        this.#seenHostIntent = signature;
        // An accepted acknowledgement cannot regress because of stale projected props.
        if (
          !(
            this.#snapshot.intentPhase === "accepted" &&
            !changed &&
            intent.phase !== "accepted"
          )
        ) {
          this.#update({
            request: intent.request,
            intentPhase: intent.phase,
            receipt: intent.receipt,
            retryable: intent.retryable,
            canGenerate: false,
          });
          if (intent.phase === "accepted" && intent.receipt)
            this.#ports.accepted(intent.request, intent.receipt);
        }
        if (changed) void this.restoreSource();
      }
      if (
        this.#snapshot.intentPhase === "uncertain" &&
        intent.phase === "uncertain" &&
        key(this.#snapshot.request) === key(intent.request) &&
        this.#snapshot.retryable !== intent.retryable
      )
        this.#update({ retryable: intent.retryable });
    } else if (this.locked) this.#update({ retryable: false });
    this.#rebind();
  }
  #eligible() {
    const source = this.#source,
      record = this.#record;
    return (
      this.#ready &&
      this.#active &&
      !this.#disposed &&
      source !== null &&
      this.#host?.threadReady === true &&
      this.#host.thread !== null &&
      record?.phase === "ready" &&
      record.generation === null &&
      record.source !== null &&
      generationSourceKey(source) ===
        generationSourceKey({ ...source, ...record.source }) &&
      this.#snapshot.intentPhase === null
    );
  }
  #rebind() {
    if (this.#disposed) return;
    const binding = this.#eligible()
      ? key([this.#source, this.#host!.thread])
      : null;
    if (binding === this.#binding) return;
    this.#binding = binding;
    this.#check?.abort();
    this.#check = null;
    this.#update({ phase: "idle", canGenerate: false, reason: null });
    if (binding !== null) void this.refreshReadiness();
  }
  async refreshReadiness() {
    if (!this.#eligible()) return;
    this.#check?.abort();
    const controller = new AbortController(),
      binding = this.#binding;
    this.#check = controller;
    const current = () =>
      !this.#disposed &&
      !controller.signal.aborted &&
      this.#check === controller &&
      this.#binding === binding &&
      this.#eligible();
    this.#update({ phase: "checking", canGenerate: false, reason: null });
    try {
      const response = await this.#readiness(
        { reference: this.#source! },
        { signal: controller.signal },
      );
      if (current())
        this.#update(
          response.readiness.outcome === "ready"
            ? { phase: "ready", canGenerate: true }
            : {
                phase: "unavailable",
                canGenerate: false,
                reason:
                  response.readiness.reasonCode ===
                  "project_generation_input_unavailable"
                    ? "已保存输入已有变化，请重新打开后确认。"
                    : "生成能力暂不可用，请稍后重试。",
              },
        );
    } catch {
      if (current())
        this.#update({
          phase: "unavailable",
          canGenerate: false,
          reason: "无法确认生成准备状态，请重试。",
        });
    } finally {
      if (this.#check === controller) this.#check = null;
    }
  }
  async generate() {
    if (!this.#snapshot.canGenerate || !this.#eligible() || this.#write) return;
    const thread = this.#host!.thread!;
    const request: ProjectGenerationUiInput = Object.freeze({
      reference: Object.freeze({ ...this.#source! }),
      threadId: thread.threadId,
      expectedThreadRevision: thread.revision,
      idempotencyKey: crypto.randomUUID(),
    });
    this.#update({
      request,
      receipt: null,
      intentPhase: "pending",
      retryable: false,
      canGenerate: false,
    });
    await this.#submit(request);
  }
  get canRetry() {
    const request = this.#snapshot.request;
    return Boolean(
      request &&
        this.#ready &&
        !this.#disposed &&
        !this.#write &&
        !(this.#originalRetryBlocked?.() ?? false) &&
        this.#snapshot.intentPhase === "uncertain" &&
        this.#snapshot.retryable &&
        key(this.#host?.intent?.request) === key(request),
    );
  }
  async retry() {
    if (!this.canRetry) return;
    const request = this.#snapshot.request!;
    this.#update({ intentPhase: "pending", retryable: false });
    await this.#submit(request);
  }
  async #submit(request: ProjectGenerationUiInput) {
    this.#rebind();
    const controller = new AbortController();
    this.#write = controller;
    this.#ports.lockChanged();
    const current = () =>
      !this.#disposed &&
      this.#ready &&
      !controller.signal.aborted &&
      this.#write === controller &&
      key(this.#snapshot.request) === key(request);
    try {
      const receipt = await this.#generate(request, {
        signal: controller.signal,
      });
      if (current()) {
        this.#update({ intentPhase: "accepted", receipt, retryable: false });
        this.#ports.accepted(request, receipt);
      }
    } catch {
      if (
        current() &&
        this.#snapshot.intentPhase !== "accepted" &&
        this.#snapshot.intentPhase !== "refused"
      )
        this.#update({
          intentPhase: "uncertain",
          retryable:
            this.#host?.intent?.phase === "uncertain" &&
            this.#host.intent.retryable &&
            key(this.#host.intent.request) === key(request),
        });
    } finally {
      if (this.#write === controller) {
        const locked = this.locked;
        this.#write = null;
        this.#update({});
        if (locked !== this.locked) this.#ports.lockChanged();
      }
    }
  }
  async restoreSource() {
    const request = this.#snapshot.request;
    if (
      !request ||
      !this.#ready ||
      this.#disposed ||
      this.#snapshot.recovery === "loading"
    )
      return false;
    const epoch = ++this.#recoveryEpoch;
    this.#update({ recovery: "loading" });
    const restored = await this.#ports.restore(request).catch(() => false);
    if (
      this.#disposed ||
      !this.#ready ||
      epoch !== this.#recoveryEpoch ||
      key(this.#snapshot.request) !== key(request)
    )
      return false;
    this.#update({ recovery: restored ? "idle" : "unavailable" });
    if (restored) this.#ports.restored();
    return restored;
  }
  async refreshRefused() {
    if (
      this.#snapshot.intentPhase !== "refused" ||
      !(await this.restoreSource())
    )
      return;
    this.#update({
      intentPhase: null,
      request: null,
      receipt: null,
      retryable: false,
    });
    this.#rebind();
  }
  resume() {
    if (this.#snapshot.request) void this.restoreSource();
  }
  dispose() {
    this.#disposed = true;
    ++this.#recoveryEpoch;
    this.#check?.abort();
    this.#write?.abort();
    this.#listeners.clear();
  }
}
