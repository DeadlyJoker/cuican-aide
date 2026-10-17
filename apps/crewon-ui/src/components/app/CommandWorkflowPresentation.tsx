import type {
  CrewonWorkflowExecution,
  CrewonWorkflowRecord,
} from "../../lib/workflow/crewonWorkflow";
export function WorkflowListItem({
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
        <b>
          {workflow.control && !workflow.control.loaded ? "…" : stages.length}
        </b>
        <small>
          {workflow.control && !workflow.control.loaded ? "查看定义" : "步骤"}
        </small>
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

export function WorkflowExecutionStrip({
  stages,
}: {
  stages: WorkflowStage[];
}) {
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

export function workflowStages(
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
  return configured
    .slice(0, workflow.control?.source === "durable" ? 64 : 8)
    .map((node, index) => {
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

export function workflowExecutionFromLatestRun(
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

export function matchesActiveWorkflowStatus(
  status: string | null | undefined,
): boolean {
  return [
    "canceling",
    "queued",
    "running",
    "waitingForApproval",
    "reconciling",
    "suspended",
  ].includes(status || "");
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

export function isWaitingForApprovalStatus(
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
    stages.find((stage) => stage.status === "idle") ??
    stages[0];
  if (running) {
    return `当前阶段：${running.name}${running.owner ? ` · ${running.owner}` : ""}`;
  }
  return workflow.config.description.trim() || "等待首次执行";
}

export function workflowRoomSummary(
  _workflow: CrewonWorkflowRecord,
  stages: WorkflowStage[],
): string {
  if (stages.length > 0 && stages.every((stage) => stage.status === "done")) {
    return "全部步骤已完成";
  }
  const current =
    stages.find((stage) => ["running", "waiting"].includes(stage.status)) ??
    stages.find((stage) =>
      ["canceled", "failed", "rejected"].includes(stage.status),
    ) ??
    stages.find((stage) => stage.status === "idle") ??
    stages[0];
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

export function workflowStatusClassName(
  status: string | null | undefined,
): string {
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

export function workflowStatusLabel(status: string | null | undefined): string {
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
    queued: "排队中",
    reconciling: "同步中",
    suspended: "等待恢复",
    rejected: "已驳回",
    running: "运行中",
    success: "已完成",
    waitingforapproval: "等待你确认",
  };
  return labels[normalized] || status?.trim() || "已启用";
}

export function executionResultText(
  execution: CrewonWorkflowExecution,
): string {
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
  if (
    error === "workflow_gate_rejected" ||
    error === "workflow_human_gate_rejected"
  ) {
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

export function workflowGateResolutionErrorText(error: string): string {
  if (error === "workflow_recovery_context_changed")
    return "当前身份或执行配置已变化，请重新同步；已有恢复记录会保留。";
  if (error === "workflow_durable_execution_unavailable")
    return "当前服务尚未启用持久协作流执行，记录仍可查看。";
  if (error === "workflow_command_unconfirmed")
    return "原请求结果尚未确认，请使用恢复原请求。";
  if (error === "workflow_command_pending_recovery")
    return "请先恢复原请求，避免重复提交。";
  if (error === "workflow_review_context_unavailable")
    return "当前服务暂不支持将审批意见交给后续成员，请先完成服务升级。";
  if (error === "workflow_review_invalid")
    return "审批说明不符合要求，请控制在 4096 UTF-8 字节以内。";
  if (error === "control_workflow_execution_canceled") {
    return "协作流已经取消，不能再批准或驳回。请同步最新状态。";
  }
  if (error === "control_workflow_gate_not_pending") {
    return "这个确认环节已经处理或结束，请同步最新状态。";
  }
  return error;
}

export function workflowGateInstruction(
  workflow: CrewonWorkflowRecord,
  nodeId: string,
): string {
  const node = workflow.config.nodes.find(
    (candidate) => candidate.nodeId === nodeId,
  );
  return node?.instruction || "确认当前结果是否可以继续进入下一步。";
}

export function workflowErrorTitle(error: string): string {
  return [
    "workflow_command_unconfirmed",
    "workflow_command_pending_recovery",
  ].some((code) => workflowGateResolutionErrorText(code) === error)
    ? "请求结果待确认"
    : "执行失败";
}
