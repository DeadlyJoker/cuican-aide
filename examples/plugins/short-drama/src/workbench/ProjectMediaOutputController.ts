import type { MediaGenerationReceipt } from "../project-media-generations-service";
import type {
  PluginMediaResultActionClient,
  ProjectMediaRunOutputs,
  ProjectMediaResultSummary,
} from "../project-media-results-service";
type Source = Pick<
  MediaGenerationReceipt,
  "projectId" | "runId" | "mediaInputId" | "inputRevision"
>;
type Snapshot = Readonly<{
  source: Source | null;
  available: boolean;
  phase: "idle" | "loading" | "ready" | "unavailable";
  outputs: ProjectMediaRunOutputs["outputs"];
  saving: number | null;
  uncertain: number | null;
  retryable: boolean;
  notice: string | null;
  error: string | null;
}>;
const initial = (): Snapshot => ({
  source: null,
  available: false,
  phase: "idle",
  outputs: [],
  saving: null,
  uncertain: null,
  retryable: false,
  notice: null,
  error: null,
});
/** Original receipt and original output positions; no guessed slots, automatic retries or local adoption. */
export class ProjectMediaOutputController {
  #state = initial();
  #disposed = false;
  #epoch = 0;
  #read: AbortController | null = null;
  #write: AbortController | null = null;
  #listeners = new Set<() => void>();
  constructor(
    readonly client: PluginMediaResultActionClient,
    readonly physicalWritesPending: () => boolean,
  ) {}
  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  get locked() {
    return this.#write !== null || this.#state.uncertain !== null;
  }
  get canRead() {
    return (
      !this.#disposed &&
      this.#state.available &&
      this.#state.source !== null &&
      !this.#read &&
      !this.#write &&
      !this.physicalWritesPending()
    );
  }
  canSave(index: number) {
    return (
      this.canRead &&
      this.#state.phase === "ready" &&
      this.#state.uncertain === null &&
      this.#state.outputs.some(
        (o) => o.resultIndex === index && o.candidate === null,
      )
    );
  }
  get canRetry() {
    return (
      this.canRead &&
      this.#state.phase === "ready" &&
      this.#state.uncertain !== null &&
      this.#state.retryable
    );
  }
  refreshWriteActivity() {
    this.#emit({});
  }
  setSource(projectId: string | null, receipt: MediaGenerationReceipt | null) {
    if (this.#disposed) return;
    const source =
      receipt && receipt.projectId === projectId
        ? Object.freeze({
            projectId: receipt.projectId,
            runId: receipt.runId,
            mediaInputId: receipt.mediaInputId,
            inputRevision: receipt.inputRevision,
          })
        : null;
    if (JSON.stringify(source) === JSON.stringify(this.#state.source)) return;
    ++this.#epoch;
    this.#read?.abort();
    this.#read = null;
    this.#write?.abort();
    this.#state = { ...initial(), available: this.#state.available, source };
    this.#emit({});
  }
  setReady(available: boolean) {
    if (this.#disposed || available === this.#state.available) return;
    if (!available) {
      ++this.#epoch;
      this.#read?.abort();
      this.#read = null;
      this.cancel();
      this.#emit({
        available,
        phase: "unavailable",
        outputs: [],
        saving: null,
        retryable: false,
      });
    } else this.#emit({ available, phase: "idle", error: null });
  }
  async refresh() {
    if (!this.canRead) return;
    const source = this.#state.source!,
      epoch = this.#epoch,
      controller = new AbortController();
    this.#read = controller;
    this.#emit({ phase: "loading", error: null, retryable: false });
    try {
      const result = await this.client.listOutputs(
        { projectId: source.projectId, runId: source.runId },
        { signal: controller.signal },
      );
      if (!this.#current(epoch, controller)) return;
      if (
        result.projectId !== source.projectId ||
        result.runId !== source.runId ||
        result.mediaInputId !== source.mediaInputId ||
        result.inputRevision !== source.inputRevision
      )
        throw new Error("media_output_source_changed");
      const pending = this.#state.uncertain;
      const saved =
        pending !== null &&
        result.outputs.find((o) => o.resultIndex === pending)?.candidate !=
          null;
      this.#emit({
        phase: "ready",
        outputs: result.outputs,
        uncertain: saved ? null : pending,
        retryable:
          pending !== null &&
          !saved &&
          result.outputs.some((o) => o.resultIndex === pending),
        notice: saved
          ? "已找到原保存结果。"
          : pending !== null
            ? "暂未找到原保存结果，可以重试原位置。"
            : null,
      });
    } catch {
      if (this.#current(epoch, controller))
        this.#emit({
          phase: "unavailable",
          outputs: [],
          error: "暂时无法读取产出，请稍后刷新，也可在项目会话查看进度。",
        });
    } finally {
      if (this.#read === controller) {
        this.#read = null;
        this.#emit({});
      }
    }
  }
  async save(index: number) {
    if (!this.canSave(index)) return;
    await this.#save(index);
  }
  async retry() {
    if (!this.canRetry) return;
    await this.#save(this.#state.uncertain!);
  }
  async #save(index: number) {
    const source = this.#state.source!,
      epoch = this.#epoch,
      controller = new AbortController();
    this.#write = controller;
    this.#emit({
      saving: index,
      uncertain: index,
      retryable: false,
      notice: null,
      error: null,
    });
    try {
      const result = await this.client.saveCandidate(
        {
          projectId: source.projectId,
          runId: source.runId,
          resultIndex: index,
        },
        { signal: controller.signal },
      );
      if (!this.#current(epoch, controller)) return;
      const c = result.candidate;
      if (
        c.projectId !== source.projectId ||
        c.runId !== source.runId ||
        c.resultIndex !== index ||
        c.mediaInputId !== source.mediaInputId ||
        c.inputRevision !== source.inputRevision
      )
        throw new Error("media_output_save_changed");
      this.#emit({
        outputs: this.#state.outputs.map((o) =>
          o.resultIndex === index ? { resultIndex: index, candidate: c } : o,
        ),
        uncertain: null,
        retryable: false,
        notice:
          result.disposition === "replayed"
            ? "已找到这张图片的原保存结果。"
            : "已保存为项目候选，可以预览图片。",
        error: null,
      });
    } catch {
      if (!this.#disposed && epoch === this.#epoch)
        this.#emit({
          error: "尚未确认保存结果。请先刷新产出，确认原位置的保存状态。",
          retryable: false,
        });
    } finally {
      if (this.#write === controller) {
        this.#write = null;
        if (!this.#disposed && epoch === this.#epoch)
          this.#emit({ saving: null });
        else this.#emit({});
      }
    }
  }
  cancel() {
    if (!this.#write) return;
    this.#write.abort();
    this.#emit({
      retryable: false,
      error: "已停止等待，图片可能已保存。请刷新产出确认。",
    });
  }
  candidate(index: number): ProjectMediaResultSummary | null {
    return (
      this.#state.outputs.find((o) => o.resultIndex === index)?.candidate ??
      null
    );
  }
  #current(epoch: number, controller: AbortController) {
    return (
      !this.#disposed &&
      this.#state.available &&
      epoch === this.#epoch &&
      !controller.signal.aborted
    );
  }
  #emit(patch: Partial<Snapshot>) {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  dispose() {
    if (this.#disposed) return;
    ++this.#epoch;
    this.#disposed = true;
    this.#read?.abort();
    this.#write?.abort();
    this.#state = initial();
    this.#listeners.clear();
  }
}
