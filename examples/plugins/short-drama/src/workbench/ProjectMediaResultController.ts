import type {
  PluginMediaResultClient,
  ProjectMediaResultPreview,
  ProjectMediaResultSummary,
} from "../project-media-results-service";
type Snapshot = Readonly<{
  projectId: string | null;
  phase: "idle" | "loading" | "ready" | "unavailable";
  candidates: readonly ProjectMediaResultSummary[];
  nextCandidateId: string | null;
  preview: ProjectMediaResultPreview | null;
  previewing: string | null;
  error: string | null;
}>;
const initial = (): Snapshot => ({
  projectId: null,
  phase: "idle",
  candidates: [],
  nextCandidateId: null,
  preview: null,
  previewing: null,
  error: null,
});
/** Bounded metadata pages and one preview, owned solely by the current plugin project. */
export class ProjectMediaResultController {
  #state = initial();
  #ready = false;
  #disposed = false;
  #epoch = 0;
  #read?: AbortController;
  #preview?: AbortController;
  #listeners = new Set<() => void>();
  constructor(readonly client: PluginMediaResultClient) {}
  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  get canRead() {
    return this.#ready && !this.#disposed && this.#state.projectId !== null;
  }
  setReady(ready: boolean) {
    if (this.#ready === ready || this.#disposed) return;
    this.#ready = ready;
    if (!ready) {
      this.#cancel();
      this.#set({
        phase: "unavailable",
        candidates: [],
        nextCandidateId: null,
      });
    } else this.#set({ phase: "idle", error: null });
  }
  setProject(projectId: string | null) {
    if (this.#disposed || projectId === this.#state.projectId) return;
    this.#cancel();
    this.#state = { ...initial(), projectId };
    this.#emit();
  }
  async refresh(more = false) {
    if (
      !this.canRead ||
      this.#state.phase === "loading" ||
      (more &&
        (!this.#state.nextCandidateId || this.#state.candidates.length >= 64))
    )
      return;
    this.#read?.abort();
    const request = {
      projectId: this.#state.projectId!,
      afterCandidateId: more ? this.#state.nextCandidateId : null,
      limit: 16,
    };
    const controller = (this.#read = new AbortController()),
      epoch = this.#epoch;
    if (!more) this.closePreview();
    this.#set({ phase: "loading", error: null });
    try {
      const result = await this.client.listCandidates(request, {
        signal: controller.signal,
      });
      if (!this.#current(epoch, controller)) return;
      this.#set({
        phase: "ready",
        candidates: more
          ? [...this.#state.candidates, ...result.candidates]
          : result.candidates,
        nextCandidateId: result.nextCandidateId,
      });
    } catch {
      if (this.#current(epoch, controller))
        this.#set({
          phase: "unavailable",
          error: "暂时无法读取已保存结果，请稍后重试。",
        });
    }
  }
  async preview(candidateId: string) {
    const candidate = this.#state.candidates.find(
      (c) => c.candidateId === candidateId,
    );
    if (!candidate) return;
    return this.previewCandidate(candidate);
  }
  async previewCandidate(candidate: ProjectMediaResultSummary) {
    if (!this.canRead || candidate.projectId !== this.#state.projectId) return;
    const candidateId = candidate.candidateId;
    this.closePreview();
    const controller = (this.#preview = new AbortController()),
      epoch = this.#epoch;
    this.#set({ previewing: candidateId, error: null });
    try {
      const result = await this.client.preview(
        {
          projectId: candidate.projectId,
          runId: candidate.runId,
          resultIndex: candidate.resultIndex,
        },
        { signal: controller.signal },
      );
      if (!this.#current(epoch, controller)) {
        if (result) void this.client.releasePreview(result.url).catch(() => {});
        return;
      }
      if (
        result &&
        JSON.stringify(result.candidate) !== JSON.stringify(candidate)
      ) {
        void this.client.releasePreview(result.url).catch(() => {});
        throw new Error("media_result_candidate_changed");
      }
      this.#set({
        preview: result,
        previewing: null,
        error: result ? null : "图片当前不可用，请刷新结果后重试。",
      });
    } catch {
      if (this.#current(epoch, controller))
        this.#set({
          previewing: null,
          error: "图片暂时无法预览，请刷新结果后重试。",
        });
    }
  }
  closePreview() {
    this.#preview?.abort();
    const previous = this.#state.preview;
    if (previous) void this.client.releasePreview(previous.url).catch(() => {});
    this.#set({ preview: null, previewing: null });
  }
  #cancel() {
    ++this.#epoch;
    this.#read?.abort();
    this.closePreview();
  }
  #current(epoch: number, controller: AbortController) {
    return (
      !this.#disposed &&
      this.#ready &&
      epoch === this.#epoch &&
      !controller.signal.aborted
    );
  }
  #set(patch: Partial<Snapshot>) {
    this.#state = { ...this.#state, ...patch };
    this.#emit();
  }
  #emit() {
    for (const listener of this.#listeners) listener();
  }
  dispose() {
    if (this.#disposed) return;
    this.#cancel();
    this.#disposed = true;
    this.#state = initial();
    this.#listeners.clear();
  }
}
