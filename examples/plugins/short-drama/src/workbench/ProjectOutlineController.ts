import type {
  PluginProjectOutlineUiClient,
  ProjectOutlineItem,
  ProjectOutlineRevisionSummary,
  ProjectOutlineSection,
  ProjectOutlineView,
} from "../project-outlines-service";

export type ProjectOutlineSnapshot = Readonly<{
  state: "idle" | "loading" | "ready" | "unsupported" | "error";
  view: ProjectOutlineView | null;
  revision: ProjectOutlineRevisionSummary | null;
  sections: ReadonlyMap<ProjectOutlineSection, readonly ProjectOutlineItem[]>;
  next: ReadonlyMap<ProjectOutlineSection, number | null>;
  pending: ReadonlySet<ProjectOutlineSection>;
  history: readonly ProjectOutlineRevisionSummary[];
  historyNext: number | null;
  historyLoading: boolean;
  error: string | null;
}>;
const initial = (): ProjectOutlineSnapshot =>
  Object.freeze<ProjectOutlineSnapshot>({
    state: "idle",
    view: null,
    revision: null,
    sections: new Map(),
    next: new Map(),
    pending: new Set(),
    history: [],
    historyNext: null,
    historyLoading: false,
    error: null,
  });

/** Read only actual immutable pages. It cannot adopt, invent assets, launch a task or replace the homepage conversation. */
export class ProjectOutlineController {
  readonly #client: PluginProjectOutlineUiClient;
  #projectId: string | null = null;
  #ready = false;
  #disposed = false;
  #epoch = 0;
  #snapshot = initial();
  #reads = new Map<string, AbortController>();
  #listeners = new Set<() => void>();
  constructor(client: PluginProjectOutlineUiClient) {
    this.#client = client;
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  setReady(ready: boolean) {
    if (this.#disposed || ready === this.#ready) return;
    this.#ready = ready;
    if (!ready) {
      this.#epoch++;
      this.#abort();
      this.#update({
        pending: new Set(),
        historyLoading: false,
        state: this.#snapshot.revision ? "ready" : "idle",
      });
    } else if (this.#projectId) {
      void this.refresh();
    }
  }
  setProject(projectId: string | null) {
    if (this.#disposed || projectId === this.#projectId) return;
    this.#epoch++;
    this.#abort();
    this.#projectId = projectId;
    this.#snapshot = initial();
    this.#emit();
  }
  async refresh() {
    const projectId = this.#projectId;
    if (!this.#ready || this.#disposed || !projectId) return;
    const epoch = ++this.#epoch;
    this.#abort();
    this.#update({
      state: "loading",
      pending: new Set(),
      historyLoading: false,
      error: null,
    });
    const read = this.#begin("head");
    try {
      const { view } = await this.#client.getOutline(
        { projectId },
        { signal: read.signal },
      );
      if (!this.#current(epoch, read)) return;
      if (!view || view.latestRevision.format !== "structured-v2") {
        this.#snapshot = initial();
        this.#update({
          state: "unsupported",
          view,
          revision: view?.latestRevision ?? null,
        });
        return;
      }
      const revision =
        view.selectedRevision?.format === "structured-v2"
          ? view.selectedRevision
          : view.latestRevision;
      const same =
        this.#snapshot.revision?.contentDigest === revision.contentDigest;
      this.#update({
        state: "ready",
        view,
        revision,
        sections: same ? this.#snapshot.sections : new Map(),
        next: same ? this.#snapshot.next : new Map(),
        history: same ? this.#snapshot.history : [],
        historyNext: same ? this.#snapshot.historyNext : null,
      });
      await Promise.allSettled([
        this.loadSection("overview"),
        this.loadSection("episodes"),
      ]);
    } catch (cause) {
      if (!this.#current(epoch, read)) return;
      const text = cause instanceof Error ? cause.message : "";
      const unsupported =
        /plugin_ui_actions_unavailable|plugin_project_outline_actions_unavailable|project_outline_service_unavailable|unsupported|unknown_action|unimplemented/u.test(
          text,
        );
      this.#update({
        state:
          unsupported && !this.#snapshot.revision ? "unsupported" : "error",
        error: unsupported ? null : "大纲暂时无法读取，已有产物保留。",
      });
    } finally {
      this.#finish("head", read);
    }
  }
  async openRevision(revision: ProjectOutlineRevisionSummary) {
    const view = this.#snapshot.view;
    if (
      !this.#ready ||
      this.#disposed ||
      !view ||
      revision.projectId !== this.#projectId ||
      revision.artifactId !== view.artifact.artifactId ||
      revision.format !== "structured-v2"
    )
      return;
    this.#epoch++;
    this.#abort();
    this.#update({
      revision,
      state: "ready",
      sections: new Map(),
      next: new Map(),
      pending: new Set(),
      error: null,
      historyLoading: false,
    });
    await Promise.allSettled([
      this.loadSection("overview"),
      this.loadSection("episodes"),
    ]);
  }
  async loadSection(section: ProjectOutlineSection, more = false) {
    const revision = this.#snapshot.revision;
    if (
      !this.#ready ||
      this.#disposed ||
      !revision ||
      this.#snapshot.pending.has(section)
    )
      return;
    const afterIndex = more ? this.#snapshot.next.get(section) : 0;
    if (afterIndex === null || afterIndex === undefined) return;
    if (!more && this.#snapshot.sections.has(section)) return;
    const epoch = this.#epoch,
      key = `section:${section}`,
      read = this.#begin(key);
    this.#update({
      pending: new Set([...this.#snapshot.pending, section]),
      error: null,
    });
    try {
      const page = await this.#client.getSection(
        {
          projectId: revision.projectId,
          artifactId: revision.artifactId,
          contentRevision: revision.contentRevision,
          contentDigest: revision.contentDigest,
          section,
          afterIndex,
          limit: 10,
        },
        { signal: read.signal },
      );
      if (
        !this.#current(epoch, read) ||
        this.#snapshot.revision?.contentDigest !== revision.contentDigest
      )
        return;
      const sections = new Map(this.#snapshot.sections),
        next = new Map(this.#snapshot.next);
      sections.set(
        section,
        Object.freeze([
          ...(more ? (sections.get(section) ?? []) : []),
          ...page.items,
        ]),
      );
      next.set(section, page.nextIndex);
      this.#update({ sections, next });
    } catch {
      if (this.#current(epoch, read))
        this.#update({ error: "这一部分暂时无法读取，请重试。" });
    } finally {
      this.#finish(key, read);
      if (this.#current(epoch, read)) {
        const pending = new Set(this.#snapshot.pending);
        pending.delete(section);
        this.#update({ pending });
      }
    }
  }
  async loadHistory(more = false) {
    const view = this.#snapshot.view;
    if (
      !this.#ready ||
      this.#disposed ||
      !view ||
      this.#snapshot.historyLoading
    )
      return;
    const afterContentRevision = more ? this.#snapshot.historyNext : 0;
    if (afterContentRevision === null) return;
    const epoch = this.#epoch,
      read = this.#begin("history");
    this.#update({ historyLoading: true, error: null });
    try {
      const page = await this.#client.listRevisions(
        {
          projectId: view.artifact.projectId,
          artifactId: view.artifact.artifactId,
          afterContentRevision,
          limit: 10,
        },
        { signal: read.signal },
      );
      if (!this.#current(epoch, read)) return;
      this.#update({
        history: Object.freeze([
          ...(more ? this.#snapshot.history : []),
          ...page.revisions,
        ]),
        historyNext: page.nextContentRevision,
      });
    } catch {
      if (this.#current(epoch, read))
        this.#update({ error: "历史暂时无法读取，请重试。" });
    } finally {
      this.#finish("history", read);
      if (this.#current(epoch, read)) this.#update({ historyLoading: false });
    }
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    this.#epoch++;
    this.#abort();
    this.#listeners.clear();
  }
  #begin(key: string) {
    this.#reads.get(key)?.abort();
    const read = new AbortController();
    this.#reads.set(key, read);
    return read;
  }
  #finish(key: string, read: AbortController) {
    if (this.#reads.get(key) === read) this.#reads.delete(key);
  }
  #current(epoch: number, read: AbortController) {
    return (
      !this.#disposed &&
      this.#ready &&
      epoch === this.#epoch &&
      !read.signal.aborted
    );
  }
  #abort() {
    for (const read of this.#reads.values()) read.abort();
    this.#reads.clear();
  }
  #update(change: Partial<ProjectOutlineSnapshot>) {
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...change });
    this.#emit();
  }
  #emit() {
    for (const listener of this.#listeners) listener();
  }
}
