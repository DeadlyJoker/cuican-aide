import type {
  PluginProjectAssetRecoveryClient,
  ProjectAssetRecoveryIntent,
} from "../project-asset-recovery-v2-service";
export type AssetRecoverySnapshot = Readonly<{
  phase: "waiting" | "loading" | "ready" | "unavailable";
  intent: ProjectAssetRecoveryIntent | null;
  acknowledging: boolean;
  cancelling: boolean;
  error: string | null;
}>;

/** Independent durable metadata journal. Reconnecting reads only; it never repeats a mutation. */
export class ProjectAssetRecoveryController {
  readonly #client: PluginProjectAssetRecoveryClient;
  readonly #physicalWritesPending: () => boolean;
  readonly #listeners = new Set<() => void>();
  #snapshot: AssetRecoverySnapshot = {
    phase: "waiting",
    intent: null,
    acknowledging: false,
    cancelling: false,
    error: null,
  };
  #ready = false;
  #disposed = false;
  #epoch = 0;
  #read: AbortController | null = null;
  #write: AbortController | null = null;
  #unconfirmedAck: ProjectAssetRecoveryIntent | null = null;
  constructor(input: {
    client: PluginProjectAssetRecoveryClient;
    physicalWritesPending(): boolean;
  }) {
    this.#client = input.client;
    this.#physicalWritesPending = input.physicalWritesPending;
  }
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly getSnapshot = () => this.#snapshot;
  get permitsNewWrite() {
    return (
      this.#ready &&
      !this.#disposed &&
      this.#snapshot.phase === "ready" &&
      this.#snapshot.intent === null &&
      !this.#snapshot.acknowledging &&
      !this.#snapshot.cancelling &&
      !this.#physicalWritesPending()
    );
  }
  #publish(patch: Partial<AssetRecoverySnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  setReady(ready: boolean) {
    if (ready === this.#ready || this.#disposed) return;
    this.#ready = ready;
    ++this.#epoch;
    this.#read?.abort();
    this.#write?.abort();
    this.#read = null;
    this.#write = null;
    this.#publish({
      phase: ready ? "loading" : "waiting",
      acknowledging: false,
      cancelling: false,
    });
    if (ready) void this.check();
  }
  async check() {
    if (
      !this.#ready ||
      this.#disposed ||
      this.#snapshot.acknowledging ||
      this.#snapshot.cancelling
    )
      return null;
    this.#read?.abort();
    const request = new AbortController(),
      epoch = this.#epoch;
    this.#read = request;
    this.#publish({ phase: "loading", error: null });
    try {
      const { intent } = await this.#client.getPending(
        {},
        { signal: request.signal },
      );
      if (!this.#current(request, epoch)) return null;
      // An empty read does not turn a lost ACK response into a confirmed ACK.
      const retained = intent ?? this.#unconfirmedAck;
      this.#publish({ phase: "ready", intent: retained });
      return retained;
    } catch {
      if (this.#current(request, epoch))
        this.#publish({
          phase: "unavailable",
          error: "上次资产保存的结果暂时无法读取，请重新检查。",
        });
      return null;
    } finally {
      if (this.#read === request) this.#read = null;
    }
  }
  #current(request: AbortController, epoch: number) {
    return (
      !this.#disposed &&
      this.#ready &&
      !request.signal.aborted &&
      epoch === this.#epoch
    );
  }
  async cancelPending(): Promise<void> {
    const actual = this.#snapshot.intent;
    if (
      !actual ||
      actual.phase !== "pending" ||
      this.#snapshot.phase !== "ready" ||
      !this.#ready ||
      this.#disposed ||
      this.#snapshot.acknowledging ||
      this.#snapshot.cancelling ||
      this.#physicalWritesPending()
    )
      return;
    this.#read?.abort();
    const request = new AbortController(),
      epoch = this.#epoch;
    this.#write = request;
    this.#publish({ cancelling: true, error: null });
    try {
      const { intent } = await this.#client.cancelPending(
        { intentId: actual.intentId, expectedRevision: actual.revision },
        { signal: request.signal },
      );
      if (!this.#current(request, epoch)) return;
      // A concurrent commit wins over cancellation; never turn that receipt into a cancelled write.
      this.#publish({ intent, cancelling: false });
      await this.check();
    } catch {
      if (this.#current(request, epoch))
        this.#publish({
          error: "取消结果尚未确认，请重新读取原记录后继续。",
        });
    } finally {
      if (this.#write === request) this.#write = null;
      if (!this.#disposed && this.#ready && epoch === this.#epoch)
        this.#publish({ cancelling: false });
    }
  }
  async acknowledge(
    expected: ProjectAssetRecoveryIntent,
    guard?: Readonly<{
      isCurrent(): boolean;
      signal: AbortSignal;
      onAcknowledged?(): void;
    }>,
  ): Promise<boolean> {
    const actual = this.#snapshot.intent;
    if (
      !actual ||
      actual.phase === "pending" ||
      actual.intentId !== expected.intentId ||
      actual.revision !== expected.revision ||
      this.#snapshot.phase !== "ready" ||
      this.#snapshot.acknowledging ||
      this.#snapshot.cancelling ||
      !this.#ready ||
      this.#physicalWritesPending() ||
      (guard !== undefined && (!guard.isCurrent() || guard.signal.aborted))
    )
      return false;
    const request = new AbortController(),
      epoch = this.#epoch;
    const withdraw = () => request.abort();
    guard?.signal.addEventListener("abort", withdraw, { once: true });
    const current = () =>
      this.#current(request, epoch) && (guard?.isCurrent() ?? true);
    this.#write = request;
    this.#unconfirmedAck = structuredClone(actual);
    this.#publish({ acknowledging: true, error: null });
    try {
      await this.#client.acknowledge(
        { intentId: actual.intentId, expectedRevision: actual.revision },
        { signal: request.signal },
      );
      if (!current()) return false;
      this.#unconfirmedAck = null;
      guard?.onAcknowledged?.();
      this.#publish({ acknowledging: false });
      await this.check();
      return (
        current() &&
        this.#snapshot.phase === "ready" &&
        this.#snapshot.intent === null
      );
    } catch {
      if (current())
        this.#publish({
          acknowledging: false,
          error: "核对结果尚未确认，请重新读取原保存记录。",
        });
      return false;
    } finally {
      guard?.signal.removeEventListener("abort", withdraw);
      if (this.#write === request) this.#write = null;
      if (!this.#disposed && this.#ready && epoch === this.#epoch)
        this.#publish({ acknowledging: false });
    }
  }
  dispose() {
    if (this.#disposed) return;
    ++this.#epoch;
    this.#read?.abort();
    this.#write?.abort();
    this.#disposed = true;
    this.#listeners.clear();
  }
}
