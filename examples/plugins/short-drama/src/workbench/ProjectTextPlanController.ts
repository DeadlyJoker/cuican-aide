import type {
  PluginProjectTextPlansClient,
  ProjectTextPlansRequests,
  ProjectTextPlanDefinitionInput,
  ProjectTextPlanMutationResponse,
  PublicProjectTextPlanSummary,
  PublicProjectTextPlanView,
} from "../project-text-plans-service";
import type { PublicProjectConversationBinding } from "../project-conversations-service";
import type { ProjectDetails } from "./creative-project-controller";
import { PROJECT_TEXT_PLANS_METHOD_ACTIONS } from "../project-text-plans-service";
import { projectTextPlansCodec } from "../project-text-plans-codec.mjs";

type WriteMethod = Exclude<keyof ProjectTextPlansRequests, "get" | "list">;
type Intent = {
  [M in WriteMethod]: Readonly<{
    method: M;
    input: ProjectTextPlansRequests[M];
  }>;
}[WriteMethod];
export type TextPlanSnapshot = Readonly<{
  projectId: string | null;
  phase: "waiting" | "loading" | "ready" | "unavailable";
  plans: readonly PublicProjectTextPlanSummary[];
  nextPlanId: string | null;
  view: PublicProjectTextPlanView | null;
  reading: boolean;
  writing: boolean;
  pending: Intent | null;
  error: string | null;
  notice: string | null;
}>;

/** The durable scheduler lives in the host; this controller only makes explicit user calls. */
export class ProjectTextPlanController {
  readonly #client: PluginProjectTextPlansClient;
  readonly #physicalWritesPending: () => boolean;
  readonly #listeners = new Set<() => void>();
  #modelId: string | null = null;
  #ready = false;
  #disposed = false;
  #epoch = 0;
  #project: ProjectDetails | null = null;
  #selectedPlanId: string | null = null;
  #read: AbortController | null = null;
  #write: AbortController | null = null;
  #snapshot: TextPlanSnapshot = {
    projectId: null,
    phase: "waiting",
    plans: [],
    nextPlanId: null,
    view: null,
    reading: false,
    writing: false,
    pending: null,
    error: null,
    notice: null,
  };
  constructor(ports: {
    client: PluginProjectTextPlansClient;
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
    return this.#snapshot.writing || this.#snapshot.pending !== null;
  }
  get canWrite() {
    return (
      this.#ready &&
      !this.#disposed &&
      this.#snapshot.phase === "ready" &&
      this.#project?.project.state === "active" &&
      !this.locked &&
      !this.#physicalWritesPending()
    );
  }
  #publish(patch: Partial<TextPlanSnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #invalidate() {
    ++this.#epoch;
    this.#read?.abort();
    this.#read = null;
    this.#write?.abort();
    this.#write = null;
  }
  /** Shared homepage selection is captured only for a new request, never an unknown receipt retry. */
  setModelSelection(modelId: string | null) {
    if (
      modelId !== null &&
      (typeof modelId !== "string" ||
        !modelId ||
        modelId.trim() !== modelId ||
        new TextEncoder().encode(modelId).byteLength > 256 ||
        /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(modelId))
    )
      throw new Error("short_drama_model_context_invalid");
    this.#modelId = modelId;
  }
  setReady(ready: boolean) {
    if (this.#disposed || ready === this.#ready) return;
    this.#ready = ready;
    this.#invalidate();
    this.#publish({
      phase: ready ? "loading" : "waiting",
      reading: false,
      writing: false,
    });
    if (ready && this.#project) void this.refresh();
  }
  setProject(project: ProjectDetails | null) {
    if (this.#disposed) return;
    const changed =
      project?.project.projectId !== this.#project?.project.projectId;
    this.#project = project;
    if (!changed) return;
    this.#invalidate();
    this.#selectedPlanId = null;
    this.#publish({
      projectId: project?.project.projectId ?? null,
      phase: "waiting",
      plans: [],
      view: null,
      nextPlanId: null,
      reading: false,
      writing: false,
      error: null,
      notice: null,
    });
    if (this.#ready && project) void this.refresh();
  }
  refreshWriteActivity() {
    this.#publish({});
  }
  #current(projectId: string, epoch: number, operation: AbortController) {
    return (
      this.#ready &&
      !this.#disposed &&
      !operation.signal.aborted &&
      this.#epoch === epoch &&
      this.#project?.project.projectId === projectId
    );
  }
  #rememberSummary(
    records: Map<string, PublicProjectTextPlanSummary>,
    summary: PublicProjectTextPlanSummary,
  ) {
    const prior = this.#snapshot.plans.find((p) => p.planId === summary.planId);
    const recorded = records.get(summary.planId);
    const newest = [
      prior,
      recorded,
      summary,
    ].reduce<PublicProjectTextPlanSummary>(
      (head, candidate) =>
        candidate && candidate.revision > head.revision ? candidate : head,
      summary,
    );
    records.set(summary.planId, newest);
  }
  #readView(
    found: PublicProjectTextPlanView | null,
    records: Map<string, PublicProjectTextPlanSummary>,
  ): PublicProjectTextPlanView | null {
    if (found === null) return null;
    this.#rememberSummary(records, found.plan);
    const current = this.#snapshot.view;
    const newest =
      current?.plan.planId === found.plan.planId &&
      current.plan.revision > found.plan.revision
        ? current
        : found;
    return newest.plan.revision >= records.get(found.plan.planId)!.revision
      ? newest
      : null;
  }
  async refresh({ more = false }: { more?: boolean } = {}) {
    if (
      !this.#ready ||
      this.#disposed ||
      !this.#project ||
      this.#snapshot.writing
    )
      return;
    const projectId = this.#project.project.projectId,
      epoch = this.#epoch;
    this.#read?.abort();
    const operation = new AbortController();
    this.#read = operation;
    const selected = this.#selectedPlanId;
    this.#publish({ reading: true, error: null });
    try {
      const page = await this.#client.list(
        {
          projectId,
          afterPlanId: more ? this.#snapshot.nextPlanId : null,
          limit: 8,
        },
        { signal: operation.signal },
      );
      if (!this.#current(projectId, epoch, operation)) return;
      if (page.plans.some((p) => p.projectId !== projectId))
        throw new Error("project_text_plan_scope_invalid");
      const records = new Map(
        (more ? this.#snapshot.plans : []).map((p) => [p.planId, p]),
      );
      for (const p of page.plans) this.#rememberSummary(records, p);
      let currentView = this.#snapshot.view;
      if (selected !== null) {
        const found = await this.#client.get(
          { projectId, planId: selected },
          { signal: operation.signal },
        );
        if (!this.#current(projectId, epoch, operation)) return;
        if (
          found.view !== null &&
          (found.view.plan.projectId !== projectId ||
            found.view.plan.planId !== selected)
        )
          throw new Error("project_text_plan_scope_invalid");
        currentView = this.#readView(found.view, records);
      }
      this.#publish({
        phase: "ready",
        plans: [...records.values()],
        nextPlanId: page.nextPlanId,
        view: currentView,
        ...(selected && currentView === null
          ? { notice: "计划详情尚未读到最新版本，请刷新。" }
          : {}),
      });
    } catch {
      if (this.#current(projectId, epoch, operation))
        this.#publish({
          phase: "unavailable",
          error: "执行计划暂时无法读取，请重新连接。",
        });
    } finally {
      if (this.#read === operation) {
        this.#read = null;
        this.#publish({ reading: false });
      }
    }
  }
  async open(planId: string) {
    if (
      !this.#ready ||
      this.#disposed ||
      !this.#project ||
      this.#snapshot.writing
    )
      return;
    const projectId = this.#project.project.projectId,
      epoch = this.#epoch;
    this.#read?.abort();
    const operation = new AbortController();
    this.#read = operation;
    this.#publish({ reading: true, error: null });
    try {
      const found = await this.#client.get(
        { projectId, planId },
        { signal: operation.signal },
      );
      if (!this.#current(projectId, epoch, operation)) return;
      if (
        found.view !== null &&
        (found.view.plan.projectId !== projectId ||
          found.view.plan.planId !== planId)
      )
        throw new Error("project_text_plan_scope_invalid");
      const records = new Map(this.#snapshot.plans.map((p) => [p.planId, p]));
      const currentView = this.#readView(found.view, records);
      this.#selectedPlanId = planId;
      this.#publish({
        view: currentView,
        plans: [...records.values()],
        phase: "ready",
        notice:
          found.view === null
            ? "该计划已不可读取，请刷新列表。"
            : currentView === null
              ? "计划详情尚未读到最新版本，请刷新。"
              : null,
      });
    } catch {
      if (this.#current(projectId, epoch, operation))
        this.#publish({ error: "计划详情读取失败，请重试读取。" });
    } finally {
      if (this.#read === operation) {
        this.#read = null;
        this.#publish({ reading: false });
      }
    }
  }
  async start(
    binding: PublicProjectConversationBinding,
    definition: Omit<ProjectTextPlanDefinitionInput, "expectedBriefRevision">,
  ) {
    if (
      !this.canWrite ||
      !this.#project ||
      binding.projectId !== this.#project.project.projectId ||
      binding.state !== "active"
    )
      return;
    if (
      this.#snapshot.plans.some(
        (p) =>
          p.threadId === binding.threadId &&
          p.state !== "completed" &&
          p.state !== "revoked",
      )
    ) {
      this.#publish({
        error: "这个对话已有未结束的计划，请先打开并继续或停止它。",
      });
      return;
    }
    const input: ProjectTextPlansRequests["start"] = {
      ...definition,
      ...(!Object.hasOwn(definition, "modelId") && this.#modelId !== null
        ? { modelId: this.#modelId }
        : {}),
      projectId: binding.projectId,
      threadId: binding.threadId,
      expectedBindingRevision: binding.revision,
      expectedBriefRevision: this.#project.brief.briefRevision,
      idempotencyKey: crypto.randomUUID(),
    };
    await this.#begin({ method: "start", input });
  }
  async control(method: "pause" | "resume" | "revoke" | "continue") {
    if (!this.canWrite || !this.#snapshot.view) return;
    const plan = this.#snapshot.view.plan;
    await this.#begin({
      method,
      input: {
        projectId: plan.projectId,
        planId: plan.planId,
        expectedRevision: plan.revision,
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }
  async reviseRemaining(
    definition: Omit<ProjectTextPlanDefinitionInput, "expectedBriefRevision">,
  ) {
    if (!this.canWrite || !this.#project || !this.#snapshot.view) return;
    const plan = this.#snapshot.view.plan;
    await this.#begin({
      method: "reviseRemaining",
      input: {
        ...definition,
        projectId: plan.projectId,
        planId: plan.planId,
        expectedRevision: plan.revision,
        expectedBriefRevision: this.#project.brief.briefRevision,
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }
  async #begin(intent: Intent) {
    let captured: Intent;
    try {
      const request = projectTextPlansCodec.parseRequest({
        action: PROJECT_TEXT_PLANS_METHOD_ACTIONS[intent.method],
        input: intent.input,
      });
      captured = Object.freeze({
        method: intent.method,
        input: request.input,
      }) as Intent;
    } catch {
      this.#publish({ error: "请检查创作要求、阶段和分集范围。" });
      return;
    }
    this.#publish({ pending: captured });
    await this.#mutate(captured);
  }
  async retryOriginal() {
    const intent = this.#snapshot.pending;
    if (
      !intent ||
      !this.#ready ||
      this.#snapshot.writing ||
      this.#physicalWritesPending() ||
      intent.input.projectId !== this.#project?.project.projectId
    )
      return;
    await this.#mutate(intent);
  }
  async #mutate(intent: Intent) {
    this.#read?.abort();
    this.#read = null;
    const operation = new AbortController(),
      epoch = this.#epoch;
    this.#write = operation;
    this.#publish({ writing: true, reading: false, error: null, notice: null });
    try {
      const call = this.#client[intent.method] as (
        input: Intent["input"],
        options: { signal: AbortSignal },
      ) => Promise<ProjectTextPlanMutationResponse>;
      const result = await call(intent.input, { signal: operation.signal });
      if (!this.#current(intent.input.projectId, epoch, operation)) return;
      if (
        result.view.plan.projectId !== intent.input.projectId ||
        ("planId" in intent.input &&
          result.view.plan.planId !== intent.input.planId)
      )
        throw new Error("project_text_plan_scope_invalid");
      const records = new Map(this.#snapshot.plans.map((p) => [p.planId, p]));
      const currentView = this.#readView(result.view, records);
      this.#selectedPlanId = result.view.plan.planId;
      this.#publish({
        pending: null,
        writing: false,
        phase: "ready",
        view: currentView,
        plans: [...records.values()],
        notice:
          intent.method === "revoke"
            ? "计划已停止，已开始任务的成果仍会保留。"
            : "计划操作已保存，可刷新查看最新进度。",
      });
    } catch (error) {
      if (!this.#current(intent.input.projectId, epoch, operation)) return;
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : error instanceof Error
            ? error.message
            : "";
      const conflict =
        typeof code === "string" &&
        [
          "project_text_plan_conflict",
          "project_text_plan_revision_conflict",
          "project_text_plan_active_conflict",
          "project_conversation_binding_conflict",
          "project_conversation_revision_conflict",
          "project_text_plan_source_changed",
          "project_text_plan_remaining_scope_invalid",
          "project_text_plan_selection_changed",
          "project_text_plan_binding_changed",
          "project_text_plan_resume_scope_changed",
          "project_text_plan_configuration_changed",
          "project_text_plan_step_unavailable",
          "project_text_plan_run_still_active",
          "project_text_plan_selection_required",
          "project_text_plan_transition_invalid",
          "project_text_plan_outline_required",
          "project_text_plan_execution_unavailable",
        ].includes(code);
      this.#publish({
        writing: false,
        ...(conflict ? { pending: null } : {}),
        error: conflict
          ? "计划或来源已变化，请刷新后重新确认。"
          : "操作结果尚未确认。重试只会发送原计划、原输入和原请求。",
      });
    } finally {
      if (this.#write === operation) this.#write = null;
    }
  }
  dispose() {
    if (this.#disposed) return;
    this.#invalidate();
    this.#disposed = true;
    this.#listeners.clear();
  }
}
