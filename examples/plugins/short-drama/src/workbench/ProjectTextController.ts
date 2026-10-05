import type {
  PluginProjectTextUiClient,
  PublicProjectTextArtifact,
  PublicProjectTextArtifactView,
  PublicProjectTextRevision,
  ProjectTextMutationResponse,
} from "../project-texts-ui-service";
import type { ProjectDetails } from "./creative-project-controller";
import type { PluginCreativeProjectClient } from "@crewon/plugin-sdk/ui";
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

function conflict(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : error instanceof Error
        ? error.message
        : "";
  return (
    typeof code === "string" &&
    /(?:revision_conflict|project_text_locked|project_text_dependencies_stale|project_text_(?:outline|brief)_reference_invalid|project_text_selection_required|idempotency_conflict|artifact_locked|project_archived)/u.test(
      code,
    )
  );
}

/** Manual edits use the same immutable text records as Agent tools, through real mount invokes. */
export class ProjectTextController {
  #client: PluginProjectTextUiClient;
  #projects: Pick<PluginCreativeProjectClient, "getProject" | "getBrief">;
  #details: ProjectDetails | null = null;
  #ready = false;
  #disposed = false;
  #epoch = 0;
  #snapshot = initial();
  #listeners = new Set<() => void>();
  #reads = new Map<string, AbortController>();
  #write: AbortController | null = null;
  #intent: Intent | null = null;
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
  }) {
    this.#client = ports.client;
    this.#projects = ports.projects;
    this.#physicalWritesPending = ports.physicalWritesPending ?? (() => false);
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
      this.#physicalWritesPending()
    );
  }
  get canSave(): boolean {
    const { draft, target, dirty, opening } = this.#snapshot;
    return (
      this.#available() &&
      !this.locked &&
      !opening &&
      dirty &&
      Boolean(draft) &&
      (target.kind === "outline"
        ? outlineValid(draft as Parameters<typeof outlineValid>[0])
        : scriptValid(draft as Parameters<typeof scriptValid>[0]))
    );
  }
  setReady(ready: boolean) {
    if (this.#disposed || ready === this.#ready) return;
    this.#ready = ready;
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
    this.#intent = null;
    this.#snapshot = initial();
    this.#snapshot = {
      ...this.#snapshot,
      currentBriefRevision: details?.brief.briefRevision ?? null,
      archived: details?.project.state === "archived",
    };
    this.#emit();
  }
  refreshWriteActivity() {
    this.#emit();
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
  async open(target: TextTarget = this.#snapshot.target) {
    if (!this.#canRead() || this.locked) return;
    this.#remember();
    this.#reads.get("view")?.abort();
    const read = this.#reading("open");
    this.#reads.get("history")?.abort();
    const projectId = this.#details!.project.projectId;
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
      const project = (
        await this.#projects.getProject(
          { projectId },
          { signal: read.controller.signal },
        )
      ).project;
      if (!read.current()) return;
      const brief = (
        await this.#projects.getBrief(
          { projectId, briefRevision: project.latestBriefRevision },
          { signal: read.controller.signal },
        )
      ).brief;
      if (!read.current()) return;
      if (project.revision >= this.#details!.project.revision)
        this.#details = { project, brief };
      const result =
        target.kind === "outline"
          ? await this.#client.getOutline(
              { projectId },
              { signal: read.controller.signal },
            )
          : await this.#client.getScript(
              { projectId, episodeId: target.episodeId },
              { signal: read.controller.signal },
            );
      if (!read.current()) return;
      const view = result.view;
      const outline =
        target.kind === "outline"
          ? view
          : (
              await this.#client.getOutline(
                { projectId },
                { signal: read.controller.signal },
              )
            ).view;
      if (!read.current()) return;
      let content = view?.selectedRevision ?? null;
      if (!content && view) {
        const latest = await this.#client.getRevision(
          {
            projectId,
            artifactId: view.artifact.artifactId,
            contentRevision: view.artifact.latestContentRevision,
          },
          { signal: read.controller.signal },
        );
        if (!read.current()) return;
        content = latest.contentRevision;
      }
      const cached = this.#drafts.get(this.#key(target));
      const saved = cached?.dirty ? cached : undefined;
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
          phase: "unavailable",
          opening: false,
          error: "大纲与剧本读取失败，请检查模块服务后重试。",
        });
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
  continueDraft() {
    if (
      !this.#snapshot.conflictRefreshed ||
      this.#snapshot.saving ||
      this.#physicalWritesPending()
    )
      return;
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
      const options = { signal: controller.signal };
      const result: ProjectTextMutationResponse =
        intent.kind === "save-outline"
          ? await this.#client.saveOutlineCandidate(intent.input, options)
          : intent.kind === "save-script"
            ? await this.#client.saveScriptCandidate(intent.input, options)
            : intent.kind === "select-revision"
              ? await this.#client.selectRevision(intent.input, options)
              : await this.#client.setLocked(intent.input, options);
      if (!current()) return;
      this.#intent = null;
      this.#write = null;
      const saved =
        intent.kind === "save-outline" || intent.kind === "save-script";
      const view: PublicProjectTextArtifactView = {
        artifact: result.artifact,
        selectedRevision:
          intent.kind === "select-revision"
            ? result.contentRevision
            : (this.#snapshot.view?.selectedRevision ?? null),
        dependencyState: this.#snapshot.view?.dependencyState ?? "unselected",
        staleReasons: this.#snapshot.view?.staleReasons ?? [],
      };
      this.#update({
        saving: false,
        pendingKind: null,
        failure: null,
        view,
        ...(saved
          ? {
              content: result.contentRevision,
              draft: result.contentRevision?.content ?? this.#snapshot.draft,
              dirty: false,
            }
          : {}),
        notice: saved
          ? "候选已保存，采用后成为后续阶段的来源。"
          : intent.kind === "select-revision"
            ? "已采用所选内容版本。"
            : result.artifact.locked
              ? "当前采用版本已锁定，仍可保存新的候选。"
              : "已解锁，可以采用其他版本。",
      });
      this.#remember();
      await this.#refreshCommittedView(result);
      void this.loadArtifacts();
    } catch (error) {
      if (!current()) return;
      this.#write = null;
      const knownConflict = conflict(error);
      this.#update({
        saving: false,
        failure: knownConflict ? "conflict" : "uncertain",
        error: knownConflict
          ? "版本已改变或采用版本已锁定，草稿保留。请先读取当前状态。"
          : "尚未确认这次操作的结果。请用原请求重试，避免重复保存。",
      });
    }
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
    this.#listeners.clear();
  }
}
