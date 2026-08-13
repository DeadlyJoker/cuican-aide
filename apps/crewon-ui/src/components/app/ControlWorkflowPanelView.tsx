import { ArrowLeft, ArrowUp, RotateCw } from "lucide-react";
import type {
  RunView,
  ToolApprovalView,
  WorkflowVersionSummaryView,
  WorkflowVersionView,
} from "@crewon/contracts";

import {
  isTerminalWorkflowRun,
  publicWorkflowRunStatus,
  type WorkflowStreamState,
  type WorkflowApprovalDecision,
} from "../../lib/workflow/controlWorkflowRun";

type CatalogState = "loading" | "ready" | "unavailable";
type PanelStreamState = WorkflowStreamState | Readonly<{ kind: "idle" }>;

export type ControlWorkflowPanelViewState = Readonly<{
  approval: ToolApprovalView | null;
  busy: boolean;
  catalog: WorkflowVersionSummaryView[];
  catalogState: CatalogState;
  error: string | null;
  input: string;
  run: RunView | null;
  selected: WorkflowVersionView | null;
  selectedThreadId: string | null;
  streamState: PanelStreamState;
}>;

export function ControlWorkflowPanelView({
  state,
  onClose,
  onInputChange,
  onOpen,
  onReload,
  onApprovalDecision,
  onStart,
}: {
  state: ControlWorkflowPanelViewState;
  onClose: () => void;
  onInputChange: (value: string) => void;
  onOpen: (workflow: WorkflowVersionSummaryView) => void;
  onReload: () => void;
  onApprovalDecision: (decision: WorkflowApprovalDecision) => void;
  onStart: () => void;
}) {
  if (state.selected === null) {
    if (state.catalogState !== "ready") {
      return (
        <EmptyState
          error={state.error}
          state={state.catalogState}
          reload={onReload}
        />
      );
    }
    if (state.catalog.length === 0) {
      return <EmptyState error={null} state="empty" reload={onReload} />;
    }
    return (
      <div className="workflow-list" aria-label="Control 协作流版本目录">
        {state.catalog.map((workflow) => (
          <button
            className="workflow-list-item"
            key={workflow.workflowVersionId}
            type="button"
            disabled={state.busy}
            onClick={() => onOpen(workflow)}
          >
            <span className="workflow-list-main">
              <strong>{workflow.name}</strong>
              <em className="status success">不可变版本</em>
            </span>
            <span className="workflow-list-meta">
              <span className="workflow-list-copy">{workflow.description}</span>
              <span className="workflow-member-strip">
                <small>流</small>
                <em>{workflow.workflowVersionId}</em>
              </span>
            </span>
            <span className="workflow-list-foot">
              <b>查看定义</b>
            </span>
          </button>
        ))}
        {state.error ? <p role="alert">{state.error}</p> : null}
      </div>
    );
  }

  const activeRun =
    state.run !== null && !isTerminalWorkflowRun(state.run.status);
  return (
    <section
      className="workflow-room-inline workflow-runtime-room"
      aria-labelledby="control-workflow-title"
    >
      <header className="workflow-room-top">
        <button className="button compact" type="button" onClick={onClose}>
          <ArrowLeft aria-hidden="true" /> 返回
        </button>
        <div className="workflow-room-title-block">
          <span>Control Workflow</span>
          <h3 id="control-workflow-title">{state.selected.name}</h3>
          <p>{state.selected.description}</p>
          <small>不可变版本 {state.selected.workflowVersionId}</small>
        </div>
        <StreamBadge state={state.streamState} />
      </header>
      <main className="workflow-room-stage">
        <section className="workflow-execution-strip" aria-label="静态节点定义">
          {state.selected.nodes.map((node, index) => (
            <article className="workflow-step-node" key={node.nodeId}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{node.title}</strong>
                <p>{node.instruction}</p>
                <small>{node.nodeId}</small>
              </div>
              <em className="status">
                {node.kind === "humanGate"
                  ? "Human Gate · 当前不可用"
                  : nodeKindLabel(node.kind)}
              </em>
            </article>
          ))}
        </section>
        <section className="workflow-chat-panel">
          <div
            className="workflow-room-thread"
            role="log"
            aria-label="Control Workflow Run"
          >
            <article className="office-room-message">
              <span className="team-avatar">流</span>
              <div>
                <strong>静态定义已载入</strong>
                <p>节点进度不在客户端推断；运行状态只读取 canonical Run。</p>
              </div>
            </article>
            {state.run ? <RunMessage run={state.run} /> : null}
            {state.run?.status === "waitingApproval" ? (
              <ApprovalMessage
                approval={state.approval}
                busy={state.busy}
                onDecision={onApprovalDecision}
              />
            ) : null}
            {state.error ? (
              <p className="workflow-control-error" role="alert">
                {state.error}
              </p>
            ) : null}
          </div>
          <form
            className="command-input workflow-global-composer workflow-control-composer"
            data-command-composer="true"
            onSubmit={(event) => {
              event.preventDefault();
              onStart();
            }}
          >
            <label className="visually-hidden" htmlFor="workflow-json-input">
              Workflow JSON 输入
            </label>
            <textarea
              id="workflow-json-input"
              aria-label="Workflow JSON 输入"
              disabled={state.busy || activeRun}
              rows={3}
              spellCheck={false}
              value={state.input}
              onChange={(event) => onInputChange(event.target.value)}
            />
            <div className="input-tools" data-od-id="composer-tools">
              <div className="composer-controls">
                <span className="workflow-composer-capabilities">
                  严格 JSON 输入 <i aria-hidden="true">·</i> 绑定当前 Control
                  会话
                </span>
              </div>
              <div className="composer-actions">
                <button
                  className="send-button"
                  type="submit"
                  aria-label="启动协作流"
                  aria-busy={state.busy}
                  disabled={
                    state.busy || state.selectedThreadId === null || activeRun
                  }
                  title="启动协作流"
                >
                  <ArrowUp aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="composer-state-row">
              <span className="composer-state" role="status">
                {state.selectedThreadId === null
                  ? "请先打开一个 Control 会话"
                  : streamStateCopy(state.streamState)}
              </span>
            </div>
          </form>
        </section>
      </main>
    </section>
  );
}

function RunMessage({ run }: { run: RunView }) {
  const status = publicWorkflowRunStatus(run.status);
  return (
    <article className="office-room-message" data-run-id={run.runId}>
      <span className="team-avatar">流</span>
      <div>
        <strong>Run #{run.runId}</strong>
        <p>
          {status === null
            ? "当前生命周期没有公开的 Control 操作。"
            : `状态：${runStatusLabel(status)}`}
          {run.outputRef ? ` · 输出引用：${run.outputRef}` : ""}
          {run.failure ? ` · 失败代码：${run.failure.code}` : ""}
        </p>
      </div>
    </article>
  );
}

function ApprovalMessage({
  approval,
  busy,
  onDecision,
}: {
  approval: ToolApprovalView | null;
  busy: boolean;
  onDecision: (decision: WorkflowApprovalDecision) => void;
}) {
  if (approval === null) {
    return (
      <article className="office-room-message" aria-busy="true">
        <span className="team-avatar">批</span>
        <div>
          <strong>正在读取工具审批</strong>
          <p>审批详情只从 CrewON Control 权威读取。</p>
        </div>
      </article>
    );
  }
  const pending = approval.status === "required";
  return (
    <article
      className="office-room-message workflow-approval-message"
      data-approval-id={approval.approvalId}
    >
      <span className="team-avatar">批</span>
      <div>
        <strong>{pending ? "工具操作等待审批" : "工具审批已决定"}</strong>
        <p>
          {pending
            ? `审批 ${approval.approvalId} · 修订 ${approval.revision}`
            : `${approval.status} · ${approval.decidedAt ?? "等待 canonical Run 更新"}`}
        </p>
        {pending ? (
          <span className="inline-actions" aria-label="工具审批操作">
            <button
              className="button compact primary"
              type="button"
              disabled={busy}
              onClick={() => onDecision("approved")}
            >
              批准
            </button>
            <button
              className="button compact"
              type="button"
              disabled={busy}
              onClick={() => onDecision("rejected")}
            >
              驳回
            </button>
          </span>
        ) : null}
      </div>
    </article>
  );
}

function StreamBadge({ state }: { state: PanelStreamState }) {
  if (state.kind === "idle") return null;
  const terminal = state.kind === "terminal";
  return (
    <span className={terminal ? "status success" : "status warn"}>
      {streamStateCopy(state)}
    </span>
  );
}

function EmptyState({
  error,
  state,
  reload,
}: {
  error: string | null;
  state: CatalogState | "empty";
  reload: () => void;
}) {
  const copy =
    state === "loading"
      ? ["正在读取协作流", "正在从 CrewON Control 读取不可变版本目录。"]
      : state === "empty"
        ? ["还没有已发布的协作流", "发布 WorkflowVersion 后即可在这里启动。"]
        : ["协作流服务暂不可用", "请检查 CrewON Control 连接后重试。"];
  return (
    <section className="team-office-empty team-capability-live-empty">
      <span className="team-office-empty-kicker">CrewON Workflow</span>
      <h2>{copy[0]}</h2>
      <p>{error ?? copy[1]}</p>
      <button className="button" type="button" onClick={reload}>
        <RotateCw aria-hidden="true" /> 重新同步
      </button>
    </section>
  );
}

function streamStateCopy(state: PanelStreamState): string {
  switch (state.kind) {
    case "idle":
      return "协作流 · 已就绪";
    case "connecting":
      return "正在连接 durable Run 事件";
    case "streaming":
      return "durable Run 事件已连接";
    case "reconnecting":
      return `重新连接 ${state.attempt}/${state.limit}`;
    case "terminal":
      return "canonical Run 已终止";
  }
}

function nodeKindLabel(
  kind: WorkflowVersionView["nodes"][number]["kind"],
): string {
  switch (kind) {
    case "agent":
      return "Agent";
    case "humanGate":
      return "Human Gate · 当前不可用";
    case "verification":
      return "Verification";
  }
}

function runStatusLabel(
  status: NonNullable<ReturnType<typeof publicWorkflowRunStatus>>,
): string {
  switch (status) {
    case "queued":
      return "queued · 排队";
    case "running":
      return "running · 运行中";
    case "reconciling":
      return "reconciling · 对账中";
    case "completed":
      return "completed · 已完成";
    case "failed":
      return "failed · 已失败";
    case "canceled":
      return "canceled · 已取消";
  }
}
