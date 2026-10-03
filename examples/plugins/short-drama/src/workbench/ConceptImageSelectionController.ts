import type {
  PluginProjectGenerationSelectionClient,
  ProjectGenerationSelectionHostContext,
} from "@crewon/plugin-sdk/ui";
import type {
  ConceptGenerationLocator,
  ProjectGenerationSelectionUiInput,
  ProjectGenerationUiReference,
} from "@crewon/plugin-sdk/contracts";
import type { ConceptGenerationSnapshot } from "./ConceptGenerationController";
import type {
  ConceptImageChoice,
  ConceptImageSelectionSnapshot,
  ConceptOriginalRetryPolicy,
} from "./ConceptImageSelectionController.types";

const key = (value: unknown) => JSON.stringify(value);
const sourceKey = (source: ConceptGenerationLocator | null | undefined) =>
  source ? key([source.projectId, source.assetId, source.assetRevision]) : null;
const assetKey = (source: ConceptGenerationLocator | null | undefined) =>
  source ? key([source.projectId, source.assetId]) : null;
const initial = (): ConceptImageSelectionSnapshot => ({
  phase: "idle",
  current: null,
  intentPhase: null,
  request: null,
  receipt: null,
  retryable: false,
  recovery: "idle",
  reason: null,
});

/** Current selection is observed separately from one immutable, recoverable write intent. */
export class ConceptImageSelectionController {
  readonly #get: PluginProjectGenerationSelectionClient["getConceptSelection"];
  readonly #select: PluginProjectGenerationSelectionClient["selectConceptImage"];
  readonly #ports: Readonly<{
    lockChanged(): void;
    restore(request: ProjectGenerationSelectionUiInput): Promise<boolean>;
  }>;
  readonly #listeners = new Set<() => void>();
  #snapshot = initial();
  #host: ProjectGenerationSelectionHostContext | null = null;
  #seenIntent: string | null = null;
  #source: ProjectGenerationUiReference | null = null;
  #record: ConceptGenerationSnapshot | null = null;
  #binding: string | null = null;
  #ready = false;
  #active = false;
  #blocked = false;
  #originalRetryBlocked: (() => boolean) | null = null;
  #disposed = false;
  #lifetime = 0;
  #recoveryEpoch = 0;
  #read: AbortController | null = null;
  #write: AbortController | null = null;
  constructor(ports: {
    client: PluginProjectGenerationSelectionClient;
    lockChanged(): void;
    restore(request: ProjectGenerationSelectionUiInput): Promise<boolean>;
  }) {
    this.#get = ports.client.getConceptSelection.bind(ports.client);
    this.#select = ports.client.selectConceptImage.bind(ports.client);
    this.#ports = Object.freeze({
      lockChanged: ports.lockChanged.bind(ports),
      restore: ports.restore.bind(ports),
    });
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  get hasHostContext() {
    return this.#host !== null;
  }
  get locked() {
    return (
      this.#snapshot.intentPhase === "pending" ||
      this.#snapshot.intentPhase === "uncertain" ||
      this.#snapshot.recovery === "loading"
    );
  }
  blocksOriginalRetry(source: ConceptGenerationLocator | null) {
    if (
      this.#disposed ||
      !this.#ready ||
      this.#write !== null ||
      this.#snapshot.intentPhase === "pending" ||
      this.#snapshot.recovery === "loading"
    )
      return true;
    if (this.#snapshot.intentPhase !== "uncertain") return false;
    const request = this.#snapshot.request,
      intent = this.#host?.intent;
    return !(
      source &&
      request &&
      this.#snapshot.recovery === "idle" &&
      this.#snapshot.retryable &&
      intent?.phase === "uncertain" &&
      intent.retryable &&
      key(intent.request) === key(request) &&
      sourceKey(this.#source) === sourceKey(request.reference) &&
      sourceKey(source) === sourceKey(request.reference)
    );
  }
  #update(change: Partial<ConceptImageSelectionSnapshot> = {}) {
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
    blocked: boolean,
    retryPolicy?: ConceptOriginalRetryPolicy,
  ) {
    if (this.#disposed) return;
    const oldAsset = assetKey(this.#source),
      wasReady = this.#ready;
    this.#source = source ? Object.freeze({ ...source }) : null;
    this.#active = active;
    this.#ready = ready;
    this.#blocked = blocked;
    this.#originalRetryBlocked = retryPolicy
      ? retryPolicy.originalRetryBlocked.bind(retryPolicy)
      : null;
    if (!ready) {
      if (wasReady) {
        ++this.#lifetime;
        ++this.#recoveryEpoch;
      }
      this.#read?.abort();
      this.#write?.abort();
      this.#binding = null;
      this.#update({
        phase: "idle",
        current: null,
        recovery: "idle",
        ...(this.#snapshot.intentPhase === "pending"
          ? { intentPhase: "uncertain", retryable: false }
          : {}),
      });
      return;
    }
    if (oldAsset !== assetKey(source)) {
      this.#read?.abort();
      this.#update({
        phase: "idle",
        current: null,
        ...(!this.locked
          ? {
              request: null,
              receipt: null,
              intentPhase: null,
              retryable: false,
              reason: null,
            }
          : {}),
      });
    }
    const nextBinding = this.#host && source ? key(source) : null;
    if (nextBinding !== this.#binding) {
      this.#binding = nextBinding;
      if (nextBinding) void this.refresh();
    }
    this.#update();
  }
  refreshOriginalRetryGate() {
    this.#update();
  }
  setRecord(record: ConceptGenerationSnapshot) {
    if (this.#disposed) return;
    this.#record = record;
    this.#update();
  }
  setHostContext(context: ProjectGenerationSelectionHostContext | null) {
    if (this.#disposed) return;
    const changedHost = Boolean(this.#host) !== Boolean(context);
    this.#host = context;
    if (!context) {
      if (changedHost) {
        ++this.#lifetime;
        ++this.#recoveryEpoch;
        this.#read?.abort();
        this.#binding = null;
      }
      this.#update({
        retryable: false,
        phase: "idle",
        current: null,
        recovery: "idle",
      });
      return;
    }
    const intent = context.intent;
    if (intent) {
      const changed = key(intent.request) !== key(this.#snapshot.request);
      if (this.locked && changed) {
        this.#update({
          retryable: false,
          reason: "原选用尚未确认，请先恢复原选用。",
        });
        return;
      }
      const signature = key(intent);
      if (signature !== this.#seenIntent) {
        this.#seenIntent = signature;
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
            reason: null,
          });
          if (changed) void this.restoreSource();
          else if (intent.phase === "accepted") void this.refresh();
        }
      } else if (
        intent.phase === "uncertain" &&
        this.#snapshot.intentPhase === "uncertain" &&
        !changed
      ) {
        this.#update({ retryable: intent.retryable });
      }
    }
    if (changedHost && this.#ready && this.#snapshot.request)
      void this.restoreSource();
    if (changedHost && this.#ready && this.#source) {
      this.#binding = key(this.#source);
      void this.refresh();
    }
    this.#update();
  }
  canSelect(choice: ConceptImageChoice): boolean {
    const record = this.#record,
      generation = record?.generation;
    return (
      this.#ready &&
      this.#active &&
      !this.#blocked &&
      !this.#disposed &&
      this.#host !== null &&
      !this.locked &&
      this.#write === null &&
      (this.#snapshot.intentPhase === null ||
        this.#snapshot.intentPhase === "accepted") &&
      this.#snapshot.phase === "ready" &&
      this.#snapshot.current !== null &&
      this.#snapshot.recovery === "idle" &&
      record?.phase === "ready" &&
      generation !== null &&
      generation !== undefined &&
      sourceKey(choice.reference) === sourceKey(this.#source) &&
      sourceKey(record.source) === sourceKey(choice.reference) &&
      sourceKey(generation) === sourceKey(choice.reference) &&
      generation.task.operations.some(
        (operation) =>
          operation.operationId === choice.operationId &&
          operation.operationRevision === choice.operationRevision &&
          operation.sourceRunId === generation.task.runId &&
          operation.status === "succeeded" &&
          operation.images.some(
            (image) => image.resultIndex === choice.resultIndex,
          ),
      )
    );
  }
  isCurrent(choice: ConceptImageChoice): boolean {
    const selected =
      this.#snapshot.phase === "ready" ? this.#snapshot.current?.current : null;
    return Boolean(
      selected &&
        sourceKey(selected.reference) === sourceKey(choice.reference) &&
        selected.operationId === choice.operationId &&
        selected.operationRevision === choice.operationRevision &&
        selected.resultIndex === choice.resultIndex,
    );
  }
  async select(choice: ConceptImageChoice) {
    if (!this.canSelect(choice)) return;
    const request: ProjectGenerationSelectionUiInput = Object.freeze({
      reference: Object.freeze({ ...this.#source! }),
      operationId: choice.operationId,
      expectedOperationRevision: choice.operationRevision,
      resultIndex: choice.resultIndex,
      expectedSelectionRevision: this.#snapshot.current!.selectionRevision,
      idempotencyKey: crypto.randomUUID(),
    });
    this.#read?.abort();
    this.#update({
      phase: "idle",
      current: null,
      request,
      receipt: null,
      intentPhase: "pending",
      retryable: false,
      reason: null,
    });
    await this.#submit(request);
  }
  get canRetry() {
    const request = this.#snapshot.request,
      intent = this.#host?.intent;
    return Boolean(
      request &&
        this.#ready &&
        !(this.#originalRetryBlocked?.() ?? this.#blocked) &&
        !this.#disposed &&
        !this.#write &&
        this.#snapshot.intentPhase === "uncertain" &&
        this.#snapshot.retryable &&
        intent?.phase === "uncertain" &&
        key(intent.request) === key(request) &&
        this.#snapshot.recovery === "idle" &&
        sourceKey(this.#source) === sourceKey(request.reference),
    );
  }
  async retry() {
    if (!this.canRetry) return;
    const request = this.#snapshot.request!;
    this.#update({ intentPhase: "pending", retryable: false, reason: null });
    await this.#submit(request);
  }
  async #submit(request: ProjectGenerationSelectionUiInput) {
    const controller = new AbortController(),
      lifetime = this.#lifetime;
    this.#write = controller;
    const current = () =>
      !this.#disposed &&
      this.#ready &&
      lifetime === this.#lifetime &&
      !controller.signal.aborted &&
      this.#write === controller &&
      key(this.#snapshot.request) === key(request);
    try {
      const receipt = await this.#select(request, {
        signal: controller.signal,
      });
      if (current() && this.#snapshot.intentPhase !== "accepted") {
        this.#update({
          intentPhase: "accepted",
          receipt,
          retryable: false,
          reason: null,
        });
        await this.refresh();
      }
    } catch {
      if (
        current() &&
        this.#snapshot.intentPhase !== "accepted" &&
        this.#snapshot.intentPhase !== "refused"
      ) {
        this.#update({
          intentPhase: "uncertain",
          retryable:
            this.#host?.intent?.phase === "uncertain" &&
            this.#host.intent.retryable &&
            key(this.#host.intent.request) === key(request),
          reason: null,
        });
      }
    } finally {
      if (this.#write === controller) {
        this.#write = null;
        this.#update();
      }
    }
  }
  async refresh(): Promise<boolean> {
    const source = this.#source;
    if (!this.#ready || !this.#host || !source || this.#disposed) return false;
    this.#read?.abort();
    const controller = new AbortController(),
      lifetime = this.#lifetime,
      family = assetKey(source);
    this.#read = controller;
    const current = () =>
      !this.#disposed &&
      this.#ready &&
      this.#host !== null &&
      lifetime === this.#lifetime &&
      !controller.signal.aborted &&
      this.#read === controller &&
      assetKey(this.#source) === family;
    this.#update({ phase: "loading", current: null });
    try {
      const response = await this.#get(
        { projectId: source.projectId, assetId: source.assetId },
        { signal: controller.signal },
      );
      if (!current()) return false;
      this.#update({ phase: "ready", current: response });
      return true;
    } catch {
      if (current()) this.#update({ phase: "unavailable", current: null });
      return false;
    } finally {
      if (this.#read === controller) this.#read = null;
    }
  }
  async restoreSource(): Promise<boolean> {
    const request = this.#snapshot.request;
    if (
      !request ||
      !this.#ready ||
      !this.#host ||
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
    if (restored) await this.refresh();
    return restored;
  }
  async refreshRefused() {
    if (
      this.#snapshot.intentPhase !== "refused" ||
      !(await this.restoreSource()) ||
      this.#snapshot.phase !== "ready"
    )
      return;
    // The old command was definitively refused. A new key requires another explicit image click.
    this.#update({
      intentPhase: null,
      request: null,
      receipt: null,
      retryable: false,
      reason: null,
    });
  }
  resume() {
    if (this.#snapshot.request) void this.restoreSource();
  }
  dispose() {
    this.#disposed = true;
    ++this.#lifetime;
    ++this.#recoveryEpoch;
    this.#read?.abort();
    this.#write?.abort();
    this.#listeners.clear();
  }
}
