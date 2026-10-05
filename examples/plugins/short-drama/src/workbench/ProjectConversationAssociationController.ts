import type {
  AssociationAttachInput,
  AssociationCandidate,
  AssociationClient,
} from "../project-conversation-association-service";
import type { PluginProjectConversationsClient } from "../project-conversations-service";
import type { ProjectDetails } from "./creative-project-controller";
export type AssociationSnapshot = Readonly<{
  projectId: string | null;
  threadId: string | null;
  candidate: AssociationCandidate | null;
  reading: boolean;
  writing: boolean;
  pending: AssociationAttachInput | null;
  attached: boolean;
  error: string | null;
  notice: string | null;
}>;
/** Reading, reopening and switching projects never associate or start execution. */
export class ProjectConversationAssociationController {
  readonly #client: AssociationClient;
  readonly #readBinding: PluginProjectConversationsClient["getBinding"];
  readonly #physical: () => boolean;
  readonly #listeners = new Set<() => void>();
  #ready = false;
  #disposed = false;
  #activeProject = false;
  #epoch = 0;
  #operation: AbortController | null = null;
  #snapshot: AssociationSnapshot = {
    projectId: null,
    threadId: null,
    candidate: null,
    reading: false,
    writing: false,
    pending: null,
    attached: false,
    error: null,
    notice: null,
  };
  constructor(input: {
    client: AssociationClient;
    getBinding: PluginProjectConversationsClient["getBinding"];
    physicalWritesPending(): boolean;
  }) {
    this.#client = input.client;
    this.#readBinding = input.getBinding;
    this.#physical = input.physicalWritesPending;
  }
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly getSnapshot = () => this.#snapshot;
  refreshWriteActivity() {
    this.#publish({});
  }
  get locked() {
    return this.#snapshot.writing || this.#snapshot.pending !== null;
  }
  get canAttach() {
    return (
      this.#ready &&
      this.#activeProject &&
      !this.#disposed &&
      !this.#snapshot.reading &&
      !this.locked &&
      !this.#physical() &&
      this.#snapshot.candidate !== null
    );
  }
  #publish(patch: Partial<AssociationSnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  setContext(input: {
    ready: boolean;
    threadId: string | null;
    details: ProjectDetails | null;
  }) {
    const projectId = input.details?.project.projectId ?? null;
    const active = input.details?.project.state === "active";
    if (
      this.#disposed ||
      (input.ready === this.#ready &&
        input.threadId === this.#snapshot.threadId &&
        projectId === this.#snapshot.projectId &&
        active === this.#activeProject)
    )
      return;
    this.#ready = input.ready;
    this.#activeProject = active;
    ++this.#epoch;
    this.#operation?.abort();
    this.#operation = null;
    this.#publish({
      projectId,
      threadId: input.threadId,
      candidate: null,
      attached: false,
      writing: false,
      reading: false,
      error: null,
      notice: null,
    });
    if (
      input.ready &&
      (this.#snapshot.pending ||
        (projectId !== null && input.threadId !== null))
    )
      void this.refresh();
  }
  #current(epoch: number, operation: AbortController) {
    return (
      !this.#disposed &&
      this.#ready &&
      epoch === this.#epoch &&
      !operation.signal.aborted
    );
  }
  async refresh() {
    const { projectId, threadId, writing, pending } = this.#snapshot;
    if (
      !this.#ready ||
      this.#disposed ||
      (!pending && (projectId === null || threadId === null)) ||
      writing
    )
      return;
    this.#operation?.abort();
    const operation = new AbortController(),
      epoch = this.#epoch;
    this.#operation = operation;
    this.#publish({ reading: true, candidate: null, error: null });
    const targetProjectId = pending?.projectId ?? projectId!;
    const targetThreadId = pending?.threadId ?? threadId!;
    const targetIsCurrent =
      targetProjectId === projectId && targetThreadId === threadId;
    try {
      const { binding } = await this.#readBinding(
        { threadId: targetThreadId },
        { signal: operation.signal },
      );
      if (!this.#current(epoch, operation)) return;
      if (binding !== null) {
        const matches =
          binding.projectId === targetProjectId &&
          binding.threadId === targetThreadId &&
          binding.state === "active" &&
          (!pending || binding.workspaceId === pending.workspaceId);
        this.#publish({
          attached: targetIsCurrent && matches,
          ...(matches
            ? {
                pending: null,
                notice: targetIsCurrent
                  ? "当前会话已关联此项目，可在原对话继续创作。"
                  : "原会话关联已确认，请重新读取当前会话。",
              }
            : {
                ...(pending ? { pending: null } : {}),
                error: "该会话已有项目关联，请使用该项目或新建项目对话。",
              }),
        });
      } else {
        const result = await this.#client.inspect(
          { projectId: targetProjectId, threadId: targetThreadId },
          { signal: operation.signal },
        );
        if (!this.#current(epoch, operation)) return;
        if (
          result.candidate !== null &&
          result.candidate.threadId !== targetThreadId
        )
          throw new Error("association_scope_invalid");
        const changed =
          pending &&
          result.candidate !== null &&
          (result.candidate.threadRevision !== pending.expectedThreadRevision ||
            result.candidate.workspaceId !== pending.workspaceId);
        this.#publish({
          candidate:
            targetIsCurrent && (!pending || changed) ? result.candidate : null,
          ...(changed
            ? {
                pending: null,
                notice:
                  "原会话版本已变化，原请求不能再关联。请重新确认当前会话。",
              }
            : {}),
        });
      }
    } catch {
      if (this.#current(epoch, operation))
        this.#publish({ error: "当前会话关联状态暂时无法确认，请重新读取。" });
    } finally {
      if (this.#current(epoch, operation)) this.#publish({ reading: false });
      if (this.#operation === operation) this.#operation = null;
    }
  }
  async attach() {
    if (
      !this.canAttach ||
      !this.#snapshot.projectId ||
      !this.#snapshot.candidate
    )
      return;
    const { candidate, projectId } = this.#snapshot;
    const input: AssociationAttachInput = Object.freeze({
      projectId,
      threadId: candidate.threadId,
      workspaceId: candidate.workspaceId,
      expectedThreadRevision: candidate.threadRevision,
      idempotencyKey: crypto.randomUUID(),
    });
    this.#publish({ pending: input });
    await this.#attach(input);
  }
  async retryOriginal() {
    const { pending, projectId, threadId, writing, reading } = this.#snapshot;
    if (
      !pending ||
      pending.projectId !== projectId ||
      pending.threadId !== threadId ||
      !this.#ready ||
      this.#disposed ||
      writing ||
      reading ||
      this.#physical()
    )
      return;
    await this.#attach(pending);
  }
  async #attach(input: AssociationAttachInput) {
    this.#operation?.abort();
    const operation = new AbortController(),
      epoch = this.#epoch;
    this.#operation = operation;
    this.#publish({
      writing: true,
      reading: false,
      candidate: null,
      error: null,
      notice: null,
    });
    try {
      const result = await this.#client.attach(input, {
        signal: operation.signal,
      });
      if (!this.#current(epoch, operation)) return;
      if (
        result.binding.projectId !== input.projectId ||
        result.binding.threadId !== input.threadId ||
        result.binding.workspaceId !== input.workspaceId
      )
        throw new Error("association_scope_invalid");
      this.#publish({
        pending: null,
        attached: true,
        notice: "当前会话已关联此项目，可在原对话继续创作。",
      });
    } catch {
      if (this.#current(epoch, operation))
        this.#publish({
          error:
            "尚未确认关联结果。可先重新读取；重试只使用原会话与原请求。会话执行中或版本变化时会拒绝关联。",
        });
    } finally {
      if (this.#current(epoch, operation)) this.#publish({ writing: false });
      if (this.#operation === operation) this.#operation = null;
    }
  }
  dispose() {
    this.#operation?.abort();
    this.#disposed = true;
    ++this.#epoch;
    this.#listeners.clear();
  }
}
