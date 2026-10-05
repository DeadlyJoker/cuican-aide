import { useEffect, useReducer, useState } from "react";
import type { ProjectPlanningProposal } from "@crewon/contracts/project-planning";
import type { ProjectPlanningLaunchPort } from "../../lib/plugins/projectPlanningLaunch";
import type { Locale } from "../../lib/i18n";
import "./projectPlanningLaunch.css";

const planStates = {
  ready: "等待执行",
  running: "执行中",
  waitingSelection: "等待采用产出",
  paused: "已暂停",
  completed: "已完成",
  revoked: "已撤销",
};
export function ProjectPlanningLaunchActions({
  proposal,
  launch,
  locale,
  onReview,
  onWorkbench,
}: {
  proposal: ProjectPlanningProposal;
  launch: ProjectPlanningLaunchPort;
  locale: Locale;
  onReview(): void;
  onWorkbench(): void;
}) {
  const [, redraw] = useReducer((n) => n + 1, 0);
  const [adoption, setAdoption] = useState<"manual" | "whenUnchanged">(
    "manual",
  );
  const identity = JSON.stringify(proposal);
  useEffect(() => launch.subscribe(redraw), [launch]);
  useEffect(() => {
    if (launch.available(proposal) && launch.snapshot(proposal).intent)
      void launch.refresh(proposal).catch(() => undefined);
    // Restoring this exact original tool result performs observations only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch, identity]);
  const state = launch.snapshot(proposal),
    intent = state.intent,
    available = launch.available(proposal),
    working = state.phase === "working",
    zh = locale === "zh";
  const complete =
    (state.phase === "created" && intent?.mode === "create") ||
    state.phase === "started";
  return (
    <div className="project-planning-launch">
      <details>
        <summary>{zh ? "执行指令" : "Execution instructions"}</summary>
        <p>{proposal.input.instruction}</p>
      </details>
      {!intent && (
        <label className="form-field">
          <span>{zh ? "阶段产出处理" : "Stage results"}</span>
          <select
            aria-label={zh ? "阶段产出处理" : "Stage results"}
            value={adoption}
            disabled={working}
            onChange={(event) =>
              setAdoption(event.target.value as typeof adoption)
            }
          >
            <option value="manual">
              {zh
                ? "每阶段手动采用后继续"
                : "Choose each result before continuing"}
            </option>
            <option value="whenUnchanged">
              {zh
                ? "内容未变时自动采用并继续"
                : "Adopt and continue while sources are unchanged"}
            </option>
          </select>
        </label>
      )}
      {intent && (
        <p>
          {intent.adoption === "manual"
            ? zh
              ? "产出处理：每阶段手动采用后继续。"
              : "Results: choose each result before continuing."
            : zh
              ? "产出处理：内容未变时自动采用并继续。"
              : "Results: adopt and continue while sources are unchanged."}
        </p>
      )}
      <p role="status">
        {state.phase === "idle"
          ? zh
            ? "可只创建项目，或按上方范围执行文字计划。"
            : "Create a project, or execute the text plan shown above."
          : working
            ? zh
              ? "正在处理原请求…"
              : "Processing the original request…"
            : state.phase === "uncertain"
              ? zh
                ? "原请求尚未确认完成。刷新只读取状态；继续会使用原参数。"
                : "The original request is unresolved. Refresh only reads; continuing uses the original parameters."
              : state.phase === "started"
                ? state.plan
                  ? zh
                    ? `文字计划：${planStates[state.plan.plan.state]}`
                    : `Text plan: ${state.plan.plan.state}`
                  : zh
                    ? "文字计划已提交，请刷新查看状态。"
                    : "The text plan was submitted. Refresh its state."
                : zh
                  ? "项目已创建并关联当前会话。"
                  : "Project created and associated with this conversation."}
      </p>
      <div className="project-planning-launch-actions">
        {!intent && (
          <>
            <button
              type="button"
              className="button secondary"
              disabled={!available || working}
              onClick={() =>
                void launch
                  .confirm(proposal, { mode: "create", adoption })
                  .catch(() => undefined)
              }
            >
              {zh ? "创建项目并关联会话" : "Create and associate project"}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={
                !available || working || !proposal.capability.executionReady
              }
              onClick={() =>
                void launch
                  .confirm(proposal, { mode: "execute", adoption })
                  .catch(() => undefined)
              }
            >
              {zh ? "创建并按计划执行" : "Create and execute plan"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!available || working}
              onClick={onReview}
            >
              {zh ? "到工作台修改" : "Edit in workbench"}
            </button>
          </>
        )}
        {intent && !complete && (
          <button
            type="button"
            className="button secondary"
            disabled={!available || working}
            onClick={() =>
              void launch
                .confirm(proposal, {
                  mode: intent.mode,
                  adoption: intent.adoption,
                })
                .catch(() => undefined)
            }
          >
            {zh ? "继续原请求" : "Continue original request"}
          </button>
        )}
        {intent && (
          <button
            type="button"
            className="button secondary"
            disabled={!available || working}
            onClick={() => void launch.refresh(proposal).catch(() => undefined)}
          >
            {zh ? "刷新状态" : "Refresh state"}
          </button>
        )}
        {intent && (
          <button
            type="button"
            className="button secondary"
            disabled={!available || working}
            onClick={onWorkbench}
          >
            {zh ? "打开 AI 短剧工作台" : "Open AI Short Drama"}
          </button>
        )}
      </div>
      {state.error && (
        <p role="alert">
          {state.error === "project_planning_launch_wait_for_turn"
            ? zh
              ? "请等待当前对话执行结束后再确认。"
              : "Wait for the current conversation turn to finish."
            : zh
              ? "当前请求未完成。请刷新检查项目和会话；插件、会话或内容变化时，不会自动改用新参数。"
              : "The request did not complete. Refresh the project and conversation. Changed sources will not be substituted automatically."}
        </p>
      )}
      {!proposal.capability.executionReady && !intent && (
        <p>
          {zh
            ? "当前插件的文字执行能力尚未就绪，仍可创建项目。"
            : "Text execution is unavailable; project creation remains available."}
        </p>
      )}
    </div>
  );
}
