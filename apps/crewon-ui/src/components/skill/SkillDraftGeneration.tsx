import { useEffect, useRef, useState } from "react";
import type {
  DemonstratedSkillClient,
  SkillExecutionTarget,
  SkillGenerationAttempt,
  SkillGenerationAttemptStore,
  SkillGenerationView,
} from "../../lib/skill/demonstratedSkillClient";
import { SkillMethodSummary } from "./SkillMethodSummary";
import { skillClientKey, useSkillOperationScope } from "./skillClientScope";

type Props = {
  skillId: string;
  expectedSkillRevision: number;
  draftDirty: boolean;
  disabled: boolean;
  client: DemonstratedSkillClient;
  executionTarget: SkillExecutionTarget | null;
  prepareExecutionTarget?: (
    generationId: string,
  ) => Promise<SkillExecutionTarget>;
  attemptStore?: SkillGenerationAttemptStore;
  onApplied: () => Promise<void>;
  onApplyingChange?: (applying: boolean) => void;
  onOpenRun?: (runId: string) => void;
};
const pendingStatuses = new Set(["pending", "queued", "running"]);
function generationError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code.includes("revision")) return "草稿已更新，请基于新草稿重新生成。";
  if (code.includes("not_completed"))
    return "模型尚未完成整理，请稍后更新状态。";
  if (code.includes("invalid")) return "模型输出未通过结构校验，可以重新生成。";
  return "模型整理请求未完成，请更新状态或重试原请求。";
}

export function SkillDraftGeneration(props: Props) {
  return (
    <SkillDraftGenerationContent
      key={`${skillClientKey(props.client)}:${props.skillId}`}
      {...props}
    />
  );
}

function SkillDraftGenerationContent({
  skillId,
  expectedSkillRevision,
  draftDirty,
  disabled,
  client,
  executionTarget,
  prepareExecutionTarget,
  attemptStore,
  onApplied,
  onApplyingChange,
  onOpenRun,
}: Props) {
  const captureScope = useSkillOperationScope(client);
  const attempt = useRef<SkillGenerationAttempt | null>(
    attemptStore?.get() ?? null,
  );
  const [retry, setRetry] = useState(!!attempt.current);
  const [generation, setGeneration] = useState<SkillGenerationView | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const busyRef = useRef(false);
  const reads = useRef(0);

  function accept(next: SkillGenerationView) {
    if (next.skillId !== skillId)
      throw new Error("skill_generation_identity_invalid");
    setGeneration(next);
    if (next.runId && next.generationId === attempt.current?.generationId) {
      attempt.current = null;
      attemptStore?.set(null);
      setRetry(false);
    }
  }

  useEffect(() => {
    const isCurrent = captureScope();
    const sequence = ++reads.current;
    void client
      .listGenerations(skillId)
      .then((items) => {
        if (!isCurrent() || reads.current !== sequence) return;
        const pending = attempt.current;
        const selected = pending
          ? items.find((item) => item.generationId === pending.generationId)
          : [...items].sort((a, b) =>
              b.createdAt.localeCompare(a.createdAt),
            )[0];
        if (selected) accept(selected);
      })
      .catch((failure: unknown) => {
        if (isCurrent() && reads.current === sequence)
          setError(generationError(failure));
      })
      .finally(() => {
        if (isCurrent() && reads.current === sequence) setLoading(false);
      });
    return () => {
      reads.current += 1;
    };
  }, [client, skillId]);

  async function update() {
    const isCurrent = captureScope();
    if (!generation || !isCurrent()) return;
    const id = generation.generationId;
    const sequence = ++reads.current;
    let next = await client.readGeneration(skillId, id);
    if (next.generationId !== id)
      throw new Error("skill_generation_identity_invalid");
    if (!isCurrent() || sequence !== reads.current) return;
    accept(next);
    if (next.status === "completed" && next.outcome === "pending") {
      next = await client.collectGeneration(skillId, id);
      if (isCurrent() && sequence === reads.current) accept(next);
    }
  }

  async function operate(action: () => Promise<void>) {
    const isCurrent = captureScope();
    if (busyRef.current || !isCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      if (isCurrent()) {
        setError(generationError(failure));
        if (
          failure instanceof Error &&
          failure.message === "skill_revision_conflict"
        )
          setRevisionConflict(true);
      }
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const generating = !!generation && pendingStatuses.has(generation.status);
  const needsCollect =
    generation?.status === "completed" && generation.outcome === "pending";
  useEffect(() => {
    if (!generating && !needsCollect) return;
    const interval = window.setInterval(() => {
      if (!busyRef.current) void operate(update);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [
    generation?.generationId,
    generation?.status,
    generation?.outcome,
    client,
  ]);

  async function begin() {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const pending = attempt.current ?? {
      generationId: crypto.randomUUID(),
      expectedSkillRevision,
      command: null,
    };
    attempt.current = pending;
    attemptStore?.set(pending);
    setRetry(true);
    await operate(async () => {
      if (!pending.command) {
        const target = prepareExecutionTarget
          ? await prepareExecutionTarget(pending.generationId)
          : executionTarget;
        if (!isCurrent()) return;
        if (!target) throw new Error("skill_execution_target_required");
        pending.command = {
          ...target,
          generationId: pending.generationId,
          expectedSkillRevision: pending.expectedSkillRevision,
        };
      }
      if (!isCurrent()) return;
      const next = await client.startGeneration(skillId, pending.command);
      if (isCurrent()) accept(next);
    });
  }

  const stale =
    !!generation &&
    generation.expectedSkillRevision !== expectedSkillRevision &&
    generation.appliedRevision === null;
  const candidate =
    generation?.outcome === "candidate" ? generation.candidate : null;
  const canApply =
    !!candidate &&
    !!generation?.runId &&
    generation.verification === "real" &&
    !stale &&
    !draftDirty &&
    !disabled &&
    !busy &&
    generation.appliedRevision === null;
  return (
    <section
      className="demonstrated-skill-generation"
      aria-label="模型整理草稿"
      aria-busy={busy || loading}
    >
      <h3>模型整理草稿</h3>
      <p className="demonstrated-skill-note">
        导入内容是预处理草稿。让模型根据示教整理方法，审阅候选后再采用。
      </p>
      {draftDirty ? (
        <p className="demonstrated-skill-note">
          先保存当前草稿修改，再生成或采用候选。
        </p>
      ) : null}
      {stale ? (
        <p className="demonstrated-skill-note">
          草稿已更新，请基于新草稿重新生成。
        </p>
      ) : null}
      <div className="demonstrated-skill-actions">
        <button
          className="button compact"
          type="button"
          disabled={
            busy ||
            loading ||
            disabled ||
            (!retry && (draftDirty || generating)) ||
            (!executionTarget && !prepareExecutionTarget)
          }
          onClick={() => void begin()}
        >
          {retry
            ? "重试原生成请求"
            : generation
              ? "重新生成草稿"
              : "让模型整理草稿"}
        </button>
        {generation ? (
          <button
            className="button compact"
            type="button"
            disabled={busy}
            onClick={() => void operate(update)}
          >
            更新生成状态
          </button>
        ) : null}
      </div>
      {retry ? (
        <p className="demonstrated-skill-note">
          生成请求状态待确认，重试会保留原任务和草稿版本。
        </p>
      ) : null}
      {generation ? (
        <>
          <p role="status">
            {generation.appliedRevision !== null
              ? "候选已采用，仍需保存版本并试跑"
              : generating
                ? "模型正在整理"
                : generation.outcome === "invalid"
                  ? "模型输出未通过结构校验，可以重新生成。"
                  : candidate
                    ? "候选草稿待审阅"
                    : generation.status === "failed"
                      ? "模型整理失败，可以重新生成。"
                      : generation.status === "cancelled"
                        ? "模型整理已取消"
                        : "模型运行已结束，等待读取结果"}
          </p>
          <p className="demonstrated-skill-note">
            {generation.verification === "real"
              ? "真实模型运行"
              : `${generation.verification === "simulated" ? "模拟输出" : "真实性待验证"}，不能作为真实模型整理结果采用。`}
          </p>
          {generation.runId && onOpenRun ? (
            <button
              className="button compact"
              type="button"
              onClick={() => onOpenRun(generation.runId!)}
            >
              查看模型运行
            </button>
          ) : null}
          {candidate ? (
            <>
              <details className="demonstrated-skill-version-method" open>
                <summary>候选方法预览</summary>
                <SkillMethodSummary method={candidate} />
              </details>
              {generation.appliedRevision === null ? (
                <button
                  className="button primary compact"
                  type="button"
                  disabled={!canApply}
                  onClick={() =>
                    void operate(async () => {
                      const isCurrent = captureScope();
                      if (!isCurrent()) return;
                      onApplyingChange?.(true);
                      try {
                        const next = await client.applyGeneration(
                          skillId,
                          generation.generationId,
                          generation.expectedSkillRevision,
                        );
                        if (!isCurrent()) return;
                        accept(next);
                        await onApplied();
                      } finally {
                        if (isCurrent()) onApplyingChange?.(false);
                      }
                    })
                  }
                >
                  采用候选草稿
                </button>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {retry && revisionConflict ? (
        <button
          className="button compact"
          type="button"
          disabled={busy || disabled || draftDirty}
          onClick={() => {
            attempt.current = null;
            attemptStore?.set(null);
            setRetry(false);
            setRevisionConflict(false);
            void begin();
          }}
        >
          按当前草稿重新生成
        </button>
      ) : null}
      {error ? (
        <p className="catalog-resource-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
