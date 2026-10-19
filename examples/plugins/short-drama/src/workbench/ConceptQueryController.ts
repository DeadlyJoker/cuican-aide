import type {
  PluginProjectGenerationQueryClient,
  ProjectGenerationQueryHostContext,
} from "@crewon/plugin-sdk/ui";
import type {
  ConceptGenerationLocator,
  ProjectGenerationQueryUiInput,
  ProjectGenerationQueryUiReceipt,
} from "@crewon/plugin-sdk/contracts";
import type {
  PluginProjectHistoricalQueryClient,
  ProjectHistoricalQueryHostContext,
} from "../plugin-project-historical-queries-service";
import type { ConceptGenerationSnapshot } from "./ConceptGenerationController";
import type { ConceptOriginalRetryPolicy } from "./ConceptImageSelectionController.types";
export type ConceptQuerySnapshot = Readonly<{
  intentPhase: "pending" | "uncertain" | "accepted" | "refused" | null;
  request: ProjectGenerationQueryUiInput | null;
  receipt: ProjectGenerationQueryUiReceipt | null;
  retryable: boolean;
  recovery: "idle" | "loading" | "unavailable";
  reason: string | null;
}>;
const initial = (): ConceptQuerySnapshot => ({
  intentPhase: null,
  request: null,
  receipt: null,
  retryable: false,
  recovery: "idle",
  reason: null,
});
const key = (value: unknown) => JSON.stringify(value);
const sourceKey = (value: ConceptGenerationLocator | null | undefined) =>
  value ? key([value.projectId, value.assetId, value.assetRevision]) : null;

/** Owns one exact query intent, independently from paid generation and its original receipt. */
export class ConceptQueryController {
  readonly lane: "self" | "historical";
  readonly #sourcePluginId: string | null;
  readonly #query: PluginProjectGenerationQueryClient["queryConceptGeneration"];
  readonly #ports: Readonly<{
    lockChanged(): void;
    accepted(
      request: ProjectGenerationQueryUiInput,
      receipt: ProjectGenerationQueryUiReceipt,
    ): void;
    restore(request: ProjectGenerationQueryUiInput): Promise<boolean>;
    restored(): void;
  }>;
  readonly #listeners = new Set<() => void>();
  #snapshot = initial();
  #host:
    | ProjectGenerationQueryHostContext
    | ProjectHistoricalQueryHostContext
    | null = null;
  #seenIntent: string | null = null;
  #hostProjectId: string | null = null;
  #source: ConceptGenerationLocator | null = null;
  #record: ConceptGenerationSnapshot | null = null;
  #ready = false;
  #blocked = false;
  #originalRetryBlocked: (() => boolean) | null = null;
  #disposed = false;
  #write: AbortController | null = null;
  #recoveryEpoch = 0;
  constructor(ports: {
    client:
      | PluginProjectGenerationQueryClient
      | PluginProjectHistoricalQueryClient;
    lane?: "self" | "historical";
    sourcePluginId?: string;
    lockChanged(): void;
    accepted(
      request: ProjectGenerationQueryUiInput,
      receipt: ProjectGenerationQueryUiReceipt,
    ): void;
    restore(request: ProjectGenerationQueryUiInput): Promise<boolean>;
    restored(): void;
  }) {
    this.lane = ports.lane ?? "self";
    this.#sourcePluginId = ports.sourcePluginId ?? null;
    this.#query = ports.client.queryConceptGeneration.bind(ports.client);
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
  get supportsRecord(): boolean {
    const pluginId = this.#record?.generation?.task.pluginId;
    if (!pluginId) return false;
    if (this.#sourcePluginId === null) return this.lane === "self";
    return this.lane === "self"
      ? pluginId === this.#sourcePluginId
      : pluginId !== this.#sourcePluginId;
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
  refreshOriginalRetryGate() {
    this.#update();
  }
  #update(change: Partial<ConceptQuerySnapshot> = {}) {
    if (this.#disposed) return;
    const locked = this.locked;
    this.#snapshot = { ...this.#snapshot, ...change };
    if (locked !== this.locked) this.#ports.lockChanged();
    for (const listener of this.#listeners) listener();
  }
  bindSource(
    source: ConceptGenerationLocator | null,
    ready: boolean,
    blocked: boolean,
    retryPolicy?: ConceptOriginalRetryPolicy,
  ) {
    if (this.#disposed) return;
    const wasReady = this.#ready;
    this.#ready = ready;
    this.#blocked = blocked;
    this.#originalRetryBlocked = retryPolicy
      ? retryPolicy.originalRetryBlocked.bind(retryPolicy)
      : null;
    this.#source = source ? Object.freeze({ ...source }) : null;
    if (!ready) {
      this.#write?.abort();
      if (this.#snapshot.intentPhase === "pending")
        this.#update({ intentPhase: "uncertain", retryable: false });
      if (wasReady) {
        ++this.#recoveryEpoch;
        this.#update({ recovery: "idle" });
      }
    }
    if (
      source &&
      this.#snapshot.request &&
      sourceKey(source) !== sourceKey(this.#snapshot.request.reference) &&
      !this.locked
    )
      this.#update(initial());
    else this.#update();
  }
  setRecord(record: ConceptGenerationSnapshot) {
    this.#record = record;
    this.#update();
  }
  setHostContext(
    context:
      | ProjectGenerationQueryHostContext
      | ProjectHistoricalQueryHostContext
      | null,
  ) {
    if (this.#disposed) return;
    const matching =
      context &&
      (this.lane === "historical"
        ? context.version ===
            "crewon.project-historical-query-host-context.v1" &&
          "recovery" in context &&
          context.recovery === "session-only"
        : context.version ===
          "crewon.project-generation-query-host-context.v1");
    this.#host = matching ? context : null;
    const intent = this.#host?.intent;
    if (!intent) {
      if (this.locked) this.#update({ retryable: false });
      else this.#update();
      return;
    }
    const signature = key(intent),
      request = this.#snapshot.request,
      changed = !request || key(request) !== key(intent.request);
    if (this.locked && changed) {
      this.#update({
        retryable: false,
        reason: "原查询尚未确认，请先恢复原查询。",
      });
      return;
    }
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
        if (intent.phase === "accepted" && intent.receipt)
          this.#ports.accepted(intent.request, intent.receipt);
      }
    } else if (
      this.#snapshot.intentPhase === "uncertain" &&
      intent.phase === "uncertain" &&
      !changed &&
      this.#snapshot.retryable !== intent.retryable
    )
      this.#update({ retryable: intent.retryable });
    else this.#update();
  }
  canQuery(operationId: string): boolean {
    const record = this.#record,
      thread = this.#host?.thread,
      receipt = this.#snapshot.receipt;
    return (
      this.#ready &&
      this.supportsRecord &&
      !this.#blocked &&
      !this.#disposed &&
      !this.locked &&
      this.#snapshot.recovery === "idle" &&
      (this.#snapshot.intentPhase === null ||
        this.#snapshot.intentPhase === "accepted") &&
      this.#write === null &&
      this.#host?.threadReady === true &&
      thread !== null &&
      thread !== undefined &&
      this.#source !== null &&
      record?.phase === "ready" &&
      record.generation !== null &&
      sourceKey(record.source) === sourceKey(this.#source) &&
      record.generation.task.operations.some(
        (op) =>
          op.operationId === operationId &&
          op.sourceRunId === record.generation!.task.runId,
      ) &&
      !(
        receipt &&
        receipt.threadId === thread.threadId &&
        thread.revision < receipt.threadRevision
      )
    );
  }
  /** A page switch leaves the original host journal available in its project. */
  setHostProjectScope(projectId: string | null) {
    this.#hostProjectId = projectId;
    if (
      this.#disposed ||
      !projectId ||
      this.#write ||
      !this.#snapshot.request ||
      this.#snapshot.request.reference.projectId === projectId
    )
      return;
    ++this.#recoveryEpoch;
    this.#host = null;
    this.#seenIntent = null;
    this.#update(initial());
  }
  async query(operationId: string) {
    if (!this.canQuery(operationId)) return;
    const thread = this.#host!.thread!;
    const request: ProjectGenerationQueryUiInput = Object.freeze({
      reference: Object.freeze({ ...this.#source! }),
      operationId,
      threadId: thread.threadId,
      expectedThreadRevision: thread.revision,
      idempotencyKey: crypto.randomUUID(),
    });
    this.#update({
      intentPhase: "pending",
      request,
      receipt: null,
      retryable: false,
      recovery: "idle",
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
        !this.#disposed &&
        !(this.#originalRetryBlocked?.() ?? this.#blocked) &&
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
  async #submit(request: ProjectGenerationQueryUiInput) {
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
      const receipt = await this.#query(request, { signal: controller.signal });
      if (current()) {
        this.#update({
          intentPhase: "accepted",
          receipt,
          retryable: false,
          reason: null,
        });
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
          reason: null,
        });
    } finally {
      if (this.#write === controller) {
        const locked = this.locked;
        this.#write = null;
        this.setHostProjectScope(this.#hostProjectId);
        this.#update();
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
    this.#update(initial());
  }
  resume() {
    if (this.#snapshot.request) void this.restoreSource();
  }
  dispose() {
    this.#disposed = true;
    ++this.#recoveryEpoch;
    this.#write?.abort();
    this.#listeners.clear();
  }
}
