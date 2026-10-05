import type {
  PluginProjectConversationsClient,
  PublicProjectConversationBinding,
} from "../project-conversations-service";
import type { ProjectDetails } from "./creative-project-controller";

type CreateInput = Parameters<
  PluginProjectConversationsClient["createConversation"]
>[0];
export type CreationWorkspace = Readonly<{
  workspaceId: string | null;
  name: string | null;
}>;
export type ConversationSnapshot = Readonly<{
  projectId: string | null;
  phase: "waiting" | "loading" | "ready" | "unavailable";
  bindings: readonly PublicProjectConversationBinding[];
  nextThreadId: string | null;
  workspace: CreationWorkspace | null;
  creating: boolean;
  openingThreadId: string | null;
  pendingCreation: CreateInput | null;
  error: string | null;
  notice: string | null;
}>;

/** Reads actual project bindings; a selected global chat is never a project association. */
export class ProjectConversationController {
  readonly #client: Pick<
    PluginProjectConversationsClient,
    "listConversations" | "createConversation" | "openConversation"
  >;
  readonly #physicalWritesPending: () => boolean;
  readonly #listeners = new Set<() => void>();
  #snapshot: ConversationSnapshot = {
    projectId: null,
    phase: "waiting",
    bindings: [],
    nextThreadId: null,
    workspace: null,
    creating: false,
    openingThreadId: null,
    pendingCreation: null,
    error: null,
    notice: null,
  };
  #project: ProjectDetails | null = null;
  #ready = false;
  #disposed = false;
  #epoch = 0;
  #read: AbortController | null = null;
  #operation: AbortController | null = null;

  constructor(ports: {
    client: Pick<
      PluginProjectConversationsClient,
      "listConversations" | "createConversation" | "openConversation"
    >;
    physicalWritesPending(): boolean;
  }) {
    this.#client = ports.client;
    this.#physicalWritesPending = ports.physicalWritesPending;
  }
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly getSnapshot = () => this.#snapshot;
  get locked() {
    return (
      this.#snapshot.creating ||
      this.#snapshot.openingThreadId !== null ||
      this.#snapshot.pendingCreation !== null
    );
  }
  get canCreate() {
    return (
      this.#ready &&
      !this.#disposed &&
      this.#project?.project.state === "active" &&
      this.#snapshot.phase === "ready" &&
      this.#snapshot.workspace !== null &&
      !this.locked &&
      !this.#physicalWritesPending()
    );
  }
  #publish(patch: Partial<ConversationSnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
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
    this.#invalidate();
    this.#publish({
      creating: false,
      openingThreadId: null,
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
    this.#project = details;
    if (!changed) return;
    this.#invalidate();
    this.#publish({
      projectId: details?.project.projectId ?? null,
      bindings: [],
      nextThreadId: null,
      phase: this.#ready && details ? "loading" : "waiting",
      creating: false,
      openingThreadId: null,
      error: null,
      notice: null,
    });
    if (this.#ready && details) void this.refresh();
  }
  refreshWriteActivity() {
    this.#publish({});
  }
  async refresh({ more = false }: { more?: boolean } = {}) {
    if (
      !this.#ready ||
      this.#disposed ||
      !this.#project ||
      this.#snapshot.creating ||
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
    if (!this.canCreate || !this.#project || !this.#snapshot.workspace) return;
    const input: CreateInput = {
      projectId: this.#project.project.projectId,
      workspaceId: this.#snapshot.workspace.workspaceId,
      title: null,
      idempotencyKey: crypto.randomUUID(),
    };
    this.#publish({ pendingCreation: input });
    await this.#create(input);
  }
  async retryCreation() {
    const original = this.#snapshot.pendingCreation;
    if (
      !original ||
      !this.#ready ||
      this.#snapshot.creating ||
      this.#physicalWritesPending() ||
      original.projectId !== this.#project?.project.projectId
    )
      return;
    await this.#create(original);
  }
  async #create(input: CreateInput) {
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
      if (!this.#current(epoch, input.projectId, operation)) return;
      if (
        response.binding.projectId !== input.projectId ||
        response.binding.workspaceId !== input.workspaceId
      )
        throw new Error("project_conversation_response_scope_invalid");
      this.#publish({
        pendingCreation: null,
        creating: false,
        notice: "项目对话已创建，进入后可与 Agent 继续创作。",
      });
      await this.refresh();
    } catch {
      if (this.#current(epoch, input.projectId, operation))
        this.#publish({
          creating: false,
          error: "尚未确认创建结果。重试会使用原项目、工作空间与原请求。",
        });
    } finally {
      if (this.#operation === operation) this.#operation = null;
    }
  }
  async open(threadId: string) {
    if (
      !this.#ready ||
      this.#disposed ||
      !this.#project ||
      this.#snapshot.creating ||
      this.#snapshot.openingThreadId
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
      this.#publish({ notice: "已请求打开项目对话。" });
    } catch {
      if (this.#current(epoch, projectId, operation))
        this.#publish({ error: "暂时无法打开此项目对话，请重新读取后再试。" });
    } finally {
      if (this.#operation === operation) this.#operation = null;
      if (this.#current(epoch, projectId, operation))
        this.#publish({ openingThreadId: null });
    }
  }
  dispose() {
    if (this.#disposed) return;
    this.#invalidate();
    this.#disposed = true;
    this.#listeners.clear();
  }
}
