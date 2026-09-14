import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SkillInvocationSpec } from "@crewon/domain/demonstrated-skill";
import {
  createDemonstratedSkillClient,
  type DemonstratedSkillView,
  type SkillExecutionTarget,
  type SkillExecutionAttempt,
  type SkillGenerationAttempt,
} from "../../lib/skill/demonstratedSkillClient";
import { DemonstratedSkillPanel } from "./DemonstratedSkillPanel";
import type { SkillLibraryOpenRequest } from "./useRecordingSkillImport";
import "./demonstrated-skill.css";

/** Narrow Control port; all identities and revisions originate at the host. */
export interface SkillLibraryControlClient {
  requestSkill(path: string, init?: RequestInit): Promise<Response>;
  createThread(
    body: { title: string | null },
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
  openRequest?: SkillLibraryOpenRequest | null;
  onOpenRequestHandled?: (requestId: string) => void;
  onSelectThread?: (threadId: string) => void;
  scheduleNotice?: ReactNode;
  onAddToSchedule?: (draft: {
    title: string;
    invocation: SkillInvocationSpec;
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

export function SkillLibraryHost({
  controlClient,
  query = "",
  openRequest = null,
  onOpenRequestHandled,
  onSelectThread,
  scheduleNotice,
  onAddToSchedule,
}: SkillLibraryHostProps) {
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
  const active = useRef(true);
  const sequence = useRef(0);
  const selectionSequence = useRef(0);
  const [openingImported, setOpeningImported] = useState(false);
  const [importOpenError, setImportOpenError] = useState(false);
  const handledRef = useRef(onOpenRequestHandled);
  handledRef.current = onOpenRequestHandled;

  async function load(after?: string) {
    const current = ++sequence.current;
    setBusy(true);
    setError(null);
    try {
      const page = await client.list({
        ...(after ? { after } : {}),
        limit: 50,
      });
      if (!active.current || current !== sequence.current) return;
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
      if (active.current && current === sequence.current)
        setError("暂时无法读取示教 Skill，请刷新重试。");
    } finally {
      if (active.current && current === sequence.current) setBusy(false);
    }
  }

  useEffect(() => {
    active.current = true;
    setSelected(null);
    void load();
    return () => {
      active.current = false;
      sequence.current += 1;
      selectionSequence.current += 1;
    };
  }, [client]);

  async function openImportedSkill() {
    if (!openRequest) return;
    const current = ++selectionSequence.current;
    setOpeningImported(true);
    setImportOpenError(false);
    try {
      const detail = await client.read(openRequest.skillId);
      if (!active.current || current !== selectionSequence.current) return;
      if (detail.skill.skillId !== openRequest.skillId || detail.skill.deleted)
        throw new Error("skill_import_selection_invalid");
      setSelected(detail.skill);
      handledRef.current?.(openRequest.requestId);
    } catch {
      if (active.current && current === selectionSequence.current)
        setImportOpenError(true);
    } finally {
      if (active.current && current === selectionSequence.current)
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
    if (!selected) throw new Error("skill_selection_required");
    const created = await controlClient.createThread(
      { title: `Skill · ${selected.draft.name}` },
      `skill-thread:${executionId}`,
    );
    const { thread } = await controlClient.getThread(created.thread.threadId);
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

  async function openRun(runId: string) {
    setError(null);
    try {
      const { run } = await controlClient.getRun(runId);
      if (run.runId !== runId || !run.threadId)
        throw new Error("skill_run_identity_invalid");
      if (active.current) onSelectThread?.(run.threadId);
    } catch {
      if (active.current) setError("暂时无法打开运行结果，请重试。");
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
          <DemonstratedSkillPanel
            key={selected.skillId}
            skillId={selected.skillId}
            client={client}
            executionTarget={null}
            executionAttemptStore={{
              get: () => attempts.get(selected.skillId) ?? null,
              set: (attempt) => {
                if (attempt) attempts.set(selected.skillId, attempt);
                else attempts.delete(selected.skillId);
              },
            }}
            prepareExecutionTarget={prepareExecutionTarget}
            generationAttemptStore={{
              get: () => generations.get(selected.skillId) ?? null,
              set: (attempt) => {
                if (attempt) generations.set(selected.skillId, attempt);
                else generations.delete(selected.skillId);
              },
            }}
            onAddToSchedule={onAddToSchedule}
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
