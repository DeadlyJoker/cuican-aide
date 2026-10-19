import type {
  PluginProjectTextUiClient,
  PublicProjectTextArtifact,
  PublicProjectTextArtifactView,
  PublicProjectTextRevision,
  ProjectTextMutationResponse,
} from "../project-texts-ui-service";
import type { ProjectDetails } from "./creative-project-controller";
import type { PluginCreativeProjectClient } from "@crewon/plugin-sdk/ui";
import type { PluginProjectTextRecoveryClient } from "../project-text-recovery-service";
import { ProjectTextRecoveryController } from "./ProjectTextRecoveryController";
import { loadProjectTextRecoveryView } from "./ProjectTextRecoveryView";
import { readProjectTextView } from "./ProjectTextViewRead";
import {
  emptyOutline,
  emptyScript,
  outlineValid,
  scriptValid,
  type TextDraft,
} from "./ProjectTextDraft";

import {
  initialTextSnapshot as initial,
  type TextIntent as Intent,
  type TextSnapshot,
  type TextTarget,
} from "./ProjectTextController.types";
export type { TextSnapshot, TextTarget } from "./ProjectTextController.types";
import {
  invokeTextIntent,
  projectTextConflict,
  projectTextMutationProjection,
} from "./ProjectTextMutation";

/** Manual edits use the same immutable text records as Agent tools, through real mount invokes. */
export class ProjectTextController {
  readonly recovery: ProjectTextRecoveryController;
  #client: PluginProjectTextUiClient;
  #projects: Pick<PluginCreativeProjectClient, "getProject" | "getBrief">;
  #details: ProjectDetails | null = null;
  #ready = false;
  #disposed = false;
  #epoch = 0;
  #invalidated = false;
  #backgroundReading = false;
  #preservedDrafts = new Set<string>();
  #snapshot = initial();
  #listeners = new Set<() => void>();
  #reads = new Map<string, AbortController>();
  #write: AbortController | null = null;
  #intent: Intent | null = null;
  #presentedRecovery: string | null = null;
  #drafts = new Map<
    string,
    Readonly<{
      draft: TextDraft;
      dirty: boolean;
      sourceBriefRevision: number | null;
      sourceOutline: TextSnapshot["sourceOutline"];
      content: PublicProjectTextRevision | null;
    }>
  >();
  #physicalWritesPending: () => boolean;
  constructor(ports: {
    client: PluginProjectTextUiClient;
    projects: Pick<PluginCreativeProjectClient, "getProject" | "getBrief">;
    physicalWritesPending?: () => boolean;
    recovery?: PluginProjectTextRecoveryClient;
  }) {
    this.#client = ports.client;
    this.#projects = ports.projects;
    this.#physicalWritesPending = ports.physicalWritesPending ?? (() => false);
    this.recovery = new ProjectTextRecoveryController({
      client: ports.recovery,
      physicalWritesPending: this.#physicalWritesPending,
      changed: () => this.#update({ recovery: this.recovery.getSnapshot() }),
    });
    this.#snapshot = {
      ...this.#snapshot,
      recovery: this.recovery.getSnapshot(),
    };
  }
  getSnapshot = (): TextSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  get locked(): boolean {
    return (
      Boolean(this.#intent) ||
      this.#snapshot.saving ||
      this.recovery.navigationLocked ||
      this.#physicalWritesPending()
    );
  }
  get canSave(): boolean {
    const { draft, target, dirty, opening } = this.#snapshot;
    return (
      this.#available() &&
      !this.locked &&
      !this.recovery.blocksWrites &&
      !opening &&
      dirty &&
      Boolean(draft) &&
      (target.kind === "outline"
        ? outlineValid(draft as Parameters<typeof outlineValid>[0])
        : scriptValid(draft as Parameters<typeof scriptValid>[0]))
    );
  }
  get contentReadBlocked(): boolean {
    return (
      Boolean(this.#intent) ||
      this.#snapshot.saving ||
      this.#physicalWritesPending() ||
      this.recovery.getSnapshot().intent !== null
    );
  }
  get canAcknowledgeRecovery(): boolean {
    const record = this.recovery.getSnapshot().intent;
    return Boolean(
      record &&
        record.phase !== "pending" &&
        `${record.intentId}:${record.revision}` === this.#presentedRecovery &&
        !this.#snapshot.opening &&
        !this.#snapshot.saving,
    );
  }
  setReady(ready: boolean) {
    if (this.#disposed || ready === this.#ready) return;
    this.#ready = ready;
    this.recovery.setReady(ready);
    if (!ready) {
      ++this.#epoch;
      this.#abortReads();
      this.#write?.abort();
      this.#update({
        opening: false,
        loadingHistory: false,
        ...(this.#intent
          ? {
              saving: false,
              failure: "uncertain",
              error: "模块连接已中断，原请求保留；重新连接后可用原请求重试。",
            }
          : {}),
      });
    }
    if (ready && this.#details) void this.refreshRecovery();
  }
  setProject(details: ProjectDetails | null) {
    if (this.#disposed) return;
    if (details?.project.projectId === this.#details?.project.projectId) {
      if (
        !details ||
        !this.#details ||
        details.project.revision >= this.#details.project.revision
      ) {
        this.#details = details;
        this.#update({
          currentBriefRevision: details?.brief.briefRevision ?? null,
          archived: details?.project.state === "archived",
        });
      }
      return;
    }
    // Navigation is disabled while a write is unresolved. Withdrawal still invalidates this owner.
    this.#remember();
    ++this.#epoch;
    this.#abortReads();
    this.#write?.abort();
    this.#details = details;
    this.#invalidated = false;
    this.recovery.setProject(details?.project.projectId ?? null);
    this.#intent = null;
    this.#presentedRecovery = null;
    this.#snapshot = initial();
    this.#snapshot = {
      ...this.#snapshot,
      currentBriefRevision: details?.brief.briefRevision ?? null,
      archived: details?.project.state === "archived",
      recovery: this.recovery.getSnapshot(),
    };
    this.#emit();
    if (this.#ready && details) void this.refreshRecovery();
  }
  refreshWriteActivity() {
    this.#drainInvalidation();
    this.#emit();
  }
  invalidate(projectId: string) {
    if (this.#disposed || projectId !== this.#details?.project.projectId)
      return;
    this.#invalidated = true;
    this.#drainInvalidation();
  }
  #drainInvalidation() {
    if (
      !this.#invalidated ||
      !this.#canRead() ||
      this.contentReadBlocked ||
      this.#snapshot.opening ||
      this.#backgroundReading
    )
      return;
    this.#invalidated = false;
    void this.open(this.#snapshot.target, "background");
  }
  #available() {
    return (
      this.#ready &&
      !this.#disposed &&
      this.#details?.project.state === "active"
    );
  }
  #canRead() {
    return this.#ready && !this.#disposed && Boolean(this.#details);
  }
  #update(update: Partial<TextSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...update };
    this.#emit();
    queueMicrotask(() => this.#drainInvalidation());
  }
  #emit() {
    if (!this.#disposed) for (const listener of this.#listeners) listener();
  }
  #key(target = this.#snapshot.target) {
    return JSON.stringify([
      this.#details?.project.projectId,
      target.kind,
      target.kind === "script" ? target.episodeId : null,
    ]);
  }
  #remember() {
    if (this.#snapshot.dirty && this.#snapshot.content)
      this.#preservedDrafts.add(this.#key());
    if (this.#snapshot.draft)
      this.#drafts.set(this.#key(), {
        draft: this.#snapshot.draft,
        dirty: this.#snapshot.dirty,
        sourceBriefRevision: this.#snapshot.sourceBriefRevision,
        sourceOutline: this.#snapshot.sourceOutline,
        content: this.#snapshot.content,
      });
  }
  #currentOutline(
    target = this.#snapshot.target,
    outlineView = this.#snapshot.outline,
  ): TextSnapshot["sourceOutline"] {
    const revision = outlineView?.selectedRevision;
    return target.kind === "script" &&
      revision?.kind === "outline" &&
      revision.content.episodes.some(
        (episode) => episode.episodeId === target.episodeId,
      )
      ? {
          artifactId: revision.artifactId,
          contentRevision: revision.contentRevision,
        }
      : null;
  }
  #abortReads() {
    for (const read of this.#reads.values()) read.abort();
    this.#reads.clear();
  }
  #reading(lane: string) {
    this.#reads.get(lane)?.abort();
    const controller = new AbortController();
    this.#reads.set(lane, controller);
    const epoch = this.#epoch;
    return {
      controller,
      current: () =>
        this.#canRead() &&
        epoch === this.#epoch &&
        !controller.signal.aborted &&
        this.#reads.get(lane) === controller,
    };
  }
  async open(
    target: TextTarget = this.#snapshot.target,
    mode: "foreground" | "background" = "foreground",
  ) {
    if (!this.#canRead() || this.contentReadBlocked) return;
    const background = mode === "background";
    if (background) this.#backgroundReading = true;
    this.#remember();
    this.#reads.get("view")?.abort();
    this.#reads.get("conflict")?.abort();
    const read = this.#reading("open");
    if (!background) this.#reads.get("history")?.abort();
    const projectId = this.#details!.project.projectId;
    if (!background)
      this.#update({
        target,
        phase: "loading",
        opening: true,
        view: null,
        content: null,
        draft: null,
        dirty: false,
        history: [],
        nextContentRevision: null,
        loadingHistory: false,
        error: null,
        notice: null,
      });
    try {
      const { details, view, outline, content } = await readProjectTextView({
        client: this.#client,
        projects: this.#projects,
        projectId,
        target,
        signal: read.controller.signal,
      });
      if (!read.current()) return;
      if (background && this.contentReadBlocked) {
        this.#invalidated = true;
        return;
      }
      if (details.project.revision >= this.#details!.project.revision)
        this.#details = details;
      if (background) this.#remember();
      const cached = this.#drafts.get(this.#key(target));
      if (!background && !cached?.dirty)
        this.#preservedDrafts.delete(this.#key(target));
      const saved = background
        ? this.#preservedDrafts.has(this.#key(target))
          ? cached
          : undefined
        : cached?.dirty
          ? cached
          : undefined;
      this.#update({
        phase: "ready",
        opening: false,
        view,
        content: saved ? saved.content : content,
        draft:
          saved?.draft ??
          content?.content ??
          (target.kind === "outline"
            ? emptyOutline(this.#details!.project.title)
            : emptyScript(target.title)),
        dirty: saved?.dirty ?? !content,
        sourceBriefRevision:
          saved?.sourceBriefRevision ??
          content?.brief.briefRevision ??
          this.#details!.brief.briefRevision,
        sourceOutline: saved
          ? saved.sourceOutline
          : content
            ? content.outline
            : this.#currentOutline(target, outline),
        outline,
        currentBriefRevision: this.#details!.brief.briefRevision,
        archived: this.#details!.project.state === "archived",
      });
      void this.loadArtifacts();
    } catch {
      if (read.current())
        this.#update({
          phase: background ? this.#snapshot.phase : "unavailable",
          opening: false,
          error: "大纲与剧本读取失败，请检查模块服务后重试。",
        });
    } finally {
      if (background) this.#backgroundReading = false;
      this.#drainInvalidation();
    }
  }
  async loadArtifacts(more = false) {
    if (!this.#canRead()) return;
    const afterArtifactId = more ? this.#snapshot.nextArtifactId : null;
    if (more && afterArtifactId === null) return;
    const read = this.#reading("artifacts");
    try {
      const page = await this.#client.listArtifacts(
        {
          projectId: this.#details!.project.projectId,
          afterArtifactId,
          limit: 16,
        },
        { signal: read.controller.signal },
      );
      if (!read.current()) return;
      const map = new Map(
        (more ? this.#snapshot.artifacts : []).map((item) => [
          item.artifactId,
          item,
        ]),
      );
      for (const artifact of page.artifacts)
        map.set(artifact.artifactId, artifact);
      this.#update({
        artifacts: [...map.values()],
        nextArtifactId: page.nextArtifactId,
      });
    } catch {
      if (read.current())
        this.#update({ error: "分集列表读取失败，请刷新内容。" });
    }
  }
  setDraft(draft: TextDraft) {
    if (!this.#available() || this.locked || this.#snapshot.opening) return;
    this.#preservedDrafts.add(this.#key());
    this.#update({ draft, dirty: true, notice: null });
    this.#remember();
  }
  async loadHistory(more = false) {
    const artifact = this.#snapshot.view?.artifact;
    if (!artifact || !this.#canRead() || this.#snapshot.saving) return;
    const afterContentRevision = more ? this.#snapshot.nextContentRevision : 0;
    if (afterContentRevision === null) return;
    const read = this.#reading("history");
    this.#update({ loadingHistory: true });
    try {
      const result = await this.#client.listRevisions(
        {
          projectId: artifact.projectId,
          artifactId: artifact.artifactId,
          afterContentRevision,
          limit: 4,
        },
        { signal: read.controller.signal },
      );
      if (!read.current()) return;
      const map = new Map(
        (more ? this.#snapshot.history : []).map((item) => [
          item.contentRevision,
          item,
        ]),
      );
      for (const revision of result.revisions)
        map.set(revision.contentRevision, revision);
      this.#update({
        history: [...map.values()],
        nextContentRevision: result.nextContentRevision,
        loadingHistory: false,
      });
    } catch {
      if (read.current())
        this.#update({
          loadingHistory: false,
          error: "版本历史读取失败，请重试。",
        });
    }
  }
  editRevision(content: PublicProjectTextRevision) {
    const view = this.#snapshot.view;
    if (
      !this.#canRead() ||
      this.locked ||
      this.#snapshot.opening ||
      this.#snapshot.dirty ||
      !view ||
      content.artifactId !== view.artifact.artifactId
    )
      return;
    this.#preservedDrafts.add(this.#key());
    this.#update({
      content,
      draft: content.content,
      dirty: false,
      sourceBriefRevision: content.brief.briefRevision,
      sourceOutline: content.outline,
      notice: `已打开内容 v${content.contentRevision}`,
    });
    this.#remember();
  }
  async save() {
    if (!this.canSave) return;
    const { target, view, draft } = this.#snapshot;
    const details = this.#details!;
    const base = {
      projectId: details.project.projectId,
      idempotencyKey: crypto.randomUUID(),
    };
    const request = {
      expectedArtifactRevision: view?.artifact.revision ?? 0,
      briefRevision:
        this.#snapshot.sourceBriefRevision ?? details.brief.briefRevision,
    };
    const intent: Intent =
      target.kind === "outline"
        ? {
            kind: "save-outline",
            input: {
              ...base,
              request: {
                ...request,
                content: draft as Parameters<typeof outlineValid>[0],
              },
            },
          }
        : {
            kind: "save-script",
            input: {
              ...base,
              episodeId: target.episodeId,
              request: {
                ...request,
                outline: this.#snapshot.sourceOutline,
                content: draft as Parameters<typeof scriptValid>[0],
              },
            },
          };
    await this.#execute(intent);
  }
  async select(contentRevision = this.#snapshot.content?.contentRevision) {
    const artifact = this.#snapshot.view?.artifact;
    if (
      !this.#available() ||
      this.recovery.blocksWrites ||
      this.locked ||
      !artifact ||
      artifact.locked ||
      !contentRevision
    )
      return;
    await this.#execute({
      kind: "select-revision",
      input: {
        projectId: artifact.projectId,
        artifactId: artifact.artifactId,
        idempotencyKey: crypto.randomUUID(),
        request: {
          expectedArtifactRevision: artifact.revision,
          contentRevision,
        },
      },
    });
  }
  async setLocked() {
    const artifact = this.#snapshot.view?.artifact;
    if (
      !this.#available() ||
      this.recovery.blocksWrites ||
      this.locked ||
      !artifact ||
      artifact.selectedContentRevision === null
    )
      return;
    await this.#execute({
      kind: "set-lock",
      input: {
        projectId: artifact.projectId,
        artifactId: artifact.artifactId,
        idempotencyKey: crypto.randomUUID(),
        request: {
          expectedArtifactRevision: artifact.revision,
          locked: !artifact.locked,
        },
      },
    });
  }
  useCurrentSource() {
    if (!this.#available() || this.locked || this.#snapshot.opening) return;
    this.#preservedDrafts.add(this.#key());
    this.#update({
      sourceBriefRevision: this.#details!.brief.briefRevision,
      sourceOutline: this.#currentOutline(),
      dirty: true,
      notice:
        "新候选将使用当前已保存的需求与已采用大纲；内容已保留，请检查后保存。",
    });
    this.#remember();
  }
  async retry() {
    if (
      !this.#ready ||
      this.#disposed ||
      !this.#intent ||
      this.#snapshot.saving ||
      this.#snapshot.failure !== "uncertain" ||
      this.#physicalWritesPending()
    )
      return;
    if (this.recovery.getSnapshot().intent?.phase === "refused") return;
    if (this.recovery.getSnapshot().intent?.phase === "accepted") {
      await this.refreshRecovery();
      return;
    }
    await this.#execute(this.#intent);
  }
  async refreshConflict() {
    if (
      !this.#canRead() ||
      this.#snapshot.failure !== "conflict" ||
      this.#snapshot.saving
    )
      return;
    const read = this.#reading("conflict");
    const { target } = this.#snapshot;
    try {
      const result =
        target.kind === "outline"
          ? await this.#client.getOutline(
              { projectId: this.#details!.project.projectId },
              { signal: read.controller.signal },
            )
          : await this.#client.getScript(
              {
                projectId: this.#details!.project.projectId,
                episodeId: target.episodeId,
              },
              { signal: read.controller.signal },
            );
      if (!read.current()) return;
      const current = this.#snapshot.view?.artifact;
      if (
        current &&
        (!result.view ||
          result.view.artifact.artifactId !== current.artifactId ||
          result.view.artifact.revision < current.revision)
      )
        return;
      this.#update({
        view: result.view,
        conflictRefreshed: true,
        ...(target.kind === "outline" ? { outline: result.view } : {}),
      });
    } catch {
      if (read.current())
        this.#update({ error: "当前版本读取失败，草稿已保留。" });
    }
  }
  async continueDraft() {
    if (
      !this.#snapshot.conflictRefreshed ||
      this.#snapshot.saving ||
      this.#physicalWritesPending()
    )
      return;
    if (this.recovery.getSnapshot().phase !== "disabled") {
      await this.recovery.check();
      const record = this.recovery.getSnapshot().intent;
      if (
        record &&
        (record.phase !== "refused" || !(await this.recovery.acknowledge()))
      )
        return;
      if (this.recovery.blocksWrites) return;
    }
    this.#intent = null;
    this.#update({
      failure: null,
      pendingKind: null,
      conflictRefreshed: false,
      error: null,
      notice: "已读取当前版本，草稿保留；下一次保存会创建新的候选。",
    });
  }
  async #execute(intent: Intent) {
    const epoch = this.#epoch;
    const controller = new AbortController();
    this.#write = controller;
    this.#intent = intent;
    this.recovery.beforeWrite();
    this.#update({
      saving: true,
      pendingKind: intent.kind,
      failure: null,
      conflictRefreshed: false,
      error: null,
      notice: null,
    });
    const current = () =>
      !this.#disposed && epoch === this.#epoch && this.#write === controller;
    try {
      const result = await invokeTextIntent(
        this.#client,
        intent,
        controller.signal,
      );
      if (!current()) return;
      this.#intent = null;
      this.#write = null;
      if (intent.kind === "save-outline" || intent.kind === "save-script")
        this.#preservedDrafts.add(this.#key());
      else this.#preservedDrafts.delete(this.#key());
      this.#update(
        projectTextMutationProjection(intent, result, this.#snapshot),
      );
      this.#remember();
      await this.#refreshCommittedView(result);
      await this.recovery.afterConfirmed(intent);
      const record = this.recovery.getSnapshot().intent;
      if (this.recovery.matches(intent) && record?.phase === "accepted")
        this.#presentedRecovery = `${record.intentId}:${record.revision}`;
      void this.loadArtifacts();
    } catch (error) {
      if (!current()) return;
      this.#write = null;
      const knownConflict = projectTextConflict(error);
      this.#update({
        saving: false,
        failure: knownConflict ? "conflict" : "uncertain",
        error: knownConflict
          ? "版本已改变或采用版本已锁定，草稿保留。请先读取当前状态。"
          : "尚未确认这次操作的结果。请用原请求重试，避免重复保存。",
      });
      await this.recovery.check();
      if (this.recovery.getSnapshot().intent?.phase === "accepted")
        await this.refreshRecovery();
    }
  }
  async refreshRecovery() {
    if (
      !this.#canRead() ||
      this.#snapshot.saving ||
      this.#physicalWritesPending()
    )
      return false;
    const epoch = this.#epoch,
      projectId = this.#details!.project.projectId;
    const record = await this.recovery.check();
    if (
      !record ||
      this.recovery.getSnapshot().phase !== "blocked" ||
      !this.#canRead() ||
      epoch !== this.#epoch ||
      projectId !== this.#details?.project.projectId
    )
      return false;
    const read = this.#reading("recovery-view");
    for (const lane of ["open", "view", "history", "conflict"])
      this.#reads.get(lane)?.abort();
    this.#update({ opening: true });
    try {
      const restored = await loadProjectTextRecoveryView({
        client: this.#client,
        projects: this.#projects,
        record,
        signal: read.controller.signal,
      });
      if (
        !read.current() ||
        this.recovery.getSnapshot().intent?.intentId !== record.intentId ||
        this.recovery.getSnapshot().intent?.revision !== record.revision
      )
        return false;
      if (restored.details.project.revision >= this.#details!.project.revision)
        this.#details = restored.details;
      this.#intent = record.phase === "accepted" ? null : restored.intent;
      this.#presentedRecovery = `${record.intentId}:${record.revision}`;
      this.#update({
        ...restored.update,
        currentBriefRevision: this.#details!.brief.briefRevision,
        archived: this.#details!.project.state === "archived",
      });
      this.#remember();
      void this.loadArtifacts();
      return true;
    } catch {
      if (read.current())
        this.#update({
          opening: false,
          error: "原请求保留，相关版本读取失败。请重新读取恢复记录。",
        });
      return false;
    } finally {
      if (read.current()) this.#update({ opening: false });
    }
  }
  async acknowledgeRecovery() {
    if (!this.canAcknowledgeRecovery) return;
    const record = this.recovery.getSnapshot().intent;
    if (!record || record.phase === "pending") return;
    if (!(await this.recovery.acknowledge())) return;
    this.#intent = null;
    this.#update({
      failure: null,
      pendingKind: null,
      error: null,
      notice:
        record.phase === "accepted"
          ? "已确认上次保存结果，可以继续创作。"
          : "原请求已关闭，草稿保留；可按当前版本保存新候选。",
    });
  }
  async #refreshCommittedView(result: ProjectTextMutationResponse) {
    // Read publication has its own fence: a confirmed mutation cannot become unknown.
    const read = this.#reading("view");
    try {
      const projected = await this.#client.getArtifact(
        {
          projectId: result.artifact.projectId,
          artifactId: result.artifact.artifactId,
        },
        { signal: read.controller.signal },
      );
      const current = this.#snapshot.view?.artifact;
      if (
        read.current() &&
        current?.artifactId === result.artifact.artifactId &&
        projected.view &&
        projected.view.artifact.revision >= current.revision
      )
        this.#update({
          view: projected.view,
          ...(result.artifact.kind === "outline"
            ? { outline: projected.view }
            : {}),
        });
    } catch {
      if (read.current())
        this.#update({ error: "保存已确认；依赖状态读取失败，请刷新内容。" });
    }
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    ++this.#epoch;
    this.#abortReads();
    this.#write?.abort();
    this.recovery.dispose();
    this.#listeners.clear();
  }
}
