import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ProjectDetails } from "./creative-project-controller";
import { ProjectTextPlanController } from "./ProjectTextPlanController";
import { ProjectConversationController } from "./ProjectConversationController";
import { ProjectTextController } from "./ProjectTextController";
import type {
  ProjectTextPlanDefinitionInput,
  PublicProjectTextPlanPauseReason,
  PublicProjectTextPlanStage,
  PublicProjectTextPlanStep,
} from "../project-text-plans-service";

const stages = ["brief", "outline", "script"] as const;
const labels = { brief: "创作需求", outline: "分集大纲", script: "分集剧本" };
const states = {
  ready: "等待执行",
  running: "正在执行",
  waitingSelection: "等待确认成果",
  paused: "已暂停",
  completed: "已完成",
  revoked: "已停止",
};
const reasons: Record<PublicProjectTextPlanPauseReason, string> = {
  source_changed: "上游内容已改变，请确认剩余计划。",
  selection_changed: "采用的版本已改变，请确认剩余计划。",
  locked: "相关成果已锁定。",
  binding_changed: "项目对话关联已改变。",
  installation_changed: "插件版本或配置已改变。",
  authorization_unavailable: "当前执行权限或服务尚未就绪。",
  run_failed: "当前任务失败，已有成果会保留。",
  run_canceled: "当前任务已取消。",
  result_missing: "任务结束，但未保存符合要求的项目成果。",
  result_invalid: "成果未通过本阶段检查。",
  user_paused: "你暂停了这个计划。",
};
type PlanFormField =
  | "threadId"
  | "instruction"
  | "start"
  | "target"
  | "episodeCount"
  | "scriptMode"
  | "selectedEpisodes"
  | "automatic";

/** All controls remain inside the plugin's existing content area. */
export function ProjectTextPlanActions({
  controller,
  conversations,
  texts,
  details,
  openText,
}: {
  controller: ProjectTextPlanController;
  conversations: ProjectConversationController;
  texts: ProjectTextController;
  details: ProjectDetails;
  openText(step: PublicProjectTextPlanStep): void;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const chats = useSyncExternalStore(
    conversations.subscribe,
    conversations.getSnapshot,
    conversations.getSnapshot,
  );
  const text = useSyncExternalStore(
    texts.subscribe,
    texts.getSnapshot,
    texts.getSnapshot,
  );
  const [threadId, setThreadId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [start, setStart] = useState<PublicProjectTextPlanStage>("outline");
  const [target, setTarget] = useState<PublicProjectTextPlanStage>("script");
  const [episodeCount, setEpisodeCount] = useState(3);
  const [scriptMode, setScriptMode] = useState<
    "selectedOutline" | "independentScripts"
  >("selectedOutline");
  const [selectedEpisodes, setSelectedEpisodes] = useState<readonly string[]>(
    [],
  );
  const [automatic, setAutomatic] = useState(false);
  const dirty = useRef(new Set<PlanFormField>());
  const formOwner = useRef<string | null>(null);
  const remainingSlots = snapshot.view?.steps
    .filter((step) => step.state !== "succeeded")
    .map((step) => [step.stepId, step.kind, step.episodeId]);
  const remainingKey = JSON.stringify(remainingSlots ?? []);
  useEffect(() => {
    dirty.current.clear();
    formOwner.current = null;
    setThreadId("");
    setInstruction("");
    setStart("outline");
    setTarget("script");
    setEpisodeCount(3);
    setScriptMode("selectedOutline");
    setSelectedEpisodes([]);
    setAutomatic(false);
  }, [details.project.projectId]);
  useEffect(() => {
    const view = snapshot.view;
    if (view === null || view.plan.projectId !== details.project.projectId)
      return;
    const owner = JSON.stringify([view.plan.projectId, view.plan.planId]);
    if (formOwner.current !== owner) {
      dirty.current.clear();
      formOwner.current = owner;
    }
    const remaining = view.steps.filter((step) => step.state !== "succeeded");
    const first = remaining[0];
    if (!dirty.current.has("threadId")) setThreadId(view.plan.threadId);
    if (!dirty.current.has("instruction"))
      setInstruction(view.definition.instruction);
    if (!dirty.current.has("start"))
      setStart(first?.kind ?? view.definition.start);
    if (!dirty.current.has("target")) setTarget(view.definition.target);
    if (!dirty.current.has("automatic"))
      setAutomatic(view.definition.adoption === "whenUnchanged");
    if (!dirty.current.has("episodeCount"))
      setEpisodeCount(view.definition.episodeIds.length || 1);
    if (!dirty.current.has("selectedEpisodes"))
      setSelectedEpisodes(
        remaining.filter((s) => s.kind === "script").map((s) => s.episodeId!),
      );
    if (!dirty.current.has("scriptMode"))
      setScriptMode(
        view.definition.episodeMode === "independentScripts"
          ? "independentScripts"
          : "selectedOutline",
      );
  }, [
    details.project.projectId,
    snapshot.view?.plan.planId,
    snapshot.view?.plan.currentPlanRevision,
    remainingKey,
  ]);
  const outline = text.outline?.selectedRevision;
  const episodeOptions =
    scriptMode === "selectedOutline"
      ? outline?.kind === "outline"
        ? outline.content.episodes.map((e) => ({
            id: e.episodeId,
            title: e.title,
          }))
        : []
      : text.artifacts
          .filter((a) => a.kind === "script")
          .map((a, i) => ({
            id: a.episodeId!,
            title: `已有分集剧本 ${i + 1}`,
          }));
  const episodes =
    target === "brief"
      ? null
      : start !== "script"
        ? { kind: "newOutline" as const, episodeCount }
        : {
            kind: scriptMode,
            episodeIds: selectedEpisodes.filter((id) =>
              episodeOptions.some((e) => e.id === id),
            ),
          };
  const definition: Omit<
    ProjectTextPlanDefinitionInput,
    "expectedBriefRevision"
  > = {
    instruction,
    start,
    target,
    episodes,
    adoption: automatic ? "whenUnchanged" : "manual",
  };
  const instructionValid =
    Boolean(instruction.trim()) &&
    new TextEncoder().encode(instruction).byteLength <= 4096;
  const definitionValid =
    instructionValid &&
    (episodes === null ||
      episodes.kind === "newOutline" ||
      episodes.episodeIds.length > 0);
  const binding = chats.bindings.find(
    (b) => b.threadId === threadId && b.state === "active",
  );
  const occupied = snapshot.plans.some(
    (p) =>
      p.threadId === binding?.threadId &&
      p.state !== "completed" &&
      p.state !== "revoked",
  );
  const plan = snapshot.view?.plan;
  const active = snapshot.view?.steps.find(
    (s) => s.stepId === plan?.activeStepId,
  );
  const inflight =
    active?.run !== null &&
    active?.run !== undefined &&
    active.terminal === null;
  const canRevise =
    plan && ["paused", "waitingSelection"].includes(plan.state) && !inflight;
  const disabled =
    !controller.canWrite ||
    texts.locked ||
    texts.recovery.blocksWrites ||
    conversations.locked;
  function chooseStart(next: PublicProjectTextPlanStage) {
    dirty.current.add("start");
    dirty.current.add("selectedEpisodes");
    setStart(next);
    setSelectedEpisodes([]);
    if (stages.indexOf(target) < stages.indexOf(next)) {
      dirty.current.add("target");
      setTarget(next);
    }
  }
  return (
    <section className="detail-panel" aria-label="文字自动执行计划">
      <div className="panel-heading">
        <h2>让 Agent 按计划创作</h2>
        <button
          className="text-button"
          disabled={snapshot.reading || snapshot.writing}
          onClick={() => void controller.refresh()}
        >
          刷新执行计划
        </button>
      </div>
      <p className="detail-note">
        选定起点和终点，Agent
        按顺序生成项目成果。关闭页面后，计划仍由项目服务保存。
      </p>
      {snapshot.phase === "waiting" && (
        <p className="detail-note" role="status">
          正在等待模块就绪…
        </p>
      )}
      {snapshot.phase === "unavailable" && (
        <p className="detail-note" role="status">
          执行计划服务暂不可用，可继续使用项目对话和手动创作。
        </p>
      )}
      {snapshot.error && (
        <p className="detail-note" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.notice && (
        <p className="detail-note" role="status">
          {snapshot.notice}
        </p>
      )}
      {snapshot.pending && (
        <button
          className="button secondary"
          disabled={snapshot.writing}
          onClick={() => void controller.retryOriginal()}
        >
          重试原计划操作
        </button>
      )}
      <div className="text-editor">
        <label className="form-field">
          项目对话
          <select
            aria-label="计划使用的项目对话"
            value={threadId}
            disabled={disabled}
            onChange={(e) => {
              dirty.current.add("threadId");
              setThreadId(e.target.value);
            }}
          >
            <option value="">选择一个已关联的创作对话</option>
            {chats.bindings
              .filter((b) => b.state === "active")
              .map((b, i) => (
                <option key={b.threadId} value={b.threadId}>
                  创作对话 {i + 1}
                </option>
              ))}
          </select>
        </label>
        <div className="detail-actions">
          <label className="form-field">
            从哪里开始
            <select
              aria-label="计划起点"
              value={start}
              disabled={disabled}
              onChange={(e) =>
                chooseStart(e.target.value as PublicProjectTextPlanStage)
              }
            >
              {stages.map((s) => (
                <option key={s} value={s}>
                  {labels[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            执行到哪里
            <select
              aria-label="计划终点"
              value={target}
              disabled={disabled}
              onChange={(e) => {
                dirty.current.add("target");
                setTarget(e.target.value as PublicProjectTextPlanStage);
              }}
            >
              {stages
                .filter((s) => stages.indexOf(s) >= stages.indexOf(start))
                .map((s) => (
                  <option key={s} value={s}>
                    {labels[s]}
                  </option>
                ))}
            </select>
          </label>
          {start !== "script" && target !== "brief" && (
            <label className="form-field">
              计划集数
              <select
                aria-label="计划集数"
                value={episodeCount}
                disabled={disabled}
                onChange={(e) => {
                  dirty.current.add("episodeCount");
                  setEpisodeCount(Number(e.target.value));
                }}
              >
                {Array.from({ length: 16 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1} 集
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {start === "script" && (
          <>
            <label className="form-field">
              剧本来源
              <select
                aria-label="计划剧本来源"
                value={scriptMode}
                disabled={disabled}
                onChange={(e) => {
                  dirty.current.add("scriptMode");
                  dirty.current.add("selectedEpisodes");
                  setScriptMode(e.target.value as typeof scriptMode);
                  setSelectedEpisodes([]);
                }}
              >
                <option value="selectedOutline">按已采用的大纲</option>
                <option value="independentScripts">已有独立分集剧本</option>
              </select>
            </label>
            <div className="detail-actions" aria-label="计划分集范围">
              {episodeOptions.map((episode, i) => (
                <label key={episode.id} className="detail-note">
                  <input
                    type="checkbox"
                    checked={selectedEpisodes.includes(episode.id)}
                    disabled={disabled}
                    onChange={(e) => {
                      dirty.current.add("selectedEpisodes");
                      setSelectedEpisodes((old) =>
                        e.target.checked
                          ? [...old, episode.id]
                          : old.filter((id) => id !== episode.id),
                      );
                    }}
                  />
                  第 {i + 1} 集 · {episode.title}
                </label>
              ))}
              {episodeOptions.length === 0 && (
                <p className="detail-note">
                  先在“大纲与剧本”中采用大纲或保存独立分集剧本，再选择要执行的分集。
                </p>
              )}
            </div>
          </>
        )}
        <label className="form-field">
          这次希望 Agent 完成什么
          <textarea
            aria-label="计划创作要求"
            value={instruction}
            disabled={disabled}
            placeholder="例如：保持女主的修复师设定，为三集都市悬疑补充递进冲突，每集结尾留下悬念。"
            onChange={(e) => {
              dirty.current.add("instruction");
              setInstruction(e.target.value);
            }}
          />
        </label>
        <label className="detail-note">
          <input
            type="checkbox"
            checked={automatic}
            disabled={disabled}
            onChange={(e) => {
              dirty.current.add("automatic");
              setAutomatic(e.target.checked);
            }}
          />
          来源未变时自动采用并继续
        </label>
        <p className="detail-note">
          {automatic
            ? "通过阶段检查且来源、选用版本未改变时，自动采用候选并推进。手动修改或锁定会暂停计划。"
            : "大纲和剧本先保存为候选。你在工作台采用后，明确点击继续；创作需求保存后按计划推进。"}
        </p>
        <div className="detail-actions">
          <button
            className="button primary"
            disabled={disabled || !binding || !definitionValid || occupied}
            onClick={() =>
              binding && void controller.start(binding, definition)
            }
          >
            开始文字计划
          </button>
          {canRevise && (
            <button
              className="button secondary"
              disabled={disabled || !definitionValid}
              onClick={() => void controller.reviseRemaining(definition)}
            >
              更新剩余计划
            </button>
          )}
        </div>
        {occupied && (
          <p className="detail-note">
            这个对话已有未结束的计划。可查看进度、调整剩余步骤或停止后续执行。
          </p>
        )}
      </div>
      {snapshot.plans.map((p, i) => (
        <div className="version-card" key={p.planId}>
          <div className="panel-heading">
            <strong>
              创作计划 {i + 1} · {states[p.state]}
            </strong>
            <button
              className="text-button"
              disabled={snapshot.reading || snapshot.writing}
              onClick={() => void controller.open(p.planId)}
            >
              查看计划
            </button>
          </div>
        </div>
      ))}
      {snapshot.nextPlanId && (
        <button
          className="text-button"
          disabled={snapshot.reading || snapshot.writing}
          onClick={() => void controller.refresh({ more: true })}
        >
          加载更多计划
        </button>
      )}
      {snapshot.view && plan && (
        <div className="version-card" aria-label="当前计划进度">
          <div className="panel-heading">
            <strong>
              {labels[snapshot.view.definition.start]} →{" "}
              {labels[snapshot.view.definition.target]} · {states[plan.state]}
            </strong>
            <button
              className="text-button"
              disabled={conversations.locked}
              onClick={() => void conversations.open(plan.threadId)}
            >
              进入项目对话
            </button>
          </div>
          {plan.pauseReason && (
            <p className="detail-note" role="status">
              {reasons[plan.pauseReason]}
            </p>
          )}
          <ol>
            {snapshot.view.steps.map((s) => (
              <li key={s.stepId}>
                {labels[s.kind]}
                {s.kind === "script"
                  ? ` · 第 ${snapshot.view!.definition.episodeIds.indexOf(s.episodeId!) + 1} 集`
                  : ""}{" "}
                ·{" "}
                {s.selection
                  ? "已采用"
                  : s.result
                    ? "已保存成果"
                    : s.state === "admitted"
                      ? "正在处理"
                      : s.state === "succeeded"
                        ? "已完成"
                        : "待处理"}
                {s.result && s.kind !== "brief" && (
                  <button
                    className="text-button"
                    disabled={texts.locked}
                    onClick={() => openText(s)}
                  >
                    查看与采用
                  </button>
                )}
              </li>
            ))}
          </ol>
          <div className="detail-actions">
            {["ready", "running", "waitingSelection"].includes(plan.state) && (
              <button
                className="button secondary"
                disabled={disabled}
                onClick={() => void controller.control("pause")}
              >
                暂停计划
              </button>
            )}
            {plan.state === "paused" && !inflight && (
              <button
                className="button primary"
                disabled={disabled}
                onClick={() => void controller.control("resume")}
              >
                确认当前来源并恢复
              </button>
            )}
            {active?.selection &&
              ["waitingSelection", "paused"].includes(plan.state) && (
                <button
                  className="button primary"
                  disabled={disabled}
                  onClick={() => void controller.control("continue")}
                >
                  按已采用成果继续
                </button>
              )}
            {plan.state !== "completed" && plan.state !== "revoked" && (
              <button
                className="button secondary"
                disabled={disabled}
                onClick={() => void controller.control("revoke")}
              >
                停止后续执行
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
