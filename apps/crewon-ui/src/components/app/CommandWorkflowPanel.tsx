import { ArrowLeft, RotateCw, Square, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { renderMarkdown } from "../TranscriptMarkdown";
import { CommandWorkflowNodeOutputs } from "./CommandWorkflowNodeOutputs";
import { CommandComposer } from "../composer/CommandComposer";

import type {
  CrewonWorkflowExecution,
  CrewonWorkflowRecord,
} from "../../lib/workflow/crewonWorkflow";
import { CommandTeamEmptyState } from "./CommandTeamEmptyState";
import {
  TaskWorkbenchScope,
  WorkbenchSourceAnchor,
} from "../workbench/TaskWorkbenchContext";
import { projectWorkflowWorkbench } from "../../lib/workbench/taskWorkbenchProjection";
import { MessageActions } from "../messages/MessageActions";
import { currentWorkflowExecution } from "../../lib/workflow/currentWorkflowExecution";
import { useWorkflowProgressRefresh } from "./useWorkflowProgressRefresh";

export function CommandWorkflowPanel({
  active = true,
  openRequest,
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
  active?: boolean;
  openRequest?: Readonly<{ workflowId: string; revision: number }> | null;
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
  const consumedOpenRequest = useRef<typeof openRequest>(null);
  const available = useMemo(() => workflows, [workflows]);
  const [openedId, setOpenedId] = useState<string | null>(
    defaultOpenWorkflowId,
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [gateComment, setGateComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submittedInput, setSubmittedInput] = useState<string | null>(null);
  const [excludedExecutionId, setExcludedExecutionId] = useState<string | null>(
    null,
  );
  const [execution, setExecution] = useState<CrewonWorkflowExecution | null>(
    null,
  );
  const selected = available.find(
    (workflow) => workflow.config.workflowId === openedId,
  );
  const persistedExecution = useMemo(
    () => (selected ? workflowExecutionFromLatestRun(selected) : null),
    [selected],
  );
  const latestRun = selected?.config.runs?.[0] ?? null;
  const projectedExecution = currentWorkflowExecution({
    persisted: persistedExecution,
    local: execution,
    excludedExecutionId,
  });
  const workbench = useMemo(
    () =>
      !selected
        ? null
        : projectedExecution
          ? projectWorkflowWorkbench(projectedExecution, selected.config.name)
          : {
              scopeId: `workflow:${selected.config.workflowId}:pending`,
              title: selected.config.name,
              documents: [],
              browser: [],
            },
    [projectedExecution, selected],
  );
  const pendingGate = isWaitingForApprovalStatus(projectedExecution?.status)
    ? projectedExecution?.executedNodes.find(
        (node) => node.status === "waitingForApproval",
      )
    : undefined;
  // Only a persisted or accepted execution identity can be canceled.
  const cancelExecutionId = projectedExecution?.executionId;
  const runActive =
    matchesActiveWorkflowStatus(projectedExecution?.status) || busy;
  const controlPresentation = workflowControlPresentation({
    cancelBusy,
    gateBusy,
  });

  useWorkflowProgressRefresh({
    enabled: active && (runActive || gateBusy || cancelBusy),
    workflowId: selected?.config.workflowId ?? null,
    executionId: projectedExecution?.executionId ?? null,
    cadence:
      pendingGate && !gateBusy && !cancelBusy ? "waitingForApproval" : "active",
    reload: onReload,
  });

  useEffect(() => {
    if (openedId !== null && !selected) {
      setOpenedId(null);
      onRoomOpenChange?.(false);
    }
  }, [onRoomOpenChange, openedId, selected]);

  useEffect(() => {
    if (
      !active ||
      !openRequest ||
      consumedOpenRequest.current === openRequest ||
      !available.some(
        (record) => record.config.workflowId === openRequest.workflowId,
      )
    )
      return;
    consumedOpenRequest.current = openRequest;
    if (runActive) {
      setError("当前协作流正在执行，请完成或取消后再切换。");
      return;
    }
    setOpenedId(openRequest.workflowId);
    setExecution(null);
    setError(null);
    setSubmittedInput(null);
    setExcludedExecutionId(null);
    onRoomOpenChange?.(true);
  }, [active, available, openRequest, onRoomOpenChange, runActive]);

  async function submit(value: string) {
    const prompt = value.trim();
    if (!selected || !prompt || busy || runActive) {
      return;
    }
    setBusy(true);
    setExcludedExecutionId(projectedExecution?.executionId ?? null);
    setError(null);
    setExecution(null);
    setSubmittedInput(prompt);
    try {
      const result = await onRun(selected, prompt);
      setExecution(result);
      setInput("");
    } catch (runError) {
      setError(
        runError instanceof Error ? runError.message : "这次协作没有完成",
      );
    } finally {
      setBusy(false);
      // Final reload to pick up the settled state.
      void onReload();
    }
  }

  async function resolveGate(decision: "approve" | "reject") {
    if (
      !selected ||
      !cancelExecutionId ||
      !pendingGate ||
      gateBusy ||
      cancelBusy
    ) {
      return;
    }
    setGateBusy(true);
    setError(null);
    try {
      const resolved = await onResolveGate(
        selected,
        cancelExecutionId,
        pendingGate.nodeId,
        decision,
        gateComment.trim() || null,
      );
      setExecution((current) =>
        current?.status === "canceled" ? current : resolved,
      );
      setGateComment("");
      await onReload();
    } catch (gateError) {
      setError(
        gateError instanceof Error
          ? workflowGateResolutionErrorText(gateError.message)
          : "确认没有生效，请重试",
      );
    } finally {
      setGateBusy(false);
    }
  }

  async function cancelRun() {
    if (!selected || !cancelExecutionId || !runActive || cancelBusy) {
      return;
    }
    setCancelBusy(true);
    setError(null);
    try {
      setExecution(await onCancel(selected, cancelExecutionId));
      await onReload();
    } catch (cancelError) {
      setError(
        cancelError instanceof Error ? cancelError.message : "协作流取消失败",
      );
    } finally {
      setCancelBusy(false);
    }
  }

  if (status !== "ready" && !(status === "loading" && available.length > 0)) {
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
              setExcludedExecutionId(null);
              onRoomOpenChange?.(true);
            }}
          />
        ))}
      </div>
    );
  }

  const visibleExecution = projectedExecution;
  const visibleInput = submittedInput ?? latestRun?.input ?? null;
  const stages = workflowStages(selected, visibleExecution);
  const finalNode = visibleExecution?.executedNodes.findLast(
    (node) =>
      node.output.trim() &&
      node.output.trim() === visibleExecution.output.trim(),
  );

  return (
    <TaskWorkbenchScope snapshot={workbench} active={active}>
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
              {busy && !projectedExecution
                ? "准备执行"
                : workflowStatusLabel(
                    projectedExecution?.status ?? selected.config.status,
                  )}
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
            {runActive && cancelExecutionId ? (
              <button
                aria-label="取消当前协作流运行"
                className="button compact workflow-cancel-button"
                type="button"
                disabled={controlPresentation.cancelDisabled}
                onClick={() => void cancelRun()}
              >
                <Square aria-hidden="true" />
                {controlPresentation.cancelLabel}
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
                    <WorkbenchSourceAnchor
                      originId={
                        finalNode
                          ? `workflow-node:${visibleExecution.executionId}:${finalNode.nodeId}`
                          : undefined
                      }
                    >
                      {renderMarkdown(executionResultText(visibleExecution))}
                      <MessageActions
                        text={executionResultText(visibleExecution)}
                        locale="zh"
                      />
                    </WorkbenchSourceAnchor>
                    <CommandWorkflowNodeOutputs execution={visibleExecution} />
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
                    <p>
                      {workflowGateInstruction(selected, pendingGate.nodeId)}
                    </p>
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
                      disabled={controlPresentation.gateDisabled}
                      onClick={() => void resolveGate("reject")}
                    >
                      驳回并结束
                    </button>
                    <button
                      className="approval-approve"
                      type="button"
                      disabled={controlPresentation.gateDisabled}
                      onClick={() => void resolveGate("approve")}
                    >
                      批准并继续
                    </button>
                  </div>
                </section>
              ) : null}
              {busy ? (
                <article
                  className="office-room-message is-pending"
                  role="status"
                >
                  <span className="team-avatar">流</span>
                  <div>
                    <strong>协作团队</strong>
                    <p>
                      {projectedExecution?.status === "running"
                        ? "团队正在推进，已完成部分节点…"
                        : "团队正在按步骤推进…"}
                    </p>
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
              disabled={busy || runActive || gateBusy || cancelBusy}
              // Allow cancel even during the blocking onRun call.
              // The button is hidden below when runActive is false.
              // runActive now includes busy state, so the button shows during
              // the entire run lifecycle.
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
    </TaskWorkbenchScope>
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
  const executionCanceled = ["canceled", "interrupted"].includes(
    execution?.status.trim().toLowerCase() ?? "",
  );
  return configured.slice(0, 8).map((node, index) => {
    const record = asRecord(node);
    const id = workflowNodeId(node) || String(index + 1);
    const executedNode = executed.get(id);
    const statusValue = String(
      executedNode?.status ?? record?.status ?? "",
    ).toLowerCase();
    const projectedStatus = workflowStageStatus(statusValue);
    return {
      id,
      nodeType:
        record?.type === "humanGate" || executedNode?.nodeType === "humanGate"
          ? "humanGate"
          : "agent",
      name: workflowNodeName(record, index),
      owner: workflowNodeOwner(record),
      status:
        executionCanceled &&
        (projectedStatus === "running" || projectedStatus === "waiting")
          ? "canceled"
          : projectedStatus,
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

export function workflowControlPresentation(input: {
  cancelBusy: boolean;
  gateBusy: boolean;
}): Readonly<{
  cancelDisabled: boolean;
  cancelLabel: string;
  gateDisabled: boolean;
}> {
  return {
    cancelDisabled: input.cancelBusy,
    cancelLabel: input.cancelBusy ? "取消中…" : "取消运行",
    gateDisabled: input.gateBusy || input.cancelBusy,
  };
}

function isWaitingForApprovalStatus(
  status: string | null | undefined,
): boolean {
  return status?.trim().toLowerCase() === "waitingforapproval";
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
    stages.find((stage) =>
      ["canceled", "failed", "rejected"].includes(stage.status),
    ) ??
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
    stages.find((stage) =>
      ["canceled", "failed", "rejected"].includes(stage.status),
    ) ??
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
    const summary = workflowExecutionErrorText(execution.error);
    return execution.output.trim()
      ? `**${summary}**\n\n${execution.output}`
      : summary;
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

function workflowExecutionErrorText(error: string): string {
  if (error === "workflow_gate_rejected") {
    return "人工确认已驳回，协作流已结束。";
  }
  if (error === "control_workflow_verification_failed") {
    return "独立验证未通过，协作流已停止。请根据验证详情修复后重试。";
  }
  if (error === "control_workflow_verification_invalid") {
    return "独立验证没有返回唯一且合法的结论，协作流已安全停止。请检查验证详情后重试。";
  }
  return `协作流执行失败：${error}`;
}

function workflowGateResolutionErrorText(error: string): string {
  if (error === "control_workflow_execution_canceled") {
    return "协作流已经取消，不能再批准或驳回。请同步最新状态。";
  }
  if (error === "control_workflow_gate_not_pending") {
    return "这个确认环节已经处理或结束，请同步最新状态。";
  }
  return error;
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
