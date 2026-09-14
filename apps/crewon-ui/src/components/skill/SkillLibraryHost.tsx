import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SkillInvocationSpec } from "@crewon/domain/demonstrated-skill";
import { parseDeliveryTargetRef } from "@crewon/domain/delivery";
import type { DeliveryControlClient } from "@crewon/control-client";
import {
  createDemonstratedSkillClient,
  type DemonstratedSkillView,
  type SkillExecutionTarget,
  type SkillExecutionAttempt,
  type SkillGenerationAttempt,
  type SkillExecutionPreparation,
} from "../../lib/skill/demonstratedSkillClient";
import { DemonstratedSkillPanel } from "./DemonstratedSkillPanel";
import type { SkillLibraryOpenRequest } from "./useRecordingSkillImport";
import { skillClientKey, useSkillOperationScope } from "./skillClientScope";
import "./demonstrated-skill.css";

/** Narrow Control port; all identities and revisions originate at the host. */
export interface SkillLibraryControlClient {
  delivery?: Pick<DeliveryControlClient, "catalog">;
  requestSkill(path: string, init?: RequestInit): Promise<Response>;
  createThread(
    body: { title: string | null; workspaceId?: string | null },
    idempotencyKey: string,
  ): Promise<{ thread: { threadId: string; revision: number } }>;
  getThread(threadId: string): Promise<{
    thread: { threadId: string; revision: number; status: string };
  }>;
  getRun(runId: string): Promise<{ run: { runId: string; threadId: string } }>;
}

export type SkillLibraryHostProps = {
  controlClient: SkillLibraryControlClient;
  query?: string;
  selectedThreadId?: string | null;
  workspaceId?: string | null;
  selectedThreadTitle?: string;
  openRequest?: SkillLibraryOpenRequest | null;
  onOpenRequestHandled?: (requestId: string) => void;
  onSelectThread?: (threadId: string) => void;
  scheduleNotice?: ReactNode;
  onAddToSchedule?: (draft: {
    title: string;
    invocation: SkillInvocationSpec;
    threadId?: string | null;
  }) => void;
};

// Retain an uncertain command when the user returns to the library. The weak
// key keeps this memory scoped to the authenticated Control client lifetime.
const pendingExecutions = new WeakMap<
  SkillLibraryControlClient,
  Map<string, SkillExecutionAttempt>
>();
const pendingGenerations = new WeakMap<
  SkillLibraryControlClient,
  Map<string, SkillGenerationAttempt>
>();

export function SkillLibraryHost(props: SkillLibraryHostProps) {
  return (
    <SkillLibraryContent key={`${skillClientKey(props.controlClient)}:${props.workspaceId ?? "unbound"}`} {...props} />
  );
}

function SkillLibraryContent({
  controlClient,
  query = "",
  selectedThreadId = null,
  workspaceId,
  selectedThreadTitle,
  openRequest = null,
  onOpenRequestHandled,
  onSelectThread,
  scheduleNotice,
  onAddToSchedule,
}: SkillLibraryHostProps) {
  const captureScope = useSkillOperationScope(controlClient);
  const client = useMemo(
    () =>
      createDemonstratedSkillClient((path, init) =>
        controlClient.requestSkill(path, init),
      ),
    [controlClient],
  );
  const attempts = useMemo(() => {
    const existing = pendingExecutions.get(controlClient);
    if (existing) return existing;
    const created = new Map<string, SkillExecutionAttempt>();
    pendingExecutions.set(controlClient, created);
    return created;
  }, [controlClient]);
  const generations = useMemo(() => {
    const existing = pendingGenerations.get(controlClient);
    if (existing) return existing;
    const created = new Map<string, SkillGenerationAttempt>();
    pendingGenerations.set(controlClient, created);
    return created;
  }, [controlClient]);
  const [skills, setSkills] = useState<readonly DemonstratedSkillView[]>([]);
  const [selected, setSelected] = useState<DemonstratedSkillView | null>(null);
  const [busy, setBusy] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const selectionSequence = useRef(0);
  const [openingImported, setOpeningImported] = useState(false);
  const [importOpenError, setImportOpenError] = useState(false);
  const [destination, setDestination] = useState<"current" | "new">("current");
  const executionThreadId = destination === "current" ? selectedThreadId : null;
  const handledRef = useRef(onOpenRequestHandled);
  handledRef.current = onOpenRequestHandled;

  async function load(after?: string) {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const current = ++sequence.current;
    setBusy(true);
    setError(null);
    try {
      const page = await client.list({
        ...(after ? { after } : {}),
        limit: 50,
      });
      if (!isCurrent() || current !== sequence.current) return;
      setSkills((previous) =>
        after
          ? [
              ...previous,
              ...page.filter(
                (item) =>
                  !previous.some(
                    (existing) => existing.skillId === item.skillId,
                  ),
              ),
            ]
          : page,
      );
      setHasMore(page.length === 50);
    } catch {
      if (isCurrent() && current === sequence.current)
        setError("暂时无法读取示教 Skill，请刷新重试。");
    } finally {
      if (isCurrent() && current === sequence.current) setBusy(false);
    }
  }

  useEffect(() => {
    setSelected(null);
    void load();
    return () => {
      sequence.current += 1;
      selectionSequence.current += 1;
    };
  }, [client]);

  async function openImportedSkill() {
    const isCurrent = captureScope();
    if (!openRequest || !isCurrent()) return;
    const current = ++selectionSequence.current;
    setOpeningImported(true);
    setImportOpenError(false);
    try {
      const detail = await client.read(openRequest.skillId);
      if (!isCurrent() || current !== selectionSequence.current) return;
      if (detail.skill.skillId !== openRequest.skillId || detail.skill.deleted)
        throw new Error("skill_import_selection_invalid");
      setSelected(detail.skill);
      handledRef.current?.(openRequest.requestId);
    } catch {
      if (isCurrent() && current === selectionSequence.current)
        setImportOpenError(true);
    } finally {
      if (isCurrent() && current === selectionSequence.current)
        setOpeningImported(false);
    }
  }
  useEffect(() => {
    if (openRequest) void openImportedSkill();
    return () => {
      selectionSequence.current += 1;
    };
  }, [client, openRequest?.requestId, openRequest?.skillId]);

  async function prepareExecutionTarget(
    executionId: string,
  ): Promise<SkillExecutionTarget> {
    const isCurrent = captureScope();
    if (!isCurrent()) throw new Error("skill_client_scope_changed");
    if (!selected) throw new Error("skill_selection_required");
    const created = await controlClient.createThread(
      { title: `Skill · ${selected.draft.name}`, ...(workspaceId === undefined ? {} : { workspaceId }) },
      `skill-thread:${executionId}`,
    );
    if (!isCurrent()) throw new Error("skill_client_scope_changed");
    const { thread } = await controlClient.getThread(created.thread.threadId);
    if (!isCurrent()) throw new Error("skill_client_scope_changed");
    if (
      thread.threadId !== created.thread.threadId ||
      !thread.threadId ||
      thread.status !== "active" ||
      !Number.isSafeInteger(thread.revision) ||
      thread.revision < 0
    ) {
      throw new Error("skill_execution_thread_invalid");
    }
    return {
      threadId: thread.threadId,
      expectedThreadRevision: thread.revision,
      agentVersionId: null,
    };
  }

  async function prepareExecution(input: {
    executionId: string;
    selectedThreadId: string | null;
    invocation: SkillInvocationSpec;
  }): Promise<SkillExecutionPreparation> {
    const isCurrent = captureScope();
    if (!isCurrent()) throw new Error("skill_client_scope_changed");
    let target: SkillExecutionTarget;
    const requestedThreadId =
      input.invocation.deliveryTarget?.threadId ?? input.selectedThreadId;
    if (requestedThreadId) {
      const { thread } = await controlClient.getThread(requestedThreadId);
      if (!isCurrent()) throw new Error("skill_client_scope_changed");
      if (
        thread.threadId !== requestedThreadId ||
        thread.status !== "active" ||
        !Number.isSafeInteger(thread.revision) ||
        thread.revision < 0
      )
        throw new Error("skill_execution_thread_invalid");
      target = {
        threadId: thread.threadId,
        expectedThreadRevision: thread.revision,
        agentVersionId: null,
      };
    } else target = await prepareExecutionTarget(input.executionId);
    if (!isCurrent()) throw new Error("skill_client_scope_changed");
    const usesDelivery =
      input.invocation.requiredToolRefs.some((ref) =>
        ref.startsWith("delivery_"),
      ) || !!input.invocation.deliveryTarget;
    if (!usesDelivery) return { target };
    if (!controlClient.delivery) throw new Error("skill_delivery_unavailable");
    const catalog = await controlClient.delivery.catalog(target.threadId);
    if (!isCurrent()) throw new Error("skill_client_scope_changed");
    const deliveryTarget = parseDeliveryTargetRef(catalog.target);
    if (
      deliveryTarget.threadId !== target.threadId ||
      (input.invocation.deliveryTarget &&
        (deliveryTarget.tenantId !== input.invocation.deliveryTarget.tenantId ||
          deliveryTarget.spaceId !== input.invocation.deliveryTarget.spaceId))
    )
      throw new Error("skill_delivery_target_mismatch");
    return { target, deliveryTarget };
  }

  async function openRun(runId: string) {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    setError(null);
    try {
      const { run } = await controlClient.getRun(runId);
      if (!isCurrent()) return;
      if (run.runId !== runId || !run.threadId)
        throw new Error("skill_run_identity_invalid");
      onSelectThread?.(run.threadId);
    } catch {
      if (isCurrent()) setError("暂时无法打开运行结果，请重试。");
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = skills.filter(
    (skill) =>
      !skill.deleted &&
      `${skill.draft.name} ${skill.draft.purpose}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
  );
  return (
    <section className="demonstrated-skill-library" aria-label="我的示教 Skill">
      {openingImported ? <p role="status">正在打开导入的 Skill…</p> : null}
      {importOpenError ? (
        <div role="alert">
          <p>录制已导入，暂时无法打开草稿，请重试。</p>
          <button
            className="button compact"
            type="button"
            onClick={() => void openImportedSkill()}
          >
            重试打开导入的 Skill
          </button>
        </div>
      ) : null}
      {selected ? (
        <>
          <div className="demonstrated-skill-actions">
            <button
              className="button compact"
              type="button"
              onClick={() => {
                selectionSequence.current += 1;
                setSelected(null);
                void load();
              }}
            >
              返回示教 Skill 列表
            </button>
          </div>
          <section className="demonstrated-skill-method" aria-label="执行任务">
            <label className="form-field">
              <span>执行任务</span>
              <select
                aria-label="执行任务"
                value={selectedThreadId ? destination : "new"}
                onChange={(event) =>
                  setDestination(event.target.value as "current" | "new")
                }
              >
                {selectedThreadId ? (
                  <option value="current">
                    当前任务 · {selectedThreadTitle || selectedThreadId}
                  </option>
                ) : null}
                <option value="new">新建任务</option>
              </select>
            </label>
            <p className="demonstrated-skill-note">
              {executionThreadId
                ? "试跑和调用使用此任务已有的文件，交付结果也保存在此任务。需要模板或数据时，请先打开任务，在文件交付中上传。"
                : "试跑和调用会新建空任务。需要已有模板或数据时，请先在左侧打开任务并上传文件，再选择当前任务。"}
              模型整理草稿使用独立任务。
            </p>
            {executionThreadId && onSelectThread ? (
              <button
                className="button compact"
                type="button"
                onClick={() => onSelectThread(executionThreadId)}
              >
                打开执行任务
              </button>
            ) : null}
          </section>
          <DemonstratedSkillPanel
            key={selected.skillId}
            skillId={selected.skillId}
            client={client}
            executionTarget={null}
            executionAttemptStore={{
              get: () => attempts.get(`${workspaceId ?? "unbound"}:${selected.skillId}`) ?? null,
              set: (attempt) => {
                if (attempt) attempts.set(`${workspaceId ?? "unbound"}:${selected.skillId}`, attempt);
                else attempts.delete(`${workspaceId ?? "unbound"}:${selected.skillId}`);
              },
            }}
            prepareExecutionTarget={prepareExecutionTarget}
            prepareExecution={prepareExecution}
            selectedThreadId={executionThreadId}
            generationAttemptStore={{
              get: () => generations.get(`${workspaceId ?? "unbound"}:${selected.skillId}`) ?? null,
              set: (attempt) => {
                if (attempt) generations.set(`${workspaceId ?? "unbound"}:${selected.skillId}`, attempt);
                else generations.delete(`${workspaceId ?? "unbound"}:${selected.skillId}`);
              },
            }}
            onAddToSchedule={
              onAddToSchedule
                ? (draft) =>
                    onAddToSchedule({ ...draft, threadId: executionThreadId })
                : undefined
            }
            onOpenRun={onSelectThread ? (id) => void openRun(id) : undefined}
          />
        </>
      ) : (
        <>
          <header className="demonstrated-skill-heading">
            <div>
              <h2>我的示教 Skill</h2>
              <p className="demonstrated-skill-note">
                从操作示教中整理方法，用新材料试跑，核对后启用。
              </p>
            </div>
            <button
              className="button compact"
              type="button"
              disabled={busy}
              onClick={() => void load()}
            >
              {busy ? "正在读取…" : "刷新示教 Skill"}
            </button>
          </header>
          {visible.length ? (
            <div className="demonstrated-skill-library-grid">
              {visible.map((skill) => (
                <button
                  className="demonstrated-skill-library-card"
                  type="button"
                  key={skill.skillId}
                  aria-label={`打开示教 Skill：${skill.draft.name}`}
                  onClick={() => {
                    selectionSequence.current += 1;
                    setOpeningImported(false);
                    setSelected(skill);
                  }}
                >
                  <strong>{skill.draft.name}</strong>
                  <span>{skill.draft.purpose}</span>
                  <small>
                    {skill.disabled
                      ? "已禁用"
                      : skill.activatedVersionIds.length
                        ? "已激活"
                        : "草稿 · 待试跑"}
                    {skill.source.provenance === "contract-fixture"
                      ? " · 契约样本"
                      : ""}
                  </small>
                </button>
              ))}
            </div>
          ) : !busy && !error ? (
            <p className="demonstrated-skill-note">
              {normalizedQuery
                ? "没有匹配的示教 Skill。"
                : "还没有示教 Skill。完成一次浏览器示教后，在这里审阅生成的方法。"}
            </p>
          ) : null}
          {hasMore ? (
            <button
              className="button compact"
              type="button"
              disabled={busy}
              onClick={() => void load(skills.at(-1)?.skillId)}
            >
              加载更多示教 Skill
            </button>
          ) : null}
        </>
      )}
      {error ? (
        <p className="catalog-resource-error" role="alert">
          {error}
        </p>
      ) : null}
      {scheduleNotice}
    </section>
  );
}
