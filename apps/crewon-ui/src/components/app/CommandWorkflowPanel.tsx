import { CommandWorkflowRunHistory } from "./CommandWorkflowRunHistory";
import {
  WorkflowListItem,
  WorkflowExecutionStrip,
  workflowStages,
  workflowExecutionFromLatestRun,
  matchesActiveWorkflowStatus,
  workflowControlPresentation,
  isWaitingForApprovalStatus,
  workflowRoomSummary,
  workflowStatusClassName,
  workflowStatusLabel,
  executionResultText,
  workflowGateResolutionErrorText,
  workflowErrorTitle,
  workflowGateInstruction,
} from "./CommandWorkflowPresentation";
export { workflowControlPresentation } from "./CommandWorkflowPresentation";
import { ArrowLeft, RotateCw, Square, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorkflowReadScope } from "../../lib/control-runtime/controlDurableWorkflowRuntime";

import { renderMarkdown } from "../TranscriptMarkdown";
import { CommandWorkflowNodeOutputs } from "./CommandWorkflowNodeOutputs";
import {
  CommandWorkflowVerificationEvidence,
  type WorkflowEvidenceRequest,
} from "./CommandWorkflowVerificationEvidence";
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
import { useWorkflowRootEvents } from "./useWorkflowRootEvents";
import type { WorkflowRunObserver } from "../../lib/control-runtime/controlDurableWorkflowRuntime";

export type WorkflowExecutionContext = Readonly<{
  threadId: string | null;
  pending: readonly import("../../lib/control-runtime/controlWorkflowIntentJournal").WorkflowIntent[];
}>;
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
  onInspect,
  controls,
  sourceIdentity,
  onReadEvidence,
  observe,
  onNewRun,
  executionContext,
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
  onReload: (scope?: WorkflowReadScope) => Promise<void>;
  onInspect?: (scope: WorkflowReadScope) => Promise<void>;
  controls?: (room: boolean) => ReactNode;
  sourceIdentity?: object | null;
  executionContext?: WorkflowExecutionContext;
  observe?: WorkflowRunObserver;
  onNewRun?: (workflowVersionId: string) => void;
  onReadEvidence?: (input: WorkflowEvidenceRequest) => Promise<string>;
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
  const viewIdentity = useRef({ workflowId: openedId, sourceIdentity });
  if (
    viewIdentity.current.workflowId !== openedId ||
    viewIdentity.current.sourceIdentity !== sourceIdentity
  )
    viewIdentity.current = { workflowId: openedId, sourceIdentity };
  const control = selected?.control;
  const pendingSubmission =
    Boolean(control) &&
    (executionContext?.pending.some(
      (intent) =>
        intent.command.kind === "start" &&
        intent.threadId === executionContext.threadId,
    ) ??
      false);
  const readOnly = Boolean(
    control &&
      (control.source === "legacy" ||
        !control.loaded ||
        control.readOnlyReason),
  );
  const reloadSelected = () =>
    onReload(
      selected?.control?.source === "durable"
        ? {
            workflowVersionId: selected.control.workflowVersionId,
            runId: selected.control.knownRunId,
          }
        : undefined,
    );
  useEffect(() => {
    if (selected?.control?.source === "durable" && !selected.control.loaded)
      void onInspect?.({
        workflowVersionId: selected.control.workflowVersionId,
        runId: null,
      });
  }, [selected?.config.workflowId, selected?.control?.loaded, onInspect]);
  useEffect(() => {
    setBusy(false);
    setGateBusy(false);
    setCancelBusy(false);
    setExecution(null);
    setError(null);
  }, [openedId, sourceIdentity]);
  const persistedExecution = useMemo(
    () => (selected ? workflowExecutionFromLatestRun(selected) : null),
    [selected],
  );
  const latestRun = selected?.config.runs?.[0] ?? null;
  const projectedExecution = selected?.control
    ? persistedExecution?.executionId === excludedExecutionId
      ? null
      : persistedExecution
    : currentWorkflowExecution({
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
  const [gateNodeId, setGateNodeId] = useState<string | null>(null);
  const pendingGates = isWaitingForApprovalStatus(projectedExecution?.status)
    ? (projectedExecution?.executedNodes.filter(
        (node) => node.status === "waitingForApproval",
      ) ?? [])
    : [];
  const pendingGate =
    pendingGates.find((node) => node.nodeId === gateNodeId) ?? pendingGates[0];
  // Only a persisted or accepted execution identity can be canceled.
  const cancelExecutionId = projectedExecution?.executionId;
  const runActive =
    matchesActiveWorkflowStatus(projectedExecution?.status) || busy;
  const controlPresentation = workflowControlPresentation({
    cancelBusy,
    gateBusy,
  });

  useWorkflowProgressRefresh({
    enabled:
      active &&
      control?.source !== "legacy" &&
      (runActive || gateBusy || cancelBusy),
    workflowId: selected?.config.workflowId ?? null,
    executionId: projectedExecution?.executionId ?? null,
    cadence:
      pendingGate && !gateBusy && !cancelBusy && !control?.awaitingSnapshot
        ? "waitingForApproval"
        : "active",
    reload: reloadSelected,
  });
  useWorkflowRootEvents({
    enabled:
      active &&
      control?.source === "durable" &&
      matchesActiveWorkflowStatus(projectedExecution?.status) &&
      Boolean(control.root),
    workflowVersionId: control?.workflowVersionId ?? null,
    runId: control?.knownRunId ?? null,
    afterSequence: control?.root?.lastSequence ?? 0,
    sourceIdentity,
    observe,
    reload: reloadSelected,
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
    if (runActive && !selected?.control) {
      setError("当前协作流正在执行，请完成或取消后再切换。");
      return;
    }
    if (selected?.control) {
      viewIdentity.current = { ...viewIdentity.current };
      setBusy(false);
      setGateBusy(false);
      setCancelBusy(false);
    }
    setOpenedId(openRequest.workflowId);
    setExecution(null);
    setError(null);
    setSubmittedInput(null);
    setExcludedExecutionId(null);
    onRoomOpenChange?.(true);
  }, [active, available, openRequest, onRoomOpenChange, runActive]);

  function inspectSelected(scope: WorkflowReadScope) {
    viewIdentity.current = { ...viewIdentity.current };
    setBusy(false);
    setGateBusy(false);
    setCancelBusy(false);
    setExecution(null);
    setError(null);
    setSubmittedInput(null);
    setExcludedExecutionId(null);
    setGateComment("");
    return onInspect?.(scope);
  }

  async function submit(value: string) {
    const prompt = value.trim();
    if (
      !selected ||
      !prompt ||
      busy ||
      runActive ||
      readOnly ||
      control?.canStart === false ||
      pendingSubmission
    ) {
      return;
    }
    setBusy(true);
    setExcludedExecutionId(projectedExecution?.executionId ?? null);
    setError(null);
    setExecution(null);
    setSubmittedInput(prompt);
    const identity = viewIdentity.current;
    try {
      const result = await onRun(selected, prompt);
      if (viewIdentity.current !== identity) return;
      setExecution(result);
      setInput("");
    } catch (runError) {
      if (viewIdentity.current !== identity) return;
      setError(
        runError instanceof Error
          ? workflowGateResolutionErrorText(runError.message)
          : "这次协作没有完成",
      );
    } finally {
      if (viewIdentity.current === identity) {
        setBusy(false);
        if (!selected.control) void reloadSelected();
      }
    }
  }

  async function resolveGate(decision: "approve" | "reject") {
    if (
      !selected ||
      !cancelExecutionId ||
      !pendingGate ||
      gateBusy ||
      cancelBusy ||
      readOnly ||
      control?.awaitingSnapshot ||
      control?.canReview === false
    ) {
      return;
    }
    setGateBusy(true);
    setError(null);
    const identity = viewIdentity.current;
    try {
      const resolved = await onResolveGate(
        selected,
        cancelExecutionId,
        pendingGate.nodeId,
        decision,
        control?.source === "durable"
          ? gateComment === ""
            ? null
            : gateComment
          : gateComment.trim() || null,
      );
      if (viewIdentity.current !== identity) return;
      setExecution((current) =>
        current?.status === "canceled" ? current : resolved,
      );
      setGateComment("");
      await reloadSelected();
    } catch (gateError) {
      if (viewIdentity.current !== identity) return;
      setError(
        gateError instanceof Error
          ? workflowGateResolutionErrorText(gateError.message)
          : "确认没有生效，请重试",
      );
    } finally {
      if (viewIdentity.current === identity) setGateBusy(false);
    }
  }

  async function cancelRun() {
    if (
      !selected ||
      !cancelExecutionId ||
      !runActive ||
      cancelBusy ||
      readOnly
    ) {
      return;
    }
    setCancelBusy(true);
    setError(null);
    const identity = viewIdentity.current;
    try {
      const result = await onCancel(selected, cancelExecutionId);
      if (viewIdentity.current !== identity) return;
      setExecution(result);
      await reloadSelected();
    } catch (cancelError) {
      if (viewIdentity.current !== identity) return;
      setError(
        cancelError instanceof Error ? cancelError.message : "协作流取消失败",
      );
    } finally {
      if (viewIdentity.current === identity) setCancelBusy(false);
    }
  }

  if (status !== "ready" && !(status === "loading" && available.length > 0)) {
    const empty = (
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
    return controls ? (
      <>
        {controls(false)}
        {empty}
      </>
    ) : (
      empty
    );
  }

  if (available.length === 0) {
    const empty = (
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
    return controls ? (
      <>
        {controls(false)}
        {empty}
      </>
    ) : (
      empty
    );
  }

  if (!selected) {
    return (
      <div
        className="workflow-list"
        data-workflow-list=""
        aria-label="协作流列表"
      >
        {controls?.(false)}
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
              onClick={() => void reloadSelected()}
            >
              <RotateCw aria-hidden="true" />
              同步
            </button>
            {runActive && cancelExecutionId && !readOnly ? (
              <button
                aria-label="取消当前协作流运行"
                className="button compact workflow-cancel-button"
                type="button"
                disabled={
                  controlPresentation.cancelDisabled ||
                  control?.root?.cancelRequested
                }
                onClick={() => void cancelRun()}
              >
                <Square aria-hidden="true" />
                {control?.root?.cancelRequested
                  ? "取消中…"
                  : controlPresentation.cancelLabel}
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
              {controls?.(true)}
              <CommandWorkflowRunHistory
                record={selected}
                onInspect={inspectSelected}
                onNewRun={
                  onNewRun
                    ? (versionId) => {
                        viewIdentity.current = { ...viewIdentity.current };
                        setBusy(false);
                        setGateBusy(false);
                        setCancelBusy(false);
                        setExecution(null);
                        setError(null);
                        setSubmittedInput(null);
                        setExcludedExecutionId(null);
                        setInput("");
                        onNewRun(versionId);
                      }
                    : undefined
                }
              />
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
                    {control?.source === "durable" && onReadEvidence ? (
                      <CommandWorkflowVerificationEvidence
                        key={visibleExecution.executionId}
                        execution={visibleExecution}
                        read={(request) =>
                          onReadEvidence({
                            ...request,
                            workflow: selected,
                            executionId: visibleExecution.executionId,
                          })
                        }
                      />
                    ) : null}
                    <small>
                      本次协作 · {workflowStatusLabel(visibleExecution.status)}
                    </small>
                  </div>
                </article>
              ) : null}
              {pendingGate && !readOnly ? (
                <section className="workflow-gate-card" aria-label="确认环节">
                  <div className="workflow-gate-card-copy">
                    {pendingGates.length > 1 ? (
                      <label>
                        选择确认环节
                        <select
                          aria-label="选择确认环节"
                          value={pendingGate.nodeId}
                          onChange={(event) => {
                            setGateNodeId(event.target.value);
                            setGateComment("");
                          }}
                        >
                          {pendingGates.map((node) => (
                            <option key={node.nodeId} value={node.nodeId}>
                              {node.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <span>等待你确认</span>
                    <strong>{pendingGate.title}</strong>
                    <p>
                      {workflowGateInstruction(selected, pendingGate.nodeId)}
                    </p>
                  </div>
                  <label className="form-field">
                    <span>审批说明（可选）</span>
                    <textarea
                      maxLength={control?.source === "durable" ? 4096 : 2000}
                      placeholder="补充批准依据或驳回原因"
                      value={gateComment}
                      onChange={(event) => setGateComment(event.target.value)}
                    />
                  </label>
                  <div className="workflow-gate-actions">
                    <button
                      className="approval-deny"
                      type="button"
                      disabled={
                        controlPresentation.gateDisabled ||
                        control?.canReview === false ||
                        control?.awaitingSnapshot
                      }
                      onClick={() => void resolveGate("reject")}
                    >
                      驳回并结束
                    </button>
                    <button
                      className="approval-approve"
                      type="button"
                      disabled={
                        controlPresentation.gateDisabled ||
                        control?.canReview === false ||
                        control?.awaitingSnapshot
                      }
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
                    <strong>{workflowErrorTitle(error)}</strong>
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
              disabled={
                busy ||
                runActive ||
                gateBusy ||
                cancelBusy ||
                readOnly ||
                control?.canStart === false ||
                pendingSubmission
              }
              // Allow cancel even during the blocking onRun call.
              // The button is hidden below when runActive is false.
              // runActive now includes busy state, so the button shows during
              // the entire run lifecycle.
              id="workflow-message-input"
              placeholder={
                control?.inputMode === "json"
                  ? "按输入格式填写 JSON…"
                  : "继续推进这个协作流…"
              }
              sendLabel="运行协作流"
              slashEnabled
              state={
                <span className="composer-state" role="status">
                  {pendingSubmission
                    ? "请恢复原请求"
                    : pendingGate
                      ? "等待你确认"
                      : busy || runActive
                        ? "团队正在推进"
                        : "可以继续沟通"}
                </span>
              }
              submitBehavior="enter"
              submitBlocked={
                !input.trim() ||
                runActive ||
                readOnly ||
                control?.canStart === false ||
                pendingSubmission
              }
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
