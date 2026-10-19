import {
  projectFoundationUiCodec,
  type PluginProjectFoundationClient,
  type ProjectFoundationUiRequest,
  type ProjectFoundationMutationResponse,
  type ProjectFoundationCreationParameters,
  type ProjectFoundationSourceUpload,
  type PublicProjectFoundation,
  type PublicProjectProposal,
  type PublicProjectSource,
  type PublicProjectSourceChapter,
  type PublicProjectSourcePage,
} from "@crewon/plugin-sdk/project-foundation-ui";
import type { ProjectDetails } from "./creative-project-controller";
type Pending = Extract<
  ProjectFoundationUiRequest,
  { input: { idempotencyKey: string } }
>;
export type FoundationSnapshot = Readonly<{
  origins: ReadonlyMap<string, "creative" | "novel" | null>;
  available: boolean;
  projectId: string | null;
  loading: boolean;
  saving: boolean;
  foundation: PublicProjectFoundation | null;
  proposal: PublicProjectProposal | null;
  proposalDraft: string;
  proposals: readonly PublicProjectProposal[];
  latestProposalKnown: boolean;
  nextProposalRevision: number | null;
  source: PublicProjectSource | null;
  chapters: readonly PublicProjectSourceChapter[];
  nextChapterOffset: number | null;
  sourcePage: PublicProjectSourcePage | null;
  readingSource: boolean;
  error: string | null;
  notice: string | null;
  pending: boolean;
  conflict: boolean;
}>;
const initial = (): FoundationSnapshot => ({
  origins: new Map(),
  available: false,
  projectId: null,
  loading: false,
  saving: false,
  foundation: null,
  proposal: null,
  proposalDraft: "",
  proposals: [],
  latestProposalKnown: false,
  nextProposalRevision: null,
  source: null,
  chapters: [],
  nextChapterOffset: null,
  sourcePage: null,
  readingSource: false,
  error: null,
  notice: null,
  pending: false,
  conflict: false,
});
function code(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return error instanceof Error ? error.message : "";
}
/** Host connection enables requests; actual service responses determine permission and saved facts. No second chat or model execution. */
export class ProjectFoundationController {
  readonly #client: PluginProjectFoundationClient;
  readonly #physicalPending: () => boolean;
  readonly #committed: (
    result: ProjectFoundationMutationResponse,
  ) => Promise<void>;
  readonly #listeners = new Set<() => void>();
  #snapshot = initial();
  #project: ProjectDetails | null = null;
  #disposed = false;
  #epoch = 0;
  #read: AbortController | null = null;
  #backgroundRead: AbortController | null = null;
  #sourceRead: AbortController | null = null;
  #chapterRead: AbortController | null = null;
  #latestProposalRevision = 0;
  #originReads = new Set<string>();
  #originRead: AbortController | null = null;
  #write: AbortController | null = null;
  #intent: Pending | null = null;
  #proposalDirty = false;
  #invalidatedProjectId: string | null = null;
  constructor(
    input: Readonly<{
      client: PluginProjectFoundationClient;
      physicalWritesPending(): boolean;
      committed(result: ProjectFoundationMutationResponse): Promise<void>;
    }>,
  ) {
    this.#client = input.client;
    this.#physicalPending = input.physicalWritesPending;
    this.#committed = input.committed;
  }
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly getSnapshot = () => this.#snapshot;
  get locked() {
    return this.#write !== null || this.#intent !== null;
  }
  refreshWriteActivity() {
    this.#publish({});
    this.#refreshInvalidated();
  }
  /** Coalesce host read hints without replacing an editor or interrupting a physical write. */
  invalidate(projectId: string) {
    if (this.#disposed || this.#snapshot.projectId !== projectId) return;
    this.#invalidatedProjectId = projectId;
    this.#refreshInvalidated();
  }
  #refreshInvalidated() {
    if (
      this.#invalidatedProjectId === null ||
      this.#invalidatedProjectId !== this.#snapshot.projectId ||
      !this.#snapshot.available ||
      this.#read !== null ||
      this.locked ||
      this.#physicalPending()
    )
      return;
    this.#invalidatedProjectId = null;
    void this.refresh("background");
  }
  setReady(available: boolean) {
    if (this.#disposed || this.#snapshot.available === available) return;
    ++this.#epoch;
    this.#read?.abort();
    this.#sourceRead?.abort();
    this.#chapterRead?.abort();
    this.#originRead?.abort();
    this.#publish({ available, loading: false, readingSource: false });
    if (available && this.#project) void this.refresh();
  }
  setProject(project: ProjectDetails | null) {
    if (this.#disposed) return;
    if (this.#project?.project.projectId === project?.project.projectId) {
      this.#project = project;
      return;
    }
    this.#project = project;
    this.#invalidatedProjectId = null;
    this.#proposalDirty = false;
    this.#latestProposalRevision = 0;
    ++this.#epoch;
    this.#read?.abort();
    this.#sourceRead?.abort();
    this.#chapterRead?.abort();
    this.#publish({
      ...initial(),
      origins: this.#snapshot.origins,
      available: this.#snapshot.available,
      projectId: project?.project.projectId ?? null,
      pending: this.#intent !== null,
      saving: this.#write !== null,
    });
    if (project && this.#snapshot.available) void this.refresh();
  }
  async readOrigins(projects: readonly { projectId: string }[]) {
    if (this.#disposed || !this.#snapshot.available) return;
    const ids = projects
      .map((project) => project.projectId)
      .filter(
        (id) => !this.#snapshot.origins.has(id) && !this.#originReads.has(id),
      )
      .slice(0, 50);
    if (!ids.length) return;
    this.#originRead?.abort();
    const request = new AbortController();
    this.#originRead = request;
    for (const id of ids) this.#originReads.add(id);
    try {
      for (let start = 0; start < ids.length; start += 5) {
        if (
          this.#disposed ||
          !this.#snapshot.available ||
          request.signal.aborted
        )
          return;
        await Promise.all(
          ids.slice(start, start + 5).map(async (projectId) => {
            try {
              const { foundation } = await this.#client.getFoundation(
                { projectId },
                { signal: request.signal },
              );
              if (
                !this.#disposed &&
                this.#snapshot.available &&
                !request.signal.aborted
              )
                this.#publish({
                  origins: new Map([
                    ...this.#snapshot.origins,
                    [projectId, foundation?.origin ?? null],
                  ]),
                });
            } catch {
              /* An unreadable origin is never guessed from title, task or existing text. */
            }
          }),
        );
      }
    } finally {
      for (const id of ids) this.#originReads.delete(id);
      if (this.#originRead === request) this.#originRead = null;
    }
  }
  setProposalDraft(proposalDraft: string) {
    if (!this.locked) {
      this.#proposalDirty = true;
      this.#publish({ proposalDraft, notice: null });
    }
  }
  async refresh(mode: "foreground" | "background" = "foreground") {
    const projectId = this.#snapshot.projectId;
    if (
      this.#disposed ||
      !this.#snapshot.available ||
      !projectId ||
      this.#snapshot.saving
    )
      return;
    this.#read?.abort();
    const request = new AbortController(),
      epoch = this.#epoch;
    this.#read = request;
    this.#backgroundRead = mode === "background" ? request : null;
    this.#publish({
      ...(mode === "foreground" ? { loading: true, notice: null } : {}),
      error: null,
    });
    try {
      const { foundation } = await this.#client.getFoundation(
        { projectId },
        { signal: request.signal },
      );
      if (!this.#readCurrent(epoch, request, mode)) return;
      this.#publish({
        foundation,
        origins: new Map([
          ...this.#snapshot.origins,
          [projectId, foundation?.origin ?? null],
        ]),
        loading: false,
      });
      if (!foundation) return; // A legacy v0 project stays unclassified; no record is auto-created.
      if (foundation.confirmedProposal) {
        const { proposal } = await this.#client.getProposal(
          {
            projectId,
            proposalRevision: foundation.confirmedProposal.revision,
          },
          { signal: request.signal },
        );
        if (!this.#readCurrent(epoch, request, mode)) return;
        this.#publish({
          proposal,
          ...(!this.#proposalDirty
            ? { proposalDraft: proposal?.text ?? "" }
            : {}),
        });
      }
      if (foundation.source) {
        const { source } = await this.#client.getSource(
          { projectId, sourceRevision: foundation.source.revision },
          { signal: request.signal },
        );
        if (!this.#readCurrent(epoch, request, mode)) return;
        this.#publish({ source });
      }
      await this.#latest(epoch, request, 0, mode);
    } catch (error) {
      if (this.#current(epoch, request))
        this.#publish({ loading: false, error: "无法读取创作资料，请重试。" });
    } finally {
      if (this.#read === request) this.#read = null;
      if (this.#backgroundRead === request) this.#backgroundRead = null;
      this.#refreshInvalidated();
    }
  }
  async continueProposals() {
    if (
      !this.#snapshot.available ||
      this.#snapshot.nextProposalRevision === null ||
      this.#snapshot.loading
    )
      return;
    const request = new AbortController(),
      epoch = this.#epoch;
    this.#read?.abort();
    this.#read = request;
    try {
      await this.#latest(epoch, request, this.#snapshot.nextProposalRevision);
    } catch {
      if (this.#current(epoch, request))
        this.#publish({ loading: false, error: "无法继续读取方案，请重试。" });
    } finally {
      if (this.#read === request) this.#read = null;
    }
  }
  async #latest(
    epoch: number,
    request: AbortController,
    after: number,
    mode: "foreground" | "background" = "foreground",
  ) {
    const projectId = this.#snapshot.projectId!;
    if (mode === "foreground") this.#publish({ loading: true });
    // At most 64 bounded pages per user action. Only the last page is retained, never the whole history/model context.
    for (let count = 0; count < 64; count++) {
      const page = await this.#client.listProposals(
        { projectId, afterProposalRevision: after, limit: 3 },
        { signal: request.signal },
      );
      if (!this.#readCurrent(epoch, request, mode)) return;
      const proposal = page.proposals.at(-1) ?? this.#snapshot.proposal;
      this.#latestProposalRevision = Math.max(
        this.#latestProposalRevision,
        page.proposals.at(-1)?.revision ?? 0,
      );
      this.#publish({
        proposals: page.proposals.length
          ? page.proposals
          : this.#snapshot.proposals,
        nextProposalRevision: page.nextRevision,
        latestProposalKnown: page.nextRevision === null,
        ...(this.#snapshot.foundation?.confirmedProposal
          ? {}
          : {
              proposal,
              ...(!this.#proposalDirty
                ? { proposalDraft: proposal?.text ?? "" }
                : {}),
            }),
      });
      if (page.nextRevision === null) break;
      after = page.nextRevision;
    }
    if (this.#current(epoch, request)) this.#publish({ loading: false });
  }
  async loadChapters(more = false) {
    const foundation = this.#snapshot.foundation;
    if (
      !this.#snapshot.available ||
      !foundation?.source ||
      (more && this.#snapshot.nextChapterOffset === null)
    )
      return;
    this.#chapterRead?.abort();
    const request = new AbortController(),
      epoch = this.#epoch;
    this.#chapterRead = request;
    this.#publish({ readingSource: true, error: null });
    try {
      const page = await this.#client.listSourceChapters(
        {
          projectId: foundation.projectId,
          sourceRevision: foundation.source.revision,
          sourceDigest: foundation.source.digest,
          afterStartOffset: more ? this.#snapshot.nextChapterOffset : null,
          limit: 16,
        },
        { signal: request.signal },
      );
      if (!this.#current(epoch, request)) return;
      this.#publish({
        chapters: page.chapters,
        nextChapterOffset: page.nextStartOffset,
        readingSource: false,
      });
    } catch {
      if (this.#current(epoch, request))
        this.#publish({
          readingSource: false,
          error: "无法读取章节，请重试。",
        });
    } finally {
      if (this.#chapterRead === request) this.#chapterRead = null;
    }
  }
  async readSource(startOffset = 0, endOffset?: number) {
    const foundation = this.#snapshot.foundation;
    if (!this.#snapshot.available || !foundation?.source) return;
    const limit =
      endOffset === undefined ? 1024 : Math.min(1024, endOffset - startOffset);
    if (limit < 1) return;
    this.#sourceRead?.abort();
    const request = new AbortController(),
      epoch = this.#epoch;
    this.#sourceRead = request;
    this.#publish({ readingSource: true, error: null });
    try {
      const { page } = await this.#client.readSourcePage(
        {
          projectId: foundation.projectId,
          sourceRevision: foundation.source.revision,
          sourceDigest: foundation.source.digest,
          startOffset,
          limit,
        },
        { signal: request.signal },
      );
      if (this.#current(epoch, request))
        this.#publish({ sourcePage: page, readingSource: false });
    } catch {
      if (this.#current(epoch, request))
        this.#publish({
          readingSource: false,
          error: "无法读取原文，请重试。",
        });
    } finally {
      if (this.#sourceRead === request) this.#sourceRead = null;
    }
  }
  async create(
    input: Omit<
      Parameters<PluginProjectFoundationClient["createProject"]>[0],
      "idempotencyKey"
    >,
  ) {
    return this.#begin({
      action: "crewon.project-foundation.v1.createProject",
      input: { ...input, idempotencyKey: crypto.randomUUID() },
    });
  }
  async saveParameters(parameters: ProjectFoundationCreationParameters) {
    const f = this.#snapshot.foundation;
    if (!f) return;
    return this.#begin({
      action: "crewon.project-foundation.v1.updateParameters",
      input: {
        projectId: f.projectId,
        expectedFoundationRevision: f.revision,
        parameters,
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }
  async appendSource(sourceUpload: ProjectFoundationSourceUpload) {
    const f = this.#snapshot.foundation;
    if (!f) return;
    return this.#begin({
      action: "crewon.project-foundation.v1.appendSource",
      input: {
        projectId: f.projectId,
        expectedFoundationRevision: f.revision,
        sourceUpload,
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }
  async saveProposal() {
    const f = this.#snapshot.foundation;
    if (!f || !this.#snapshot.latestProposalKnown) return;
    const revision = this.#latestProposalRevision;
    return this.#begin({
      action: "crewon.project-foundation.v1.saveProposal",
      input: {
        projectId: f.projectId,
        expectedFoundationRevision: f.revision,
        expectedProposalRevision: revision,
        kind: f.origin === "novel" ? "novel-adaptation" : "creative-plan",
        text: this.#snapshot.proposalDraft,
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }
  async confirmProposal() {
    const f = this.#snapshot.foundation,
      p = this.#snapshot.proposal;
    if (!f || !p) return;
    return this.#begin({
      action: "crewon.project-foundation.v1.confirmProposal",
      input: {
        projectId: f.projectId,
        expectedFoundationRevision: f.revision,
        proposalRevision: p.revision,
        proposalDigest: p.contentDigest,
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }
  async chooseStartMode(creativeStartMode: "confirm-plan" | "direct-script") {
    const f = this.#snapshot.foundation;
    if (!f || f.origin !== "creative") return;
    return this.#begin({
      action: "crewon.project-foundation.v1.chooseDirectScript",
      input: {
        projectId: f.projectId,
        expectedFoundationRevision: f.revision,
        creativeStartMode,
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }
  async retry() {
    if (this.#intent && !this.#write && this.#snapshot.available)
      return await this.#submit();
    return false;
  }
  async #begin(input: Pending) {
    if (
      this.#disposed ||
      !this.#snapshot.available ||
      this.locked ||
      this.#physicalPending() ||
      this.#project?.project.state === "archived"
    )
      return false;
    try {
      this.#intent = projectFoundationUiCodec.parseRequest(input) as Pending;
    } catch {
      this.#publish({ error: "请检查项目名称、内容和创作参数。" });
      return false;
    }
    ++this.#epoch;
    if (this.#backgroundRead && this.#backgroundRead === this.#read)
      this.#invalidatedProjectId = this.#snapshot.projectId;
    this.#read?.abort();
    this.#sourceRead?.abort();
    this.#chapterRead?.abort();
    return await this.#submit();
  }
  async #submit() {
    const intent = this.#intent;
    if (!intent || this.#disposed || this.#write || this.#physicalPending())
      return false;
    const request = new AbortController();
    this.#write = request;
    this.#publish({
      saving: true,
      pending: true,
      error: null,
      notice: null,
      conflict: false,
    });
    try {
      const options = { signal: request.signal };
      let result: ProjectFoundationMutationResponse;
      switch (intent.action) {
        case "crewon.project-foundation.v1.createProject":
          result = await this.#client.createProject(intent.input, options);
          break;
        case "crewon.project-foundation.v1.updateParameters":
          result = await this.#client.updateParameters(intent.input, options);
          break;
        case "crewon.project-foundation.v1.appendSource":
          result = await this.#client.appendSource(intent.input, options);
          break;
        case "crewon.project-foundation.v1.saveProposal":
          result = await this.#client.saveProposal(intent.input, options);
          break;
        case "crewon.project-foundation.v1.confirmProposal":
          result = await this.#client.confirmProposal(intent.input, options);
          break;
        case "crewon.project-foundation.v1.chooseDirectScript":
          result = await this.#client.chooseCreativeStartMode(
            intent.input,
            options,
          );
          break;
      }
      if (this.#disposed) return;
      this.#intent = null;
      if (result.proposal) {
        this.#proposalDirty = false;
        this.#latestProposalRevision = Math.max(
          this.#latestProposalRevision,
          result.proposal.revision,
        );
      }
      this.#publish({
        foundation: result.foundation,
        origins: new Map([
          ...this.#snapshot.origins,
          [result.project.projectId, result.foundation.origin],
        ]),
        projectId: result.project.projectId,
        ...(result.source
          ? { source: result.source, chapters: [], sourcePage: null }
          : {}),
        ...(result.proposal
          ? {
              proposal: result.proposal,
              proposalDraft: result.proposal.text,
              proposals:
                intent.action === "crewon.project-foundation.v1.saveProposal"
                  ? [result.proposal]
                  : this.#snapshot.proposals,
              latestProposalKnown:
                intent.action === "crewon.project-foundation.v1.saveProposal"
                  ? true
                  : this.#snapshot.latestProposalKnown,
              nextProposalRevision:
                intent.action === "crewon.project-foundation.v1.saveProposal"
                  ? null
                  : this.#snapshot.nextProposalRevision,
            }
          : {}),
        saving: false,
        pending: false,
        notice:
          intent.action === "crewon.project-foundation.v1.confirmProposal"
            ? "方案已确认"
            : "已保存",
      });
      // A readback/navigation failure cannot turn the already confirmed write into another submission.
      try {
        await this.#committed(result);
      } catch {
        this.#publish({
          error: "内容已保存，项目页面暂时无法读取，请重新打开项目。",
        });
      }
      return true;
    } catch (error) {
      if (this.#disposed) return;
      const failure = code(error);
      const conflict = /conflict|stale|mismatch/.test(failure);
      const rejected =
        conflict ||
        /denied|unavailable|invalid|not_found|archived|required|limit/.test(
          failure,
        );
      if (rejected) this.#intent = null;
      this.#publish({
        saving: false,
        pending: !rejected,
        conflict,
        error: conflict
          ? "创作资料已变化，重新读取后再保存。你的输入仍保留。"
          : /unavailable/.test(failure)
            ? "创作服务暂不可用，请稍后重试。"
            : rejected
              ? "未能保存，请检查创作资料和服务权限。"
              : "保存结果暂未确认，请重试原请求。",
      });
      return false;
    } finally {
      if (this.#write === request) this.#write = null;
      this.#publish({});
      this.#refreshInvalidated();
    }
  }
  #current(epoch: number, request: AbortController) {
    return (
      !this.#disposed &&
      this.#snapshot.available &&
      epoch === this.#epoch &&
      !request.signal.aborted
    );
  }
  #readCurrent(
    epoch: number,
    request: AbortController,
    mode: "foreground" | "background",
  ) {
    if (!this.#current(epoch, request)) return false;
    if (mode === "background" && (this.locked || this.#physicalPending())) {
      this.#invalidatedProjectId = this.#snapshot.projectId;
      return false;
    }
    return true;
  }
  #publish(patch: Partial<FoundationSnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  dispose() {
    this.#disposed = true;
    this.#read?.abort();
    this.#sourceRead?.abort();
    this.#chapterRead?.abort();
    this.#write?.abort();
    this.#originRead?.abort();
    this.#listeners.clear();
  }
}
