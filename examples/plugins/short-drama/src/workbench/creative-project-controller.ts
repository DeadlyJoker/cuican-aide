import type { PluginCreativeProjectClient } from "@crewon/plugin-sdk/ui";
import { ConceptController } from "./ConceptController";
import type {
  CreativeProjectUiInputMap,
  PublicCreativeProject,
  PublicProjectBrief,
} from "@crewon/plugin-sdk/contracts";

type ProjectState = "active" | "archived";
export type ProjectDetails = Readonly<{
  project: PublicCreativeProject;
  brief: PublicProjectBrief;
}>;
type MutationIntent =
  | Readonly<{
      kind: "create";
      input: CreativeProjectUiInputMap["crewon.creative-projects.v1.createProject"];
    }>
  | Readonly<{
      kind: "brief";
      input: CreativeProjectUiInputMap["crewon.creative-projects.v1.appendBrief"];
    }>
  | Readonly<{
      kind: "state";
      input: CreativeProjectUiInputMap["crewon.creative-projects.v1.setProjectState"];
    }>;
export type ProjectSnapshot = Readonly<{
  phase: "waiting" | "loading" | "ready" | "unavailable";
  projects: readonly PublicCreativeProject[];
  state: ProjectState;
  nextCursor: string | null;
  details: ProjectDetails | null;
  opening: boolean;
  draft: string;
  saving: boolean;
  pendingKind: MutationIntent["kind"] | null;
  failure: "conflict" | "uncertain" | null;
  conflictRefreshed: boolean;
  error: string | null;
  notice: string | null;
  briefs: readonly PublicProjectBrief[];
  nextBriefRevision: number | null;
  loadingBriefs: boolean;
  conceptLocked: boolean;
}>;

export function briefBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
export function validBrief(text: string): boolean {
  return validText(text) && briefBytes(text) <= 8192;
}
export function validTitle(title: string): boolean {
  return validText(title) && [...title.trim()].length <= 160;
}
function validText(text: string): boolean {
  return (
    Boolean(text.trim()) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(text)
  );
}
function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return error instanceof Error ? error.message : "";
}
function mergeProjects(
  existing: readonly PublicCreativeProject[],
  incoming: readonly PublicCreativeProject[],
): readonly PublicCreativeProject[] {
  const merged = new Map(
    existing.map((project) => [project.projectId, project]),
  );
  for (const project of incoming) {
    const previous = merged.get(project.projectId);
    if (!previous || previous.revision <= project.revision)
      merged.set(project.projectId, project);
  }
  return [...merged.values()].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      (left.projectId === right.projectId
        ? 0
        : left.projectId < right.projectId
          ? 1
          : -1),
  );
}

/** Public metadata only. The dispatcher supplies identity and authorization; no local demo fallback. */
export class CreativeProjectController {
  readonly concepts: ConceptController;
  #client: PluginCreativeProjectClient;
  #listeners = new Set<() => void>();
  #ready = false;
  #disposed = false;
  #list: AbortController | null = null;
  #detail: AbortController | null = null;
  #history: AbortController | null = null;
  #write: AbortController | null = null;
  #intent: MutationIntent | null = null;
  #drafts = new Map<string, string>();
  #snapshot: ProjectSnapshot = {
    phase: "waiting",
    projects: [],
    state: "active",
    nextCursor: null,
    details: null,
    opening: false,
    draft: "",
    saving: false,
    pendingKind: null,
    failure: null,
    conflictRefreshed: false,
    error: null,
    notice: null,
    briefs: [],
    nextBriefRevision: null,
    loadingBriefs: false,
    conceptLocked: false,
  };

  constructor(client: PluginCreativeProjectClient) {
    this.#client = client;
    this.concepts = new ConceptController({
      client,
      projectBlocked: () =>
        Boolean(this.#write || this.#intent || !this.#ready),
      lockChanged: (conceptLocked) => this.#update({ conceptLocked }),
      projectCommitted: (project) => {
        const details = this.#snapshot.details;
        this.#update({
          projects: mergeProjects(this.#snapshot.projects, [project]),
          ...(details?.project.projectId === project.projectId &&
          details.project.revision <= project.revision
            ? { details: { ...details, project } }
            : {}),
        });
      },
      refreshProject: (projectId, signal) =>
        this.#refreshConceptProject(projectId, signal),
    });
  }
  getSnapshot = (): ProjectSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #update(change: Partial<ProjectSnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...change };
    this.concepts.bindProject(this.#snapshot.details, this.#ready);
    for (const listener of this.#listeners) listener();
  }
  #current(controller: AbortController): boolean {
    return !this.#disposed && this.#ready && !controller.signal.aborted;
  }
  setReady(ready: boolean) {
    if (this.#disposed || ready === this.#ready) return;
    this.#ready = ready;
    if (ready) void this.loadProjects(this.#snapshot.state);
    else {
      this.#abort();
      this.#update({
        phase: "waiting",
        saving: false,
        opening: false,
        loadingBriefs: false,
      });
    }
  }
  #abort() {
    for (const controller of [
      this.#list,
      this.#detail,
      this.#history,
      this.#write,
    ])
      controller?.abort();
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    this.#abort();
    this.concepts.dispose();
    this.#listeners.clear();
  }

  async loadProjects(state = this.#snapshot.state, more = false) {
    if (
      !this.#ready ||
      this.#disposed ||
      this.#write ||
      this.#intent ||
      this.concepts.locked
    )
      return;
    const cursor = more ? this.#snapshot.nextCursor : null;
    if (more && !cursor) return;
    this.#list?.abort();
    const controller = new AbortController();
    this.#list = controller;
    this.#update({
      phase: "loading",
      state,
      error: null,
      ...(more ? {} : { projects: [], nextCursor: null }),
    });
    try {
      const result = await this.#client.listProjects(
        { query: { state, cursor, limit: 20 } },
        { signal: controller.signal },
      );
      if (!this.#current(controller) || this.#list !== controller) return;
      this.#update({
        phase: "ready",
        projects: mergeProjects(
          more ? this.#snapshot.projects : [],
          result.projects,
        ),
        nextCursor: result.nextCursor,
      });
    } catch {
      if (this.#current(controller) && this.#list === controller)
        this.#update({
          phase: "unavailable",
          error: "项目服务暂不可用，请稍后重试。",
        });
    } finally {
      if (this.#list === controller) this.#list = null;
    }
  }
  closeProject() {
    if (this.#write || this.#intent || this.concepts.locked) return;
    this.#detail?.abort();
    this.#history?.abort();
    this.#update({ details: null, opening: false, error: null, notice: null });
  }
  async openProject(projectId: string, preserveDraft = false) {
    if (
      !this.#ready ||
      this.#disposed ||
      this.#write ||
      this.concepts.locked ||
      (this.#intent && !preserveDraft)
    )
      return;
    this.#detail?.abort();
    this.#history?.abort();
    const controller = new AbortController();
    this.#detail = controller;
    this.#update({
      opening: true,
      error: null,
      ...(preserveDraft
        ? {}
        : { details: null, briefs: [], nextBriefRevision: null }),
    });
    try {
      const { project } = await this.#client.getProject(
        { projectId },
        { signal: controller.signal },
      );
      if (!this.#current(controller) || this.#detail !== controller) return;
      const { brief } = await this.#client.getBrief(
        { projectId, briefRevision: project.latestBriefRevision },
        { signal: controller.signal },
      );
      if (!this.#current(controller) || this.#detail !== controller) return;
      this.#update({
        opening: false,
        details: { project, brief },
        draft: preserveDraft
          ? this.#snapshot.draft
          : (this.#drafts.get(projectId) ?? brief.text),
        projects: mergeProjects(this.#snapshot.projects, [project]),
        ...(preserveDraft ? { conflictRefreshed: true } : {}),
      });
    } catch {
      if (this.#current(controller) && this.#detail === controller)
        this.#update({
          opening: false,
          error: "项目读取失败，原编辑内容已保留。",
        });
    } finally {
      if (this.#detail === controller) this.#detail = null;
    }
  }
  setDraft(draft: string) {
    const details = this.#snapshot.details;
    if (
      !details ||
      details.project.state === "archived" ||
      this.#write ||
      this.concepts.locked ||
      this.#intent
    )
      return;
    this.#drafts.set(details.project.projectId, draft);
    this.#update({ draft, notice: null });
  }
  async #refreshConceptProject(
    projectId: string,
    signal: AbortSignal,
  ): Promise<ProjectDetails | null> {
    const current = () =>
      this.#ready &&
      !this.#disposed &&
      !signal.aborted &&
      this.#snapshot.details?.project.projectId === projectId;
    const { project } = await this.#client.getProject(
      { projectId },
      { signal },
    );
    if (!current()) return null;
    const { brief } = await this.#client.getBrief(
      { projectId, briefRevision: project.latestBriefRevision },
      { signal },
    );
    if (!current()) return null;
    const previous = this.#snapshot.details!;
    if (previous.project.revision > project.revision) return previous;
    const details = { project, brief };
    // Refresh the confirmed source and CAS while preserving the independent requirement draft.
    this.#update({
      details,
      projects: mergeProjects(this.#snapshot.projects, [project]),
    });
    return details;
  }
  async loadBriefs(more = false) {
    const details = this.#snapshot.details;
    if (!this.#ready || !details || this.#disposed) return;
    const afterBriefRevision = more ? this.#snapshot.nextBriefRevision : 0;
    if (afterBriefRevision === null) return;
    this.#history?.abort();
    const controller = new AbortController();
    this.#history = controller;
    this.#update({ loadingBriefs: true, error: null });
    try {
      const result = await this.#client.listBriefs(
        {
          projectId: details.project.projectId,
          query: { afterBriefRevision, limit: 20 },
        },
        { signal: controller.signal },
      );
      if (
        !this.#current(controller) ||
        this.#history !== controller ||
        this.#snapshot.details?.project.projectId !== details.project.projectId
      )
        return;
      const records = new Map(
        (more ? this.#snapshot.briefs : []).map((brief) => [
          brief.briefRevision,
          brief,
        ]),
      );
      for (const brief of result.briefs)
        records.set(brief.briefRevision, brief);
      this.#update({
        loadingBriefs: false,
        briefs: [...records.values()].sort(
          (a, b) => b.briefRevision - a.briefRevision,
        ),
        nextBriefRevision: result.nextAfterBriefRevision,
      });
    } catch {
      if (this.#current(controller) && this.#history === controller)
        this.#update({
          loadingBriefs: false,
          error: "需求历史读取失败，请重试。",
        });
    } finally {
      if (this.#history === controller) this.#history = null;
    }
  }

  async createProject(title: string, briefText: string) {
    if (
      !validTitle(title) ||
      !validBrief(briefText) ||
      this.#intent ||
      this.concepts.locked ||
      this.#write ||
      this.concepts.locked
    )
      return;
    await this.#commit(
      Object.freeze({
        kind: "create",
        input: Object.freeze({
          request: Object.freeze({ title: title.trim(), briefText }),
          idempotencyKey: crypto.randomUUID(),
        }),
      }),
    );
  }
  async saveBrief() {
    const { details, draft, failure, conflictRefreshed } = this.#snapshot;
    if (
      !details ||
      details.project.state === "archived" ||
      !validBrief(draft) ||
      draft === details.brief.text ||
      this.#write
    )
      return;
    if (
      this.#intent &&
      (failure !== "conflict" ||
        !conflictRefreshed ||
        this.#intent.kind !== "brief")
    )
      return;
    await this.#commit(
      Object.freeze({
        kind: "brief",
        input: Object.freeze({
          projectId: details.project.projectId,
          request: Object.freeze({
            text: draft,
            expectedProjectRevision: details.project.revision,
          }),
          idempotencyKey: crypto.randomUUID(),
        }),
      }),
    );
  }
  async setProjectState() {
    const { details, failure, conflictRefreshed } = this.#snapshot;
    if (!details || this.#write || this.concepts.locked) return;
    if (
      this.#intent &&
      (failure !== "conflict" ||
        !conflictRefreshed ||
        this.#intent.kind !== "state")
    )
      return;
    const state =
      this.#intent?.kind === "state"
        ? this.#intent.input.request.state
        : details.project.state === "active"
          ? "archived"
          : "active";
    await this.#commit(
      Object.freeze({
        kind: "state",
        input: Object.freeze({
          projectId: details.project.projectId,
          request: Object.freeze({
            state,
            expectedProjectRevision: details.project.revision,
          }),
          idempotencyKey: crypto.randomUUID(),
        }),
      }),
    );
  }
  async retry() {
    if (this.#intent && !this.#write) await this.#commit(this.#intent);
  }
  async refreshConflict() {
    if (
      this.#intent?.kind !== "create" &&
      this.#snapshot.failure === "conflict" &&
      this.#snapshot.details
    )
      await this.openProject(this.#snapshot.details.project.projectId, true);
    const intent = this.#intent;
    const details = this.#snapshot.details;
    if (
      this.#snapshot.conflictRefreshed &&
      details &&
      intent &&
      ((intent.kind === "brief" &&
        details.brief.text === intent.input.request.text) ||
        (intent.kind === "state" &&
          details.project.state === intent.input.request.state))
    ) {
      this.#intent = null;
      this.#update({
        pendingKind: null,
        failure: null,
        conflictRefreshed: false,
        notice: "当前版本已包含本次修改",
        error: null,
      });
    }
  }
  async #commit(intent: MutationIntent) {
    if (!this.#ready || this.#disposed || this.#write || this.concepts.locked)
      return;
    this.#intent = intent;
    this.#list?.abort();
    this.#detail?.abort();
    this.#history?.abort();
    const controller = new AbortController();
    this.#write = controller;
    this.#update({
      saving: true,
      pendingKind: intent.kind,
      opening: false,
      loadingBriefs: false,
      failure: null,
      conflictRefreshed: false,
      error: null,
      notice: null,
    });
    try {
      const options = { signal: controller.signal };
      let project: PublicCreativeProject;
      let brief: PublicProjectBrief | null = null;
      if (intent.kind === "create") {
        const result = await this.#client.createProject(intent.input, options);
        project = result.project;
        brief = result.brief;
      } else if (intent.kind === "brief") {
        const result = await this.#client.appendBrief(intent.input, options);
        project = result.project;
        brief = result.brief;
      } else {
        const result = await this.#client.setProjectState(
          intent.input,
          options,
        );
        project = result.project;
      }
      if (!this.#current(controller) || this.#write !== controller) return;
      this.#intent = null;
      const details = brief
        ? { project, brief }
        : this.#snapshot.details &&
            this.#snapshot.details.project.projectId === project.projectId
          ? { ...this.#snapshot.details, project }
          : null;
      if (brief) this.#drafts.delete(project.projectId);
      this.#update({
        projects: mergeProjects(this.#snapshot.projects, [project]),
        details,
        ...(brief ? { draft: brief.text } : {}),
        saving: false,
        pendingKind: null,
        briefs: [],
        nextBriefRevision: null,
        loadingBriefs: false,
        notice:
          intent.kind === "create"
            ? "项目已保存"
            : intent.kind === "brief"
              ? "已保存新的需求版本"
              : project.state === "active"
                ? "项目已恢复"
                : "项目已归档，需求版本继续保留",
      });
    } catch (error) {
      if (!this.#current(controller) || this.#write !== controller) return;
      const conflict =
        errorCode(error) === "creative_project_revision_conflict";
      this.#update({
        saving: false,
        failure: conflict ? "conflict" : "uncertain",
        error: conflict
          ? "项目已有新版本。请重新读取，确认后再保存；编辑内容已保留。"
          : "保存结果尚未确认，请重试原请求。",
      });
    } finally {
      if (this.#write === controller) {
        this.#write = null;
        // A newly created project can read its inputs after the project write settles.
        this.concepts.bindProject(this.#snapshot.details, this.#ready);
      }
    }
  }
}
