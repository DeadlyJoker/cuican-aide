import {
  PROJECT_OUTLINE_EDIT_ACTIONS,
  parseProjectOutlineEditRequest,
  parseProjectOutlineEditResult,
  type ProjectOutlineEditRequest,
  type ProjectOutlineJson,
  type PluginProjectOutlineEditsService,
} from "../project-outline-edits-service.ts";
import type { ProjectOutlineController } from "./ProjectOutlineController";

export type OutlineEditSnapshot = Readonly<{
  saving: boolean;
  pending: boolean;
  error: string | null;
  notice: string | null;
}>;
/** Exact request retries preserve the original base and idempotency key. A failed read never clears a pending write. */
export class ProjectOutlineEditController {
  readonly #service: PluginProjectOutlineEditsService;
  readonly #reader: ProjectOutlineController;
  readonly #physicalPending: () => boolean;
  #snapshot: OutlineEditSnapshot = Object.freeze({
    saving: false,
    pending: false,
    error: null,
    notice: null,
  });
  #request: ProjectOutlineEditRequest | null = null;
  #listeners = new Set<() => void>();
  #ready = false;
  #disposed = false;
  constructor(
    input: Readonly<{
      service: PluginProjectOutlineEditsService;
      reader: ProjectOutlineController;
      physicalWritesPending(): boolean;
    }>,
  ) {
    this.#service = input.service;
    this.#reader = input.reader;
    this.#physicalPending = input.physicalWritesPending;
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  get locked() {
    return this.#snapshot.pending || this.#physicalPending();
  }
  setReady(ready: boolean) {
    this.#ready = ready;
  }
  async save(
    input: Readonly<{
      projectId: string;
      briefRevision: number;
      change: Readonly<Record<string, ProjectOutlineJson>>;
    }>,
  ) {
    if (!this.#ready || this.#disposed || this.locked) return false;
    const snapshot = this.#reader.getSnapshot();
    if (snapshot.state !== "ready" && snapshot.state !== "unsupported")
      return false;
    const base =
      snapshot.revision?.format === "structured-v2"
        ? {
            contentRevision: snapshot.revision.contentRevision,
            contentDigest: snapshot.revision.contentDigest,
          }
        : null;
    this.#request = parseProjectOutlineEditRequest({
      action: PROJECT_OUTLINE_EDIT_ACTIONS.saveCandidate,
      input: {
        ...input,
        expectedArtifactRevision: snapshot.view?.artifact.revision ?? 0,
        base,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    return this.retry();
  }
  async adopt() {
    if (!this.#ready || this.#disposed || this.locked) return false;
    const { view, revision } = this.#reader.getSnapshot();
    if (!view || !revision || revision.format !== "structured-v2") return false;
    this.#request = parseProjectOutlineEditRequest({
      action: PROJECT_OUTLINE_EDIT_ACTIONS.selectRevision,
      input: {
        projectId: revision.projectId,
        artifactId: revision.artifactId,
        contentRevision: revision.contentRevision,
        expectedArtifactRevision: view.artifact.revision,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    return this.retry();
  }
  async retry() {
    const request = this.#request;
    if (
      !request ||
      !this.#ready ||
      this.#disposed ||
      this.#snapshot.saving ||
      this.#physicalPending()
    )
      return false;
    this.#update({ saving: true, pending: true, error: null, notice: null });
    try {
      const output = await this.#service.invoke(request.action, request.input);
      const result = parseProjectOutlineEditResult(request, output);
      if (this.#disposed) return false;
      this.#request = null;
      this.#update({
        saving: false,
        pending: false,
        notice:
          request.action === PROJECT_OUTLINE_EDIT_ACTIONS.saveCandidate
            ? "大纲已保存"
            : "已采用此版本",
      });
      await this.#reader.refresh();
      const latest = this.#reader.getSnapshot().view?.latestRevision;
      if (
        request.action === PROJECT_OUTLINE_EDIT_ACTIONS.saveCandidate &&
        latest?.contentDigest === result.contentDigest
      )
        await this.#reader.openRevision(latest);
      return true;
    } catch (cause) {
      if (this.#disposed) return false;
      const code =
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : cause instanceof Error
            ? cause.message
            : "";
      const definite =
        /revision_conflict|idempotency_conflict|access_denied|locked|quality|params_mismatch|source_evidence|validation|change_invalid|actions_unavailable/u.test(
          code,
        );
      if (definite) this.#request = null;
      this.#update({
        saving: false,
        pending: !definite,
        error: definite
          ? "无法保存，请检查内容或刷新后再试。你的编辑仍保留。"
          : "保存结果尚未确认，请重试原请求。",
      });
      return false;
    }
  }
  dispose() {
    this.#disposed = true;
    this.#ready = false;
    this.#listeners.clear();
  }
  #update(value: Partial<OutlineEditSnapshot>) {
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...value });
    for (const listener of this.#listeners) listener();
  }
}
