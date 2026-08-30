import { ArrowLeft, RotateCw, Square, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { renderMarkdown } from "../TranscriptMarkdown";
import { CommandComposer } from "../composer/CommandComposer";

import type {
  CrewonWorkflowExecution,
  CrewonWorkflowRecord,
} from "../../lib/workflow/crewonWorkflow";
import { CommandTeamEmptyState } from "./CommandTeamEmptyState";

export function CommandWorkflowPanel({
  workflows,
  status,
  onRun,
  onCancel,
  onResolveGate,
  onReload,
  onCreate,
  onRoomOpenChange,
  defaultOpenWorkflowId = null,
}: {
  workflows: CrewonWorkflowRecord[];
  status: "loading" | "ready" | "unavailable";
  onRun: (
    workflow: CrewonWorkflowRecord,
    input: string,
  ) => Promise<CrewonWorkflowExecution>;
  onCancel: (
    workflow: CrewonWorkflowRecord,
    executionId: string,
  ) => Promise<CrewonWorkflowExecution>;
  onResolveGate: (
    workflow: CrewonWorkflowRecord,
    executionId: string,
    nodeId: string,
    decision: "approve" | "reject",
    comment: string | null,
  ) => Promise<CrewonWorkflowExecution>;
  onReload: () => Promise<void>;
  onCreate?: () => void;
  onRoomOpenChange?: (open: boolean) => void;
  defaultOpenWorkflowId?: string | null;
}) {
  const available = useMemo(() => workflows, [workflows]);
  const [openedId, setOpenedId] = useState<string | null>(
    defaultOpenWorkflowId,
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [gateComment, setGateComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submittedInput, setSubmittedInput] = useState<string | null>(null);
  const [execution, setExecution] = useState<CrewonWorkflowExecution | null>(
    null,
  );
  const selected = available.find(
    (workflow) => workflow.config.workflowId === openedId,
  );
  const persistedExecution = selected
    ? workflowExecutionFromLatestRun(selected)
    : null;
  const latestRun = selected?.config.runs?.[0] ?? null;
  const pendingGate = (
    latestRun?.executedNodes ??
    execution?.executedNodes ??
    []
  ).find((node) => node.status === "waitingForApproval");
  const currentExecutionId = latestRun?.executionId ?? execution?.executionId;
  const runActive = matchesActiveWorkflowStatus(
    (persistedExecution ?? execution)?.status,
  );

  useEffect(() => {
    if (openedId !== null && !selected) {
      setOpenedId(null);
      onRoomOpenChange?.(false);
    }
  }, [onRoomOpenChange, openedId, selected]);

  async function submit(value: string) {
    const prompt = value.trim();
    if (!selected || !prompt || busy || runActive) {
      return;
    }
    setBusy(true);
    setError(null);
    setExecution(null);
    setSubmittedInput(prompt);
    try {
      setExecution(await onRun(selected, prompt));
      setInput("");
    } catch (runError) {
      setError(
        runError instanceof Error ? runError.message : "这次协作没有完成",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resolveGate(decision: "approve" | "reject") {
    if (!selected || !currentExecutionId || !pendingGate || controlBusy) {
      return;
    }
    setControlBusy(true);
    setError(null);
    try {
      setExecution(
        await onResolveGate(
          selected,
          currentExecutionId,
          pendingGate.nodeId,
          decision,
          gateComment.trim() || null,
        ),
      );
      setGateComment("");
      await onReload();
    } catch (gateError) {
      setError(
        gateError instanceof Error ? gateError.message : "确认没有生效，请重试",
      );
    } finally {
      setControlBusy(false);
    }
  }

  async function cancelRun() {
    if (!selected || !currentExecutionId || !runActive || controlBusy) {
      return;
    }
    setControlBusy(true);
    setError(null);
    try {
      setExecution(await onCancel(selected, currentExecutionId));
      await onReload();
    } catch (cancelError) {
      setError(
        cancelError instanceof Error ? cancelError.message : "协作流取消失败",
      );
    } finally {
      setControlBusy(false);
    }
  }

  if (status !== "ready") {
    return (
      <CommandTeamEmptyState
        action={
          status === "unavailable"
            ? { label: "重新同步", onClick: () => void onReload() }
            : null
        }
        description={
          status === "loading"
            ? "正在读取当前工作空间中的协作流。"
            : "暂时无法读取协作流，稍后可以重新同步。"
        }
        eyebrow="协作流"
        icon={Workflow}
        state={status}
        statusLabel={status === "loading" ? "正在加载" : "连接暂时中断"}
        title={status === "loading" ? "正在读取协作流" : "暂时无法打开协作流"}
      />
    );
  }

  if (available.length === 0) {
    return (
      <CommandTeamEmptyState
        action={
          onCreate
            ? { label: "创建协作流", onClick: onCreate, primary: true }
            : { label: "重新同步", onClick: () => void onReload() }
        }
        description="创建后，团队成员会按设定步骤接力完成任务。"
        eyebrow="协作流"
        icon={Workflow}
        title="还没有协作流"
      />
    );
  }

  if (!selected) {
    return (
      <div
        className="workflow-list"
        data-workflow-list=""
        aria-label="协作流列表"
      >
        {available.map((workflow) => (
          <WorkflowListItem
            key={workflow.config.workflowId}
            workflow={workflow}
            onOpen={() => {
              setOpenedId(workflow.config.workflowId);
              setExecution(null);
              setError(null);
              setSubmittedInput(null);
              onRoomOpenChange?.(true);
            }}
          />
        ))}
      </div>
    );
  }

  const visibleExecution = persistedExecution ?? execution;
  const visibleInput = submittedInput ?? latestRun?.input ?? null;
  const stages = workflowStages(selected, visibleExecution);

  return (
    <section
      className="workflow-room-inline workflow-runtime-room"
      data-workflow-room=""
      aria-labelledby="team-workflow-room-title"
    >
      <header className="workflow-room-top">
        <button
          className="button compact"
          type="button"
          onClick={() => {
            setOpenedId(null);
            setExecution(null);
            setError(null);
            setInput("");
            setSubmittedInput(null);
            onRoomOpenChange?.(false);
          }}
        >
          <ArrowLeft aria-hidden="true" />
          返回
        </button>
        <div className="workflow-room-title-block">
          <span>团队协作</span>
          <h3 id="team-workflow-room-title">{selected.config.name}</h3>
          <p title={workflowRoomSummary(selected, stages)}>
            {workflowRoomSummary(selected, stages)}
          </p>
        </div>
        <div className="workflow-room-actions">
          <span className={workflowStatusClassName(selected.config.status)}>
            {workflowStatusLabel(selected.config.status)}
          </span>
          <button
            aria-label="同步协作流"
            className="button compact"
            type="button"
            onClick={() => void onReload()}
          >
            <RotateCw aria-hidden="true" />
            同步
          </button>
          {runActive ? (
            <button
              aria-label="取消当前协作流运行"
              className="button compact workflow-cancel-button"
              type="button"
              disabled={controlBusy}
              onClick={() => void cancelRun()}
            >
              <Square aria-hidden="true" />
              {controlBusy ? "处理中…" : "取消运行"}
            </button>
          ) : null}
        </div>
      </header>
      <main className="workflow-room-stage">
        <WorkflowExecutionStrip stages={stages} />
        <section className="workflow-chat-panel">
          <div
            className="workflow-room-thread"
            role="log"
            aria-label="协作流群聊"
          >
            {!submittedInput && !visibleExecution && !error ? (
              <div className="workflow-thread-empty">
                <strong>从一个明确目标开始</strong>
                <p>输入目标后，团队会按既定步骤接力完成。</p>
              </div>
            ) : null}
            {visibleInput ? (
              <article className="office-room-message is-user">
                <span className="team-avatar">你</span>
                <div>
                  <strong>你</strong>
                  <p>{visibleInput}</p>
                </div>
              </article>
            ) : null}
            {visibleExecution ? (
              <article className="office-room-message workflow-result-message">
                <span className="team-avatar">流</span>
                <div>
                  <strong>协作结果</strong>
                  {renderMarkdown(executionResultText(visibleExecution))}
                  <small>
                    本次协作 · {workflowStatusLabel(visibleExecution.status)}
                  </small>
                </div>
              </article>
            ) : null}
            {pendingGate ? (
              <section className="workflow-gate-card" aria-label="确认环节">
                <div className="workflow-gate-card-copy">
                  <span>等待你确认</span>
                  <strong>{pendingGate.title}</strong>
                  <p>{workflowGateInstruction(selected, pendingGate.nodeId)}</p>
                </div>
                <label className="form-field">
                  <span>审批说明（可选）</span>
                  <textarea
                    maxLength={2_000}
                    placeholder="补充批准依据或驳回原因"
                    value={gateComment}
                    onChange={(event) => setGateComment(event.target.value)}
                  />
                </label>
                <div className="workflow-gate-actions">
                  <button
                    className="approval-deny"
                    type="button"
                    disabled={controlBusy}
                    onClick={() => void resolveGate("reject")}
                  >
                    驳回并结束
                  </button>
                  <button
                    className="approval-approve"
                    type="button"
                    disabled={controlBusy}
                    onClick={() => void resolveGate("approve")}
                  >
                    批准并继续
                  </button>
                </div>
              </section>
            ) : null}
            {busy ? (
              <article className="office-room-message is-pending" role="status">
                <span className="team-avatar">流</span>
                <div>
                  <strong>协作团队</strong>
                  <p>团队正在按步骤推进…</p>
                </div>
              </article>
            ) : null}
            {error ? (
              <article className="office-room-message is-error" role="alert">
                <span className="team-avatar">!</span>
                <div>
                  <strong>执行失败</strong>
                  <p>{error}</p>
                </div>
              </article>
            ) : null}
          </div>
          <CommandComposer
            actions={null}
            ariaLabel="协作流消息输入"
            className="command-input workflow-global-composer"
            controls={
              <span className="workflow-composer-capabilities">
                <b>@</b> 选择负责成员
                <i aria-hidden="true">·</i>
                <b>/</b> 添加能力
              </span>
            }
            disabled={busy || runActive || controlBusy}
            id="workflow-message-input"
            placeholder="继续推进这个协作流…"
            sendLabel="运行协作流"
            slashEnabled
            state={
              <span className="composer-state" role="status">
                {pendingGate
                  ? "等待你确认"
                  : busy || runActive
                    ? "团队正在推进"
                    : "可以继续沟通"}
              </span>
            }
            submitBehavior="enter"
            submitBlocked={!input.trim() || runActive}
            submitting={busy}
            value={input}
            onChange={setInput}
            onSubmit={submit}
          />
        </section>
      </main>
    </section>
  );
}

function WorkflowListItem({
  workflow,
  onOpen,
}: {
  workflow: CrewonWorkflowRecord;
  onOpen: () => void;
}) {
  const stages = workflowStages(
    workflow,
    workflowExecutionFromLatestRun(workflow),
  );
  const members = workflowMembers(workflow);
  const description =
    workflow.config.description.trim() || "按节点推进并保留每一步执行结果";
  return (
    <button
      className="workflow-list-item"
      data-workflow-open=""
      type="button"
      onClick={onOpen}
    >
      <span className="workflow-list-index" aria-hidden="true">
        <b>{stages.length}</b>
        <small>步骤</small>
      </span>
      <span className="workflow-list-main">
        <span className="workflow-list-title">
          <strong>{workflow.config.name}</strong>
          <small title={description}>{description}</small>
        </span>
        <em className={workflowStatusClassName(workflow.config.status)}>
          {workflowStatusLabel(workflow.config.status)}
        </em>
      </span>
      <span className="workflow-list-meta">
        <span
          className="workflow-list-copy"
          title={workflowListSummary(workflow, stages)}
        >
          {workflowListSummary(workflow, stages)}
        </span>
        <span className="workflow-member-strip" aria-label="协作流来源">
          {members.length > 0 ? (
            <>
              {members.slice(0, 4).map((member) => (
                <small key={member}>{memberInitial(member)}</small>
              ))}
              <em>{members.length} 成员</em>
            </>
          ) : (
            <>
              <small>流</small>
              <em>CrewON</em>
            </>
          )}
        </span>
      </span>
      <span className="workflow-list-foot">
        {stages.length > 0 ? (
          <span className="workflow-list-progress" aria-hidden="true">
            {stages.slice(0, 4).map((stage) => (
              <i
                className={stageProgressClassName(stage.status)}
                key={stage.id}
              />
            ))}
          </span>
        ) : null}
        <b>进入群聊</b>
      </span>
    </button>
  );
}

type WorkflowStage = {
  id: string;
  nodeType: "agent" | "humanGate";
  name: string;
  owner: string | null;
  status:
    | "canceled"
    | "done"
    | "failed"
    | "idle"
    | "rejected"
    | "running"
    | "waiting";
};

function WorkflowExecutionStrip({ stages }: { stages: WorkflowStage[] }) {
  if (stages.length === 0) {
    return (
      <section
        className="workflow-execution-strip is-empty"
        aria-label="执行步骤"
      >
        <div className="workflow-stage-empty">
          <strong>步骤将在开始后显示</strong>
          <p>现在还没有可展示的步骤信息。</p>
        </div>
      </section>
    );
  }
  return (
    <section className="workflow-execution-strip" aria-label="执行步骤">
      {stages.map((stage, index) => (
        <article
          className={[
            "workflow-step-node",
            stage.status === "done" && "is-done",
            stage.status === "running" && "is-running",
            stage.status === "waiting" && "is-waiting",
            ["canceled", "failed", "rejected"].includes(stage.status) &&
              "is-error",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-current={
            stage.status === "running" || stage.status === "waiting"
              ? "step"
              : undefined
          }
          key={stage.id}
        >
          <span>{String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>{stage.name}</strong>
            <p>
              {stage.nodeType === "humanGate"
                ? "由你确认"
                : workflowOwnerDisplayName(stage.owner)}
            </p>
          </div>
          <em className={workflowStageStatusClassName(stage.status)}>
            {workflowStageStatusLabel(stage.status)}
          </em>
        </article>
      ))}
    </section>
  );
}

function workflowStages(
  workflow: CrewonWorkflowRecord,
  execution: CrewonWorkflowExecution | null,
): WorkflowStage[] {
  const configured = workflow.config.nodes;
  const executed = new Map(
    (execution?.executedNodes ?? []).map((node) => [node.nodeId, node]),
  );
  return configured.slice(0, 8).map((node, index) => {
    const record = asRecord(node);
    const id = workflowNodeId(node) || String(index + 1);
    const executedNode = executed.get(id);
    const statusValue = String(
      executedNode?.status ?? record?.status ?? "",
    ).toLowerCase();
    return {
      id,
      nodeType:
        record?.type === "humanGate" || executedNode?.nodeType === "humanGate"
          ? "humanGate"
          : "agent",
      name: workflowNodeName(record, index),
      owner: workflowNodeOwner(record),
      status: workflowStageStatus(statusValue),
    };
  });
}

function workflowExecutionFromLatestRun(
  workflow: CrewonWorkflowRecord,
): CrewonWorkflowExecution | null {
  const run = workflow.config.runs?.[0];
  if (!run) {
    return null;
  }
  return {
    executionId: run.executionId,
    workflowId: workflow.config.workflowId,
    status: run.status,
    output: run.output,
    executedNodes: run.executedNodes,
    error: run.error,
  };
}

function matchesActiveWorkflowStatus(
  status: string | null | undefined,
): boolean {
  return ["canceling", "queued", "running", "waitingForApproval"].includes(
    status || "",
  );
}

function workflowMembers(workflow: CrewonWorkflowRecord): string[] {
  return workflowStages(workflow, null)
    .map((stage) => stage.owner)
    .filter((owner): owner is string => Boolean(owner))
    .filter((owner, index, owners) => owners.indexOf(owner) === index);
}

function workflowOwnerDisplayName(owner: string | null): string {
  const name = owner?.trim() || "";
  if (!name) {
    return "协作成员";
  }
  if (
    /^(?:local|desktop|web)[-_:]/i.test(name) ||
    (name.length > 24 && /^[\x00-\x7F]+$/.test(name))
  ) {
    return "协作成员";
  }
  return name.replaceAll("智能体", "成员").replace(/\bAgent\b/gi, "成员");
}

function workflowNodeId(node: unknown): string {
  const record = asRecord(node);
  return String(record?.id ?? record?.node_id ?? record?.nodeId ?? "");
}

function workflowNodeName(
  record: Record<string, unknown> | null,
  index: number,
): string {
  return String(
    record?.name ??
      record?.label ??
      record?.title ??
      record?.type ??
      `节点 ${index + 1}`,
  );
}

function workflowNodeOwner(
  record: Record<string, unknown> | null,
): string | null {
  const config = asRecord(record?.config);
  const data = asRecord(record?.data);
  if (record?.type === "humanGate") {
    return "人工确认";
  }
  const owner =
    record?.agent_name ??
    record?.agentName ??
    record?.owner ??
    config?.agent_name ??
    config?.agentName ??
    data?.agent_name ??
    data?.agentName;
  return typeof owner === "string" && owner.trim() ? owner.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function workflowListSummary(
  workflow: CrewonWorkflowRecord,
  stages: WorkflowStage[],
): string {
  if (stages.length > 0 && stages.every((stage) => stage.status === "done")) {
    return "全部步骤已完成";
  }
  const running =
    stages.find((stage) => ["running", "waiting"].includes(stage.status)) ??
    stages[0];
  if (running) {
    return `当前阶段：${running.name}${running.owner ? ` · ${running.owner}` : ""}`;
  }
  return workflow.config.description.trim() || "等待首次执行";
}

function workflowRoomSummary(
  _workflow: CrewonWorkflowRecord,
  stages: WorkflowStage[],
): string {
  if (stages.length > 0 && stages.every((stage) => stage.status === "done")) {
    return "全部步骤已完成";
  }
  const running =
    stages.find((stage) => stage.status === "running") ?? stages[0];
  const current =
    stages.find((stage) => ["running", "waiting"].includes(stage.status)) ??
    running;
  if (current) {
    return `当前阶段：${current.name}${current.owner ? ` · ${current.owner}` : ""}`;
  }
  return "等待首次执行 · CrewON 编排";
}

function memberInitial(member: string): string {
  return Array.from(workflowOwnerDisplayName(member))[0] || "员";
}

function stageProgressClassName(status: WorkflowStage["status"]): string {
  return status === "done"
    ? "is-done"
    : status === "running" || status === "waiting"
      ? "is-running"
      : "";
}

function workflowStageStatus(status: string): WorkflowStage["status"] {
  if (["complete", "completed", "done", "success"].includes(status)) {
    return "done";
  }
  if (["active", "processing", "queued", "running"].includes(status)) {
    return "running";
  }
  if (status === "waitingforapproval") {
    return "waiting";
  }
  if (status === "rejected") {
    return "rejected";
  }
  if (status === "canceled" || status === "interrupted") {
    return "canceled";
  }
  if (status === "failed") {
    return "failed";
  }
  return "idle";
}

function workflowStageStatusLabel(status: WorkflowStage["status"]): string {
  const labels: Record<WorkflowStage["status"], string> = {
    canceled: "已取消",
    done: "完成",
    failed: "失败",
    idle: "未开始",
    rejected: "已驳回",
    running: "运行中",
    waiting: "等你确认",
  };
  return labels[status];
}

function workflowStageStatusClassName(status: WorkflowStage["status"]): string {
  if (status === "done") {
    return "status success";
  }
  if (status === "running" || status === "waiting") {
    return "status warn";
  }
  if (["canceled", "failed", "rejected"].includes(status)) {
    return "status danger";
  }
  return "status";
}

function workflowStatusClassName(status: string | null | undefined): string {
  const normalized = status?.trim().toLowerCase() || "";
  if (
    ["complete", "completed", "done", "success", "active"].includes(normalized)
  ) {
    return "status success";
  }
  if (["running", "processing", "in_progress"].includes(normalized)) {
    return "status warn";
  }
  if (normalized === "waitingforapproval") {
    return "status warn";
  }
  if (["canceled", "failed", "interrupted", "rejected"].includes(normalized)) {
    return "status danger";
  }
  return "status";
}

function workflowStatusLabel(status: string | null | undefined): string {
  const normalized = status?.trim().toLowerCase() || "";
  const labels: Record<string, string> = {
    active: "已启用",
    canceled: "已取消",
    canceling: "取消中",
    complete: "已完成",
    completed: "已完成",
    done: "已完成",
    draft: "草稿",
    failed: "失败",
    in_progress: "运行中",
    interrupted: "已中断",
    pending: "待启动",
    processing: "运行中",
    ready: "待启动",
    rejected: "已驳回",
    running: "运行中",
    success: "已完成",
    waitingforapproval: "等待你确认",
  };
  return labels[normalized] || status?.trim() || "已启用";
}

function executionResultText(execution: CrewonWorkflowExecution): string {
  if (execution.error) {
    return execution.error;
  }
  if (execution.output.trim()) {
    return execution.output;
  }
  return execution.status === "completed"
    ? "协作已经完成，没有更多结果需要展示。"
    : execution.status === "waitingForApproval"
      ? "已到达确认环节，等待你批准或驳回。"
      : execution.status === "canceled"
        ? "协作已取消，后续步骤不会继续。"
        : "任务已经交给团队，正在等待继续处理。";
}

function workflowGateInstruction(
  workflow: CrewonWorkflowRecord,
  nodeId: string,
): string {
  const node = workflow.config.nodes.find(
    (candidate) => candidate.nodeId === nodeId,
  );
  return node?.instruction || "确认当前结果是否可以继续进入下一步。";
}
