import type {
  PluginProjectConversationsClient,
  PublicProjectConversationBinding,
} from "../project-conversations-service";
import type { ProjectDetails } from "./creative-project-controller";

type CreateInput = Parameters<
  PluginProjectConversationsClient["createConversation"]
>[0];
type SourceRefresh = Readonly<{
  input: Parameters<PluginProjectConversationsClient["refreshSource"]>[0];
  binding: PublicProjectConversationBinding;
}>;
export type CreationWorkspace = Readonly<{
  workspaceId: string | null;
  name: string | null;
}>;
type WorkspaceResolver = (
  input: Readonly<{ projectId: string }>,
  options: Readonly<{ signal: AbortSignal }>,
) => Promise<Readonly<{ projectId: string; workspaceId: string }>>;
export type ConversationSnapshot = Readonly<{
  projectId: string | null;
  phase: "waiting" | "loading" | "ready" | "unavailable";
  bindings: readonly PublicProjectConversationBinding[];
  nextThreadId: string | null;
  workspace: CreationWorkspace | null;
  resolvingWorkspace: boolean;
  creating: boolean;
  openingThreadId: string | null;
  openedThreadId: string | null;
  automaticOpen: boolean;
  automaticConnecting: boolean;
  pendingCreation: CreateInput | null;
  sourceRefreshThreadId: string | null;
  refreshingSource: boolean;
  pendingSourceRefresh: SourceRefresh | null;
  error: string | null;
  notice: string | null;
}>;

/** Reads actual project bindings; a selected global chat is never a project association. */
export class ProjectConversationController {
  readonly #client: Pick<
    PluginProjectConversationsClient,
    | "listConversations"
    | "createConversation"
    | "openConversation"
    | "refreshSource"
  >;
  readonly #physicalWritesPending: () => boolean;
  readonly #resolveWorkspace: WorkspaceResolver | undefined;
  readonly #listeners = new Set<() => void>();
  #snapshot: ConversationSnapshot = {
    projectId: null,
    phase: "waiting",
    bindings: [],
    nextThreadId: null,
    workspace: null,
    resolvingWorkspace: false,
    creating: false,
    openingThreadId: null,
    openedThreadId: null,
    automaticOpen: false,
    automaticConnecting: false,
    pendingCreation: null,
    sourceRefreshThreadId: null,
    refreshingSource: false,
    pendingSourceRefresh: null,
    error: null,
    notice: null,
  };
  #project: ProjectDetails | null = null;
  #ready = false;
  #disposed = false;
  #epoch = 0;
  #read: AbortController | null = null;
  #operation: AbortController | null = null;
  #automaticRequested = false;
  #automaticScheduled = false;
  #rememberedThreads = new Map<string, string>();
  #pendingProjects = new Map<
    string,
    Pick<
      ConversationSnapshot,
      "pendingCreation" | "pendingSourceRefresh" | "sourceRefreshThreadId"
    >
  >();

  constructor(ports: {
    client: Pick<
      PluginProjectConversationsClient,
      | "listConversations"
      | "createConversation"
      | "openConversation"
      | "refreshSource"
    >;
    physicalWritesPending(): boolean;
    resolveWorkspace?: WorkspaceResolver;
  }) {
    this.#client = ports.client;
    this.#physicalWritesPending = ports.physicalWritesPending;
    this.#resolveWorkspace = ports.resolveWorkspace;
  }
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly getSnapshot = () => this.#snapshot;
  get locked() {
    return (
      this.#snapshot.resolvingWorkspace ||
      this.#snapshot.creating ||
      this.#snapshot.openingThreadId !== null ||
      this.#snapshot.pendingCreation !== null ||
      this.#snapshot.refreshingSource ||
      this.#snapshot.pendingSourceRefresh !== null
    );
  }
  get canCreate() {
    return (
      this.#ready &&
      !this.#disposed &&
      this.#project?.project.state === "active" &&
      this.#snapshot.phase === "ready" &&
      (this.#resolveWorkspace !== undefined ||
        this.#snapshot.workspace !== null) &&
      !this.locked &&
      !this.#physicalWritesPending()
    );
  }
  #publish(patch: Partial<ConversationSnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
    this.#scheduleAutomaticOpen();
  }
  #invalidate() {
    ++this.#epoch;
    this.#read?.abort();
    this.#read = null;
    this.#operation?.abort();
    this.#operation = null;
  }
  setReady(ready: boolean) {
    if (this.#disposed || ready === this.#ready) return;
    this.#ready = ready;
    if (!ready && this.#snapshot.openedThreadId)
      this.#automaticRequested = true;
    this.#invalidate();
    this.#publish({
      resolvingWorkspace: false,
      creating: false,
      refreshingSource: false,
      openingThreadId: null,
      openedThreadId: null,
      automaticConnecting: false,
      phase: ready ? "loading" : "waiting",
    });
    if (ready && this.#project) void this.refresh();
  }
  setWorkspace(workspace: CreationWorkspace | null) {
    if (
      this.#disposed ||
      (workspace?.workspaceId === this.#snapshot.workspace?.workspaceId &&
        workspace?.name === this.#snapshot.workspace?.name &&
        Boolean(workspace) === Boolean(this.#snapshot.workspace))
    )
      return;
    this.#publish({ workspace: workspace ? { ...workspace } : null });
  }
  setProject(details: ProjectDetails | null) {
    if (this.#disposed) return;
    const changed =
      details?.project.projectId !== this.#project?.project.projectId;
    const previousId = this.#project?.project.projectId;
    if (changed && previousId) {
      if (this.#snapshot.pendingCreation || this.#snapshot.pendingSourceRefresh)
        this.#rememberPending(previousId);
      else this.#pendingProjects.delete(previousId);
    }
    this.#project = details;
    if (!changed) return;
    this.#invalidate();
    this.#automaticRequested = true;
    const pending = details
      ? this.#pendingProjects.get(details.project.projectId)
      : undefined;
    this.#publish({
      projectId: details?.project.projectId ?? null,
      bindings: [],
      nextThreadId: null,
      phase: this.#ready && details ? "loading" : "waiting",
      resolvingWorkspace: false,
      creating: false,
      openingThreadId: null,
      openedThreadId: null,
      automaticConnecting: false,
      pendingCreation: pending?.pendingCreation ?? null,
      error: null,
      notice: null,
      sourceRefreshThreadId: pending?.sourceRefreshThreadId ?? null,
      refreshingSource: false,
      pendingSourceRefresh: pending?.pendingSourceRefresh ?? null,
    });
    if (this.#ready && details) void this.refresh();
  }
  refreshWriteActivity() {
    this.#publish({});
  }
  /** Only the navigation owner opens the central chat; right result pages stay read-only. */
  setAutomaticOpen(enabled: boolean) {
    if (this.#disposed || enabled === this.#snapshot.automaticOpen) return;
    if (enabled) this.#automaticRequested = true;
    if (!enabled && this.#snapshot.automaticConnecting) {
      this.#invalidate();
      this.#publish({
        resolvingWorkspace: false,
        creating: false,
        openingThreadId: null,
        refreshingSource: false,
        automaticConnecting: false,
      });
    }
    this.#publish({ automaticOpen: enabled });
  }
  #rememberPending(projectId: string) {
    this.#pendingProjects.delete(projectId);
    this.#pendingProjects.set(projectId, {
      pendingCreation: this.#snapshot.pendingCreation,
      pendingSourceRefresh: this.#snapshot.pendingSourceRefresh,
      sourceRefreshThreadId: this.#snapshot.sourceRefreshThreadId,
    });
    while (this.#pendingProjects.size > 32)
      this.#pendingProjects.delete(this.#pendingProjects.keys().next().value!);
  }
  #scheduleAutomaticOpen() {
    if (this.#automaticScheduled || !this.#canAutomaticallyOpen()) return;
    this.#automaticScheduled = true;
    queueMicrotask(() => {
      this.#automaticScheduled = false;
      if (this.#canAutomaticallyOpen()) void this.#openAutomatically();
    });
  }
  #canAutomaticallyOpen() {
    return (
      this.#snapshot.automaticOpen &&
      this.#automaticRequested &&
      !this.#snapshot.automaticConnecting &&
      !this.#snapshot.error &&
      this.#ready &&
      !this.#disposed &&
      this.#project !== null &&
      this.#snapshot.phase === "ready" &&
      !this.locked &&
      !this.#physicalWritesPending()
    );
  }
  async #openAutomatically() {
    if (!this.#canAutomaticallyOpen() || !this.#project) return;
    const projectId = this.#project.project.projectId,
      epoch = this.#epoch;
    this.#automaticRequested = false;
    this.#publish({ automaticConnecting: true });
    try {
      // Bounded reads avoid creating a second chat when older revoked bindings fill a page.
      for (let page = 0; page <= 4; page++) {
        if (
          this.#disposed ||
          !this.#ready ||
          epoch !== this.#epoch ||
          this.#project?.project.projectId !== projectId
        )
          return;
        const active = this.#snapshot.bindings.filter(
          (binding) => binding.state === "active",
        );
        const remembered = this.#rememberedThreads.get(projectId);
        const selected =
          active.find((binding) => binding.threadId === remembered) ??
          active[0];
        if (selected) {
          await this.open(selected.threadId);
          if (
            this.#snapshot.sourceRefreshThreadId === selected.threadId &&
            epoch === this.#epoch &&
            this.#project?.project.projectId === projectId
          )
            if (this.#project?.project.state === "active")
              await this.refreshSourceAndOpen(selected.threadId);
            else
              this.#publish({
                error: "归档项目的会话关联已过期。恢复项目后可重新连接。",
              });
          return;
        }
        if (!this.#snapshot.nextThreadId) {
          if (this.#project?.project.state !== "active") {
            this.#publish({ notice: "归档项目暂无可恢复的对话。" });
            return;
          }
          const created = await this.#prepareCreation("initial");
          if (created && epoch === this.#epoch)
            await this.open(created.threadId);
          return;
        }
        if (page === 4) break;
        await this.refresh({ more: true });
        if (this.#snapshot.phase !== "ready") return;
      }
      this.#publish({ error: "请继续读取项目对话，再选择要继续的对话。" });
    } finally {
      if (!this.#disposed && epoch === this.#epoch)
        this.#publish({ automaticConnecting: false });
    }
  }
  /** Explicit recovery after a failed open; repeated renders never retry a request. */
  async reconnect() {
    if (this.#disposed || this.locked || this.#physicalWritesPending()) return;
    this.#automaticRequested = true;
    await this.refresh();
  }
  async refresh({ more = false }: { more?: boolean } = {}) {
    if (
      !this.#ready ||
      this.#disposed ||
      !this.#project ||
      this.#snapshot.creating ||
      this.#snapshot.refreshingSource ||
      this.#snapshot.openingThreadId
    )
      return;
    const projectId = this.#project.project.projectId,
      epoch = this.#epoch;
    this.#read?.abort();
    const read = new AbortController();
    this.#read = read;
    this.#publish({ phase: "loading", error: null });
    try {
      const response = await this.#client.listConversations(
        {
          projectId,
          afterThreadId: more ? this.#snapshot.nextThreadId : null,
          limit: 8,
        },
        { signal: read.signal },
      );
      if (!this.#current(epoch, projectId, read)) return;
      if (response.bindings.some((binding) => binding.projectId !== projectId))
        throw new Error("project_conversation_response_scope_invalid");
      const merged = new Map(
        (more ? this.#snapshot.bindings : []).map((binding) => [
          binding.threadId,
          binding,
        ]),
      );
      for (const binding of response.bindings) {
        const old = merged.get(binding.threadId);
        if (!old || binding.revision >= old.revision)
          merged.set(binding.threadId, binding);
      }
      this.#publish({
        phase: "ready",
        bindings: [...merged.values()],
        nextThreadId: response.nextThreadId,
      });
    } catch {
      if (this.#current(epoch, projectId, read))
        this.#publish({
          phase: "unavailable",
          error: "项目对话暂时无法读取，请重新连接。",
        });
    } finally {
      if (this.#read === read) this.#read = null;
    }
  }
  #current(epoch: number, projectId: string, operation: AbortController) {
    return (
      !this.#disposed &&
      this.#ready &&
      !operation.signal.aborted &&
      epoch === this.#epoch &&
      this.#project?.project.projectId === projectId
    );
  }
  async create() {
    const created = await this.#prepareCreation("additional");
    if (created && this.#snapshot.automaticOpen)
      await this.open(created.threadId);
  }
  async #prepareCreation(kind: "initial" | "additional") {
    if (!this.canCreate || !this.#project) return null;
    const projectId = this.#project.project.projectId,
      epoch = this.#epoch,
      operation = new AbortController();
    this.#operation = operation;
    this.#publish({ resolvingWorkspace: true, error: null, notice: null });
    let input: CreateInput;
    try {
      let workspaceId = this.#snapshot.workspace?.workspaceId ?? null;
      if (this.#resolveWorkspace) {
        const target = await this.#resolveWorkspace(
          { projectId },
          { signal: operation.signal },
        );
        if (!this.#current(epoch, projectId, operation)) return null;
        if (
          target.projectId !== projectId ||
          !/^workspace-project-[a-f0-9]{64}$/u.test(target.workspaceId)
        )
          throw new Error("project_conversation_workspace_target_invalid");
        workspaceId = target.workspaceId;
      }
      const idempotencyKey =
        kind === "initial"
          ? await initialConversationKey(projectId, workspaceId)
          : crypto.randomUUID();
      if (!this.#current(epoch, projectId, operation)) return null;
      if (this.#project?.project.state !== "active") return null;
      input = Object.freeze({
        projectId,
        workspaceId,
        title: null,
        idempotencyKey,
      });
      this.#publish({
        resolvingWorkspace: false,
        workspace: {
          workspaceId,
          name: this.#snapshot.workspace?.name ?? null,
        },
        pendingCreation: input,
      });
    } catch {
      if (this.#current(epoch, projectId, operation))
        this.#publish({
          error: "项目工作空间暂时无法连接，请重新连接。",
        });
      return null;
    } finally {
      if (this.#operation === operation) this.#operation = null;
      if (this.#current(epoch, projectId, operation))
        this.#publish({ resolvingWorkspace: false });
    }
    return this.#create(input, { refreshBindings: kind === "additional" });
  }
  /** The explicit main action creates once, then opens the actual bound host conversation. */
  async begin() {
    if (!this.canCreate) return;
    const created = await this.#prepareCreation("additional");
    if (created) await this.open(created.threadId);
  }
  async retryCreation() {
    const original = this.#snapshot.pendingCreation;
    if (!original || !this.canRetryCreation) return;
    const created = await this.#create(original);
    if (created && this.#snapshot.automaticOpen)
      await this.open(created.threadId);
  }
  get canRetryCreation() {
    const original = this.#snapshot.pendingCreation;
    return Boolean(
      original &&
        this.#ready &&
        !this.#disposed &&
        this.#project?.project.state === "active" &&
        !this.#snapshot.resolvingWorkspace &&
        !this.#snapshot.creating &&
        !this.#snapshot.openingThreadId &&
        !this.#snapshot.refreshingSource &&
        !this.#physicalWritesPending() &&
        original.projectId === this.#project?.project.projectId,
    );
  }
  async #create(
    input: CreateInput,
    { refreshBindings = true }: { refreshBindings?: boolean } = {},
  ): Promise<PublicProjectConversationBinding | null> {
    this.#read?.abort();
    this.#read = null;
    const operation = new AbortController(),
      epoch = this.#epoch;
    this.#operation = operation;
    this.#publish({ creating: true, error: null, notice: null });
    try {
      const response = await this.#client.createConversation(input, {
        signal: operation.signal,
      });
      if (!this.#current(epoch, input.projectId, operation)) return null;
      if (
        response.binding.projectId !== input.projectId ||
        response.binding.workspaceId !== input.workspaceId
      )
        throw new Error("project_conversation_response_scope_invalid");
      this.#publish({
        bindings: [
          ...this.#snapshot.bindings.filter(
            (binding) => binding.threadId !== response.binding.threadId,
          ),
          response.binding,
        ],
        pendingCreation: null,
        creating: false,
        notice: "项目对话已创建，进入后可与 Agent 继续创作。",
      });
      this.#pendingProjects.delete(input.projectId);
      if (refreshBindings) await this.refresh();
      return response.binding;
    } catch {
      if (this.#current(epoch, input.projectId, operation))
        this.#publish({
          creating: false,
          error: "尚未确认创建结果。重试会使用原项目、工作空间与原请求。",
        });
      return null;
    } finally {
      if (this.#operation === operation) this.#operation = null;
    }
  }
  async open(threadId: string) {
    if (
      !this.#ready ||
      this.#disposed ||
      !this.#project ||
      this.locked ||
      this.#physicalWritesPending()
    )
      return;
    const binding = this.#snapshot.bindings.find(
      (item) => item.threadId === threadId,
    );
    if (!binding || binding.state !== "active") return;
    const projectId = this.#project.project.projectId,
      epoch = this.#epoch;
    this.#read?.abort();
    this.#read = null;
    const operation = new AbortController();
    this.#operation = operation;
    this.#publish({ openingThreadId: threadId, error: null, notice: null });
    try {
      const result = await this.#client.openConversation(
        { projectId, threadId },
        { signal: operation.signal },
      );
      if (!this.#current(epoch, projectId, operation)) return;
      if (
        result.binding.projectId !== projectId ||
        result.binding.threadId !== threadId ||
        result.binding.workspaceId !== binding.workspaceId ||
        result.binding.revision < binding.revision
      )
        throw new Error("project_conversation_response_scope_invalid");
      this.#publish({
        notice: "已请求打开项目对话。",
        sourceRefreshThreadId: null,
        openedThreadId: threadId,
      });
      this.#rememberedThreads.delete(projectId);
      this.#rememberedThreads.set(projectId, threadId);
      while (this.#rememberedThreads.size > 32)
        this.#rememberedThreads.delete(
          this.#rememberedThreads.keys().next().value!,
        );
    } catch (error) {
      if (this.#current(epoch, projectId, operation))
        this.#publish(
          errorCode(error) === "project_conversation_source_mismatch"
            ? {
                sourceRefreshThreadId: threadId,
                error:
                  "此会话的插件关联已过期。更新关联后可继续使用原工作空间和历史。",
              }
            : { error: "暂时无法打开此项目对话，请重新读取后再试。" },
        );
    } finally {
      if (this.#operation === operation) this.#operation = null;
      if (this.#current(epoch, projectId, operation))
        this.#publish({ openingThreadId: null });
    }
  }
  get canRefreshSource() {
    return (
      this.#ready &&
      !this.#disposed &&
      this.#project?.project.state === "active" &&
      !this.#snapshot.resolvingWorkspace &&
      !this.#snapshot.creating &&
      !this.#snapshot.openingThreadId &&
      !this.#snapshot.refreshingSource &&
      !this.#snapshot.pendingCreation &&
      !this.#physicalWritesPending()
    );
  }
  async refreshSourceAndOpen(threadId: string) {
    if (
      !this.canRefreshSource ||
      this.#snapshot.pendingSourceRefresh ||
      this.#snapshot.sourceRefreshThreadId !== threadId
    )
      return;
    const binding = this.#snapshot.bindings.find(
      (b) => b.threadId === threadId,
    );
    if (
      !binding ||
      binding.state !== "active" ||
      binding.projectId !== this.#project?.project.projectId
    )
      return;
    const pending: SourceRefresh = Object.freeze({
      binding,
      input: Object.freeze({
        projectId: binding.projectId,
        threadId,
        expectedBindingRevision: binding.revision,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    this.#publish({ pendingSourceRefresh: pending });
    await this.#refreshSource(pending);
  }
  async retrySourceRefresh() {
    const pending = this.#snapshot.pendingSourceRefresh;
    if (
      !pending ||
      !this.canRefreshSource ||
      pending.input.projectId !== this.#project?.project.projectId
    )
      return;
    await this.#refreshSource(pending);
  }
  async #refreshSource(pending: SourceRefresh) {
    this.#read?.abort();
    this.#read = null;
    const operation = new AbortController(),
      epoch = this.#epoch;
    this.#operation = operation;
    this.#publish({ refreshingSource: true, error: null, notice: null });
    let confirmed = false;
    try {
      const { binding } = await this.#client.refreshSource(pending.input, {
        signal: operation.signal,
      });
      if (!this.#current(epoch, pending.input.projectId, operation)) return;
      if (
        binding.bindingId !== pending.binding.bindingId ||
        binding.projectId !== pending.input.projectId ||
        binding.threadId !== pending.input.threadId ||
        binding.workspaceId !== pending.binding.workspaceId ||
        binding.state !== "active" ||
        binding.revision !== pending.input.expectedBindingRevision + 1 ||
        binding.source.pluginId !== pending.binding.source.pluginId ||
        binding.source.publisherId !== pending.binding.source.publisherId
      )
        throw new Error("project_conversation_response_scope_invalid");
      confirmed = true;
      this.#publish({
        pendingSourceRefresh: null,
        sourceRefreshThreadId: null,
        bindings: this.#snapshot.bindings.map((b) =>
          b.threadId === binding.threadId ? binding : b,
        ),
        notice: "会话关联已更新，原工作空间和历史已保留。",
      });
    } catch (error) {
      if (this.#current(epoch, pending.input.projectId, operation)) {
        const conflict =
          errorCode(error) === "project_conversation_revision_conflict";
        this.#publish({
          ...(conflict
            ? { pendingSourceRefresh: null, sourceRefreshThreadId: null }
            : {}),
          error: conflict
            ? "会话关联已变化，请刷新项目对话后重新进入。"
            : "尚未确认关联更新结果。重试会使用原会话、关联版本与原请求。",
        });
      }
    } finally {
      if (this.#operation === operation) this.#operation = null;
      if (this.#current(epoch, pending.input.projectId, operation))
        this.#publish({ refreshingSource: false });
    }
    if (confirmed && this.#current(epoch, pending.input.projectId, operation))
      await this.open(pending.input.threadId);
  }
  dispose() {
    if (this.#disposed) return;
    this.#invalidate();
    this.#disposed = true;
    this.#listeners.clear();
  }
}
async function initialConversationKey(
  projectId: string,
  workspaceId: string | null,
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([projectId, workspaceId])),
  );
  return (
    "project-chat-v1-" +
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  );
}
function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
  return typeof code === "string"
    ? code
    : error instanceof Error
      ? error.message
      : null;
}
