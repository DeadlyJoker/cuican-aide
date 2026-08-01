import { ArrowLeft, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CommandComposer } from "../composer/CommandComposer";

import type {
  PlatformWorkflow,
  PlatformWorkflowExecution,
} from "../../lib/agent-platform/agentPlatformClient";

export function CommandWorkflowPanel({
  workflows,
  onRun,
  onReload,
  onRoomOpenChange,
  defaultOpenWorkflowId = null,
}: {
  workflows: PlatformWorkflow[];
  onRun: (
    workflow: PlatformWorkflow,
    input: string,
  ) => Promise<PlatformWorkflowExecution>;
  onReload: () => Promise<void>;
  onRoomOpenChange?: (open: boolean) => void;
  defaultOpenWorkflowId?: number | null;
}) {
  const available = useMemo(
    () =>
      workflows.filter(
        (workflow) =>
          workflow.resource_source !== "catalog" &&
          workflow.is_active !== false &&
          workflow.is_active !== 0,
      ),
    [workflows],
  );
  const [openedId, setOpenedId] = useState<number | null>(
    defaultOpenWorkflowId,
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedInput, setSubmittedInput] = useState<string | null>(null);
  const [execution, setExecution] = useState<PlatformWorkflowExecution | null>(
    null,
  );
  const selected = available.find((workflow) => workflow.id === openedId);

  useEffect(() => {
    if (openedId !== null && !selected) {
      setOpenedId(null);
      onRoomOpenChange?.(false);
    }
  }, [onRoomOpenChange, openedId, selected]);

  async function submit(value: string) {
    const prompt = value.trim();
    if (!selected || !prompt || busy) {
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
      setError(runError instanceof Error ? runError.message : "协作流执行失败");
    } finally {
      setBusy(false);
    }
  }

  if (available.length === 0) {
    return (
      <section className="team-office-empty team-capability-live-empty">
        <span className="team-office-empty-kicker">真实 Workflow</span>
        <h2>当前账号没有可运行的协作流</h2>
        <p>
          这里只展示 agent-platform 返回的有效 Workflow，不生成本地演示节点。
        </p>
        <button
          className="button"
          type="button"
          onClick={() => void onReload()}
        >
          <RotateCw aria-hidden="true" />
          重新同步
        </button>
      </section>
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
            key={workflow.id}
            workflow={workflow}
            onOpen={() => {
              setOpenedId(workflow.id);
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

  const stages = workflowStages(selected, execution);

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
          <span>协作流群聊</span>
          <h3 id="team-workflow-room-title">{selected.name}</h3>
          <p title={workflowRoomSummary(selected, stages)}>
            {workflowRoomSummary(selected, stages)}
          </p>
        </div>
        <div className="workflow-room-actions">
          <span className={workflowStatusClassName(selected.status)}>
            {workflowStatusLabel(selected.status)}
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
            {!submittedInput && !execution && !error ? (
              <div className="workflow-thread-empty">
                <strong>从一个明确目标开始</strong>
                <p>输入目标后，协作流会按云端定义推进并返回结果。</p>
              </div>
            ) : null}
            {submittedInput ? (
              <article className="office-room-message is-user">
                <span className="team-avatar">你</span>
                <div>
                  <strong>你</strong>
                  <p>{submittedInput}</p>
                </div>
              </article>
            ) : null}
            {execution ? (
              <article className="office-room-message">
                <span className="team-avatar">流</span>
                <div>
                  <strong>协作流</strong>
                  <p>{executionResultText(execution)}</p>
                  <small>
                    执行 #{execution.id} ·{" "}
                    {workflowStatusLabel(execution.status)}
                  </small>
                </div>
              </article>
            ) : null}
            {busy ? (
              <article className="office-room-message is-pending" role="status">
                <span className="team-avatar">流</span>
                <div>
                  <strong>协作流</strong>
                  <p>正在提交到 Agent Platform 云端执行…</p>
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
                <b>@</b> 指定阶段 Agent
                <i aria-hidden="true">·</i>
                <b>/</b> 调用 Skill 或 MCP
              </span>
            }
            disabled={busy}
            id="workflow-message-input"
            placeholder="继续推进这个协作流…"
            sendLabel="运行协作流"
            slashEnabled
            state={
              <span className="composer-state" role="status">
                {busy ? "协作流 · 执行中" : "协作流 · 已就绪"}
              </span>
            }
            submitBehavior="enter"
            submitBlocked={!input.trim()}
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
  workflow: PlatformWorkflow;
  onOpen: () => void;
}) {
  const stages = workflowStages(workflow, null);
  const members = workflowMembers(workflow);
  return (
    <button
      className="workflow-list-item"
      data-workflow-open=""
      type="button"
      onClick={onOpen}
    >
      <span className="workflow-list-main">
        <strong>{workflow.name}</strong>
        <em className={workflowStatusClassName(workflow.status)}>
          {workflowStatusLabel(workflow.status)}
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
              <small>云</small>
              <em>Agent Platform</em>
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
  name: string;
  owner: string | null;
  status: "done" | "idle" | "running";
};

function WorkflowExecutionStrip({ stages }: { stages: WorkflowStage[] }) {
  if (stages.length === 0) {
    return (
      <section
        className="workflow-execution-strip is-empty"
        aria-label="执行节点"
      >
        <div className="workflow-stage-empty">
          <strong>节点将在执行后显示</strong>
          <p>当前云端定义未返回可展示的阶段信息。</p>
        </div>
      </section>
    );
  }
  return (
    <section className="workflow-execution-strip" aria-label="执行节点">
      {stages.map((stage, index) => (
        <article
          className={`workflow-step-node ${stage.status === "done" ? "is-done" : ""} ${stage.status === "running" ? "is-running" : ""}`.trim()}
          key={stage.id}
        >
          <span>{String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>{stage.name}</strong>
            <p>{stage.owner || "云端节点"}</p>
          </div>
          <em
            className={`status ${stage.status === "done" ? "success" : stage.status === "running" ? "warn" : ""}`.trim()}
          >
            {stage.status === "done"
              ? "完成"
              : stage.status === "running"
                ? "运行中"
                : "排队"}
          </em>
        </article>
      ))}
    </section>
  );
}

function workflowStages(
  workflow: PlatformWorkflow,
  execution: PlatformWorkflowExecution | null,
): WorkflowStage[] {
  const configured = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const executed = new Set(
    (execution?.executed_nodes ?? []).map((node) => workflowNodeId(node)),
  );
  const nodes =
    configured.length > 0 ? configured : (execution?.executed_nodes ?? []);
  return nodes.slice(0, 8).map((node, index) => {
    const record = asRecord(node);
    const id = workflowNodeId(node) || String(index + 1);
    const statusValue = String(record?.status ?? "").toLowerCase();
    const isDone =
      executed.has(id) ||
      ["complete", "completed", "done", "success"].includes(statusValue);
    const isRunning = ["active", "running", "processing"].includes(statusValue);
    return {
      id,
      name: workflowNodeName(record, index),
      owner: workflowNodeOwner(record),
      status: isDone ? "done" : isRunning ? "running" : "idle",
    };
  });
}

function workflowMembers(workflow: PlatformWorkflow): string[] {
  return workflowStages(workflow, null)
    .map((stage) => stage.owner)
    .filter((owner): owner is string => Boolean(owner))
    .filter((owner, index, owners) => owners.indexOf(owner) === index);
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
  workflow: PlatformWorkflow,
  stages: WorkflowStage[],
): string {
  const running =
    stages.find((stage) => stage.status === "running") ?? stages[0];
  if (running) {
    return `当前阶段：${running.name}${running.owner ? ` · ${running.owner}` : ""}`;
  }
  return workflow.description?.trim() || "等待首次执行";
}

function workflowRoomSummary(
  _workflow: PlatformWorkflow,
  stages: WorkflowStage[],
): string {
  const running = stages.find((stage) => stage.status === "running") ?? stages[0];
  if (running) {
    return `当前阶段：${running.name}${running.owner ? ` · ${running.owner}` : ""}`;
  }
  return "等待首次执行 · Agent Platform 云端";
}

function memberInitial(member: string): string {
  return Array.from(member.trim())[0] || "员";
}

function stageProgressClassName(status: WorkflowStage["status"]): string {
  return status === "done"
    ? "is-done"
    : status === "running"
      ? "is-running"
      : "";
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
  return "status";
}

function workflowStatusLabel(status: string | null | undefined): string {
  const normalized = status?.trim().toLowerCase() || "";
  const labels: Record<string, string> = {
    active: "已启用",
    complete: "已完成",
    completed: "已完成",
    done: "已完成",
    draft: "草稿",
    failed: "失败",
    in_progress: "运行中",
    pending: "待启动",
    processing: "运行中",
    ready: "待启动",
    running: "运行中",
    success: "已完成",
  };
  return labels[normalized] || status?.trim() || "已启用";
}

function executionResultText(execution: PlatformWorkflowExecution): string {
  if (execution.error_message) {
    return execution.error_message;
  }
  const output = execution.output_data;
  if (typeof output === "string") {
    return output;
  }
  if (output && Object.keys(output).length > 0) {
    return JSON.stringify(output, null, 2);
  }
  return execution.status === "completed"
    ? "协作流已完成，没有返回文本结果。"
    : "协作流已提交，等待后端继续处理。";
}
