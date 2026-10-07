import type {
  MediaGenerationClient,
  MediaGenerationRequest,
  MediaGenerationReceipt,
} from "../project-media-generations-service";
import type { PluginProjectConversationsClient } from "../project-conversations-service";
import type { PublicMediaInput } from "../project-media-inputs-ui-client";
import type { ProjectDetails } from "./creative-project-controller";
type Thread = Readonly<{ threadId: string; revision: number }>;
type Snapshot = Readonly<{
  phase: "waiting" | "loading" | "ready" | "unavailable";
  status: "idle" | "checking" | "preparing" | "uncertain" | "accepted";
  request: MediaGenerationRequest | null;
  receipt: MediaGenerationReceipt | null;
  retryable: boolean;
  error: string | null;
}>;
const initial = (): Snapshot => ({
  phase: "waiting",
  status: "idle",
  request: null,
  receipt: null,
  retryable: false,
  error: null,
});

/** Keeps the exact request; only explicit generate/retry dispatches. Recovery itself never executes. */
export class ProjectMediaGenerationController {
  readonly #client: MediaGenerationClient;
  readonly #conversations: Pick<
    PluginProjectConversationsClient,
    "getBinding" | "openConversation"
  >;
  readonly #busy: () => boolean;
  readonly #listeners = new Set<() => void>();
  #snapshot = initial();
  #project: ProjectDetails | null = null;
  #input: PublicMediaInput | null = null;
  #inputBlocked = true;
  #thread: Thread | null = null;
  #ready = false;
  #active = false;
  #disposed = false;
  #epoch = 0;
  #read: AbortController | null = null;
  #write: AbortController | null = null;
  constructor(input: {
    client: MediaGenerationClient;
    conversations: Pick<
      PluginProjectConversationsClient,
      "getBinding" | "openConversation"
    >;
    physicalWritesPending(): boolean;
  }) {
    this.#client = input.client;
    this.#conversations = input.conversations;
    this.#busy = input.physicalWritesPending;
  }
  readonly getSnapshot = () => this.#snapshot;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  get locked() {
    return (
      this.#write !== null ||
      (this.#snapshot.status === "uncertain" &&
        this.#snapshot.request?.projectId === this.#project?.project.projectId)
    );
  }
  get canGenerate() {
    return (
      this.#ready &&
      this.#active &&
      !this.#disposed &&
      !this.#read &&
      !this.#write &&
      !this.#busy() &&
      this.#snapshot.phase === "ready" &&
      this.#snapshot.status !== "uncertain" &&
      this.#project?.project.state === "active" &&
      this.#input !== null &&
      this.#input.projectId === this.#project.project.projectId &&
      !this.#inputBlocked &&
      this.#thread !== null
    );
  }
  get canRetry() {
    return (
      this.#ready &&
      !this.#disposed &&
      !this.#read &&
      !this.#write &&
      !this.#busy() &&
      this.#snapshot.status === "uncertain" &&
      this.#snapshot.retryable &&
      this.#snapshot.request?.projectId === this.#project?.project.projectId
    );
  }
  get hasThread() {
    return this.#thread !== null;
  }
  get foreignIntent() {
    return (
      this.#snapshot.request !== null &&
      this.#snapshot.request.projectId !== this.#project?.project.projectId
    );
  }
  refreshWriteActivity() {
    this.#emit({});
  }
  setProject(project: ProjectDetails | null) {
    if (this.#disposed) return;
    const changed =
      project?.project.projectId !== this.#project?.project.projectId;
    this.#project = project;
    if (changed) {
      ++this.#epoch;
      this.#read?.abort();
      this.#read = null;
      this.#write?.abort();
      this.#input = null;
      this.#inputBlocked = true;
      this.#snapshot = initial();
      if (this.#active && this.#ready) void this.recover();
    }
    this.#emit({});
  }
  setInput(input: PublicMediaInput | null, blocked: boolean) {
    this.#input = input;
    this.#inputBlocked = blocked;
    this.#emit({});
  }
  setThread(thread: Thread | null) {
    if (this.#disposed) return;
    if (thread?.threadId !== this.#thread?.threadId && this.#write)
      this.cancel();
    this.#thread = thread
      ? {
          ...thread,
          revision:
            this.#thread?.threadId === thread.threadId
              ? Math.max(this.#thread.revision, thread.revision)
              : thread.revision,
        }
      : null;
    this.#emit({});
  }
  setReady(ready: boolean) {
    if (this.#disposed || this.#ready === ready) return;
    this.#ready = ready;
    if (!ready) {
      ++this.#epoch;
      this.#read?.abort();
      this.#read = null;
      this.cancel();
      this.#emit({ phase: "waiting" });
    } else if (this.#active) void this.recover();
  }
  activate() {
    if (this.#disposed || this.#active) return;
    this.#active = true;
    if (this.#ready) void this.recover();
  }
  async recover() {
    if (!this.#ready || this.#disposed || this.#write || this.#busy()) return;
    this.#read?.abort();
    const controller = new AbortController(),
      epoch = this.#epoch;
    this.#read = controller;
    const current = () =>
      !this.#disposed &&
      this.#ready &&
      this.#read === controller &&
      !controller.signal.aborted &&
      epoch === this.#epoch;
    this.#emit({ phase: "loading", error: null });
    try {
      const { intent } = await this.#client.recover({
        signal: controller.signal,
      });
      if (!current()) return;
      if (intent?.phase === "refused")
        this.#emit({
          phase: "ready",
          status: "idle",
          request: null,
          receipt: null,
          retryable: false,
          error:
            intent.request.input.projectId === this.#project?.project.projectId
              ? "已确认原请求尚未创建任务。请检查输入和执行准备后，重新生成。"
              : null,
        });
      else if (
        intent?.phase === "accepted" &&
        intent.request.input.projectId !== this.#project?.project.projectId
      )
        this.#emit({
          phase: "ready",
          status: "idle",
          request: null,
          receipt: null,
          retryable: false,
        });
      else if (intent)
        this.#emit({
          phase: "ready",
          request: intent.request.input,
          receipt: intent.receipt,
          status: intent.phase === "accepted" ? "accepted" : "uncertain",
          retryable: intent.retryable,
          error:
            intent.phase !== "accepted" && !intent.retryable
              ? "原请求的插件版本或权限已变化，请恢复原配置后处理。"
              : null,
        });
      else
        this.#emit({
          phase: "ready",
          retryable:
            this.#snapshot.request !== null &&
            this.#snapshot.status === "uncertain",
        });
    } catch {
      if (current())
        this.#emit({
          phase: "unavailable",
          error: "暂时无法读取生成记录，请检查插件执行准备后重试。",
        });
    } finally {
      if (this.#read === controller) {
        this.#read = null;
        this.#emit({});
      }
    }
  }
  async generate() {
    if (!this.canGenerate) return;
    const input = this.#input!,
      thread = this.#thread!,
      epoch = this.#epoch,
      controller = new AbortController();
    this.#write = controller;
    this.#emit({
      status: "checking",
      request: null,
      receipt: null,
      retryable: false,
      error: null,
    });
    try {
      const { binding } = await this.#conversations.getBinding(
        { threadId: thread.threadId },
        { signal: controller.signal },
      );
      if (
        this.#disposed ||
        !this.#ready ||
        controller.signal.aborted ||
        epoch !== this.#epoch
      )
        return;
      if (this.#input !== input || this.#inputBlocked) {
        this.#emit({ status: "idle", error: "输入已变化，请确认后重新生成。" });
        return;
      }
      if (
        !binding ||
        binding.state !== "active" ||
        binding.projectId !== input.projectId
      ) {
        this.#emit({
          status: "idle",
          error: "当前会话没有关联这个项目，请先在项目会话中打开或关联会话。",
        });
        return;
      }
      const request: MediaGenerationRequest = Object.freeze({
        projectId: input.projectId,
        mediaInputId: input.mediaInputId,
        inputRevision: input.inputRevision,
        expectedInputRevision: input.inputRevision,
        executionId: crypto.randomUUID(),
        threadId: thread.threadId,
        expectedThreadRevision: thread.revision,
        idempotencyKey: crypto.randomUUID(),
      });
      this.#emit({
        status: "preparing",
        request,
        receipt: null,
        retryable: false,
      });
      await this.#submit(request, controller, epoch);
    } catch {
      if (
        !this.#disposed &&
        epoch === this.#epoch &&
        this.#snapshot.status === "checking"
      )
        this.#emit({
          status: "idle",
          error: "无法确认项目会话，请刷新后重试。",
        });
    } finally {
      if (this.#write === controller) {
        this.#write = null;
        this.#emit(
          this.#snapshot.status === "checking" ? { status: "idle" } : {},
        );
      }
    }
  }
  async retry() {
    if (!this.canRetry) return;
    const controller = new AbortController(),
      epoch = this.#epoch;
    this.#write = controller;
    this.#emit({ status: "preparing", retryable: false, error: null });
    try {
      await this.#submit(this.#snapshot.request!, controller, epoch);
    } finally {
      if (this.#write === controller) {
        this.#write = null;
        this.#emit({});
      }
    }
  }
  async #submit(
    request: MediaGenerationRequest,
    controller: AbortController,
    epoch: number,
  ) {
    try {
      const receipt = await this.#client.generate(request, {
        signal: controller.signal,
      });
      if (this.#disposed || epoch !== this.#epoch || !this.#ready) return;
      this.#emit({
        status: "accepted",
        receipt,
        retryable: false,
        error: null,
      });
      if (this.#thread?.threadId === receipt.threadId)
        this.#thread = {
          threadId: receipt.threadId,
          revision: Math.max(this.#thread.revision, receipt.threadRevision),
        };
    } catch {
      if (!this.#disposed && epoch === this.#epoch)
        this.#emit({
          status: "uncertain",
          retryable: false,
          error: controller.signal.aborted
            ? "已停止等待。任务可能已经受理，请先恢复原请求状态。"
            : "暂未取得任务回执，请恢复原请求状态后重试。",
        });
    }
  }
  cancel() {
    this.#write?.abort();
    if (
      this.#snapshot.request &&
      ["checking", "preparing"].includes(this.#snapshot.status)
    )
      this.#emit({ status: "uncertain", retryable: false });
  }
  async openConversation() {
    const r = this.#snapshot.receipt;
    if (!r || !this.#ready || this.#disposed || this.#write) return;
    try {
      await this.#conversations.openConversation({
        projectId: r.projectId,
        threadId: r.threadId,
      });
    } catch {
      this.#emit({ error: "暂时无法打开项目会话，请稍后重试。" });
    }
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    ++this.#epoch;
    this.#read?.abort();
    this.#write?.abort();
    this.#listeners.clear();
  }
  #emit(patch: Partial<Snapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
