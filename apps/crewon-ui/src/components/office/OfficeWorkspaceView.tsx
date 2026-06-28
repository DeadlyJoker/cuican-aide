import { Check, ChevronDown, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ActivityBoard } from "../activity/ActivityBoard";
import type { Locale } from "../../lib/i18n";
import type {
  AgentConfig,
  ArtifactItem,
  LibraryPanel,
  OfficeMember,
  OfficeMemberContextPreview,
  OfficeMemoryListResult,
  OfficeMemoryRecord,
  OfficeMemoryStatus,
  OfficeRunActivity,
  OfficeRunDelegationActivity,
  OfficeRunVerificationCheckActivity,
} from "../../lib/domain/crewonDomain";
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";
import { OfficeChatPanel } from "./OfficeChatPanel";
import { OfficeMembersPanel } from "./OfficeMembersPanel";
import { OfficeTasksPanel } from "./OfficeTasksPanel";
import { OfficeWorkspaceHeader } from "./OfficeWorkspaceHeader";

function verificationCheckActionKey(
  run: OfficeRunActivity,
  check: OfficeRunVerificationCheckActivity,
) {
  return (
    check.itemId ??
    check.automationRunId ??
    check.automationId ??
    `${run.id}:verification:${check.check}`
  );
}

export function OfficeWorkspaceView({
  panel,
  locale,
  onBack,
  onPanelAction,
  onSendMessage,
  onDecision,
  onArtifact,
  onDelegationCancel,
  onDelegationDispatch,
  onDelegationDispatchNext,
  onDelegationRetry,
  onVerificationCancel,
  onVerificationRetry,
  onMemoryDecision,
  onMemoryList,
  onMemberContextPreview,
  onRecruitableAgentList,
  onRunCancel,
  onRunRetry,
}: {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onPanelAction: LibraryPanelActionCallback;
  onSendMessage: (text: string) => void | Promise<void>;
  onDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
  onDelegationCancel: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void | Promise<void>;
  onDelegationDispatch: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void | Promise<void>;
  onDelegationDispatchNext?: (run: OfficeRunActivity) => void | Promise<void>;
  onDelegationRetry: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void | Promise<void>;
  onMemoryDecision?: (
    memoryId: string,
    status: OfficeMemoryStatus,
  ) => Promise<OfficeMemoryRecord | null>;
  onMemoryList?: (
    status: OfficeMemoryStatus,
    cursor?: string | null,
  ) => Promise<OfficeMemoryListResult | null>;
  onMemberContextPreview?: (
    run: OfficeRunActivity,
    member: OfficeMember,
  ) => Promise<OfficeMemberContextPreview | null>;
  onRecruitableAgentList?: (
    existingMembers: OfficeMember[],
  ) => Promise<AgentConfig[]>;
  onVerificationCancel: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => void | Promise<void>;
  onVerificationRetry: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => void | Promise<void>;
  onRunCancel: (run: OfficeRunActivity) => void | Promise<void>;
  onRunRetry: (run: OfficeRunActivity) => void | Promise<void>;
}) {
  const workspace = panel.workspace;
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chat" | "activity" | "memory">("chat");
  const [memoryStatus, setMemoryStatus] =
    useState<OfficeMemoryStatus>("pending");
  const [officeMemories, setOfficeMemories] = useState<OfficeMemoryRecord[]>(
    [],
  );
  const [officeMemoryNextCursor, setOfficeMemoryNextCursor] = useState<
    string | null
  >(null);
  const [isLoadingMemories, setIsLoadingMemories] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [pendingMemoryDecision, setPendingMemoryDecision] = useState<{
    memoryId: string;
    status: OfficeMemoryStatus;
  } | null>(null);
  const [recruitableAgents, setRecruitableAgents] = useState<AgentConfig[]>(
    [],
  );
  const [isLoadingRecruitableAgents, setIsLoadingRecruitableAgents] =
    useState(false);
  const [recruitableAgentError, setRecruitableAgentError] = useState<
    string | null
  >(null);
  const [isSendingOfficeMessage, setIsSendingOfficeMessage] = useState(false);
  const [pendingRunAction, setPendingRunAction] = useState<{
    action: "cancel" | "retry";
    runId: string;
  } | null>(null);
  const [pendingDelegationId, setPendingDelegationId] = useState<string | null>(
    null,
  );
  const [pendingVerificationCheckId, setPendingVerificationCheckId] = useState<
    string | null
  >(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.scrollTop = stream.scrollHeight;
    }
  }, [workspace?.messages.length, tab]);

  const loadOfficeMemories = useCallback(
    async (
      status: OfficeMemoryStatus = memoryStatus,
      cursor: string | null = null,
    ) => {
      if (!onMemoryList) {
        return;
      }
      setIsLoadingMemories(true);
      setMemoryError(null);
      try {
        const result = await onMemoryList(status, cursor);
        const data = result?.data ?? [];
        setOfficeMemories((current) => (cursor ? [...current, ...data] : data));
        setOfficeMemoryNextCursor(result?.nextCursor ?? null);
      } catch (error) {
        setMemoryError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsLoadingMemories(false);
      }
    },
    [memoryStatus, onMemoryList],
  );

  const loadRecruitableAgents = useCallback(async () => {
    if (!workspace || !onRecruitableAgentList) {
      return;
    }
    setIsLoadingRecruitableAgents(true);
    setRecruitableAgentError(null);
    try {
      setRecruitableAgents(await onRecruitableAgentList(workspace.members));
    } catch (error) {
      setRecruitableAgentError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsLoadingRecruitableAgents(false);
    }
  }, [onRecruitableAgentList, workspace]);

  useEffect(() => {
    if (tab === "memory" && onMemoryList) {
      void loadOfficeMemories(memoryStatus);
    }
  }, [loadOfficeMemories, memoryStatus, onMemoryList, tab]);

  useEffect(() => {
    if (tab === "chat" && onRecruitableAgentList) {
      void loadRecruitableAgents();
    }
  }, [loadRecruitableAgents, onRecruitableAgentList, tab]);

  if (!workspace) {
    return null;
  }
  const memberContextRun = latestOfficeRun(workspace.activity?.runs);

  async function submit() {
    const text = draft.trim();
    if (!text || isSendingOfficeMessage) {
      return;
    }
    setIsSendingOfficeMessage(true);
    try {
      await onSendMessage(text);
      setDraft("");
      setTab("activity");
    } finally {
      setIsSendingOfficeMessage(false);
    }
  }

  async function runOfficeAction(
    run: OfficeRunActivity,
    action: "cancel" | "retry",
  ) {
    if (pendingRunAction || pendingDelegationId || pendingVerificationCheckId) {
      return;
    }
    setPendingRunAction({ action, runId: run.id });
    try {
      if (action === "cancel") {
        await onRunCancel(run);
      } else {
        await onRunRetry(run);
      }
    } finally {
      setPendingRunAction(null);
    }
  }

  async function dispatchOfficeDelegation(
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) {
    if (pendingRunAction || pendingDelegationId || pendingVerificationCheckId) {
      return;
    }
    const delegationId =
      delegation.id ??
      `${run.id}:${delegation.agentId ?? delegation.member ?? "agent"}:${delegation.task ?? 0}`;
    setPendingDelegationId(delegationId);
    try {
      await onDelegationDispatch(run, delegation);
    } finally {
      setPendingDelegationId(null);
    }
  }

  async function dispatchNextOfficeDelegation(run: OfficeRunActivity) {
    if (
      pendingRunAction ||
      pendingDelegationId ||
      pendingVerificationCheckId ||
      !onDelegationDispatchNext
    ) {
      return;
    }
    setPendingDelegationId(`${run.id}:next`);
    try {
      await onDelegationDispatchNext(run);
    } finally {
      setPendingDelegationId(null);
    }
  }

  async function cancelOfficeDelegation(
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) {
    if (pendingRunAction || pendingDelegationId || pendingVerificationCheckId) {
      return;
    }
    const delegationId =
      delegation.id ??
      `${run.id}:${delegation.agentId ?? delegation.member ?? "agent"}:${delegation.task ?? 0}`;
    setPendingDelegationId(delegationId);
    try {
      await onDelegationCancel(run, delegation);
    } finally {
      setPendingDelegationId(null);
    }
  }

  async function retryOfficeDelegation(
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) {
    if (pendingRunAction || pendingDelegationId || pendingVerificationCheckId) {
      return;
    }
    const delegationId =
      delegation.id ??
      `${run.id}:${delegation.agentId ?? delegation.member ?? "agent"}:${delegation.task ?? 0}`;
    setPendingDelegationId(delegationId);
    try {
      await onDelegationRetry(run, delegation);
    } finally {
      setPendingDelegationId(null);
    }
  }

  async function cancelOfficeVerification(
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) {
    if (pendingRunAction || pendingDelegationId || pendingVerificationCheckId) {
      return;
    }
    const checkId = verificationCheckActionKey(run, check);
    setPendingVerificationCheckId(checkId);
    try {
      await onVerificationCancel(run, check);
    } finally {
      setPendingVerificationCheckId(null);
    }
  }

  async function retryOfficeVerification(
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) {
    if (pendingRunAction || pendingDelegationId || pendingVerificationCheckId) {
      return;
    }
    const checkId = verificationCheckActionKey(run, check);
    setPendingVerificationCheckId(checkId);
    try {
      await onVerificationRetry(run, check);
    } finally {
      setPendingVerificationCheckId(null);
    }
  }

  async function decideMemory(
    memoryId: string,
    status: OfficeMemoryStatus,
  ) {
    if (!onMemoryDecision || pendingMemoryDecision) {
      return;
    }
    setPendingMemoryDecision({ memoryId, status });
    setMemoryError(null);
    try {
      await onMemoryDecision(memoryId, status);
      await loadOfficeMemories(memoryStatus);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingMemoryDecision(null);
    }
  }

  function changeMemoryStatus(status: OfficeMemoryStatus) {
    setMemoryStatus(status);
    setOfficeMemories([]);
    setOfficeMemoryNextCursor(null);
  }

  return (
    <main className="office-workspace" aria-label={panel.title}>
      <OfficeWorkspaceHeader
        panel={panel}
        workspace={workspace}
        locale={locale}
        onBack={onBack}
      />

      <div
        className="office-tabs"
        role="tablist"
        aria-label={locale === "zh" ? "办公室视图" : "Office views"}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          data-active={tab === "chat"}
          onClick={() => setTab("chat")}
        >
          {locale === "zh" ? "群聊" : "Group chat"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "activity"}
          data-active={tab === "activity"}
          onClick={() => setTab("activity")}
        >
          {locale === "zh" ? "运行台" : "Activity"}
        </button>
        {onMemoryList ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "memory"}
            data-active={tab === "memory"}
            onClick={() => setTab("memory")}
          >
            {locale === "zh" ? "记忆" : "Memory"}
          </button>
        ) : null}
      </div>

      {tab === "memory" ? (
        <OfficeMemoryReviewPanel
          locale={locale}
          memories={officeMemories}
          status={memoryStatus}
          canDecide={Boolean(onMemoryDecision)}
          isLoading={isLoadingMemories}
          nextCursor={officeMemoryNextCursor}
          error={memoryError}
          pendingDecision={pendingMemoryDecision}
          onRefresh={() => void loadOfficeMemories(memoryStatus)}
          onLoadMore={(cursor) => void loadOfficeMemories(memoryStatus, cursor)}
          onStatusChange={changeMemoryStatus}
          onDecision={(memoryId, status) => void decideMemory(memoryId, status)}
        />
      ) : tab === "activity" ? (
        workspace.activity ? (
          <ActivityBoard
            data={workspace.activity}
            locale={locale}
            onDecision={onDecision}
            onArtifact={onArtifact}
            onDelegationDispatch={(run, delegation) =>
              void dispatchOfficeDelegation(run, delegation)
            }
            onDelegationCancel={(run, delegation) =>
              void cancelOfficeDelegation(run, delegation)
            }
            onDelegationDispatchNext={
              onDelegationDispatchNext
                ? (run) => void dispatchNextOfficeDelegation(run)
                : undefined
            }
            onDelegationRetry={(run, delegation) =>
              void retryOfficeDelegation(run, delegation)
            }
            onVerificationCancel={(run, check) =>
              void cancelOfficeVerification(run, check)
            }
            onVerificationRetry={(run, check) =>
              void retryOfficeVerification(run, check)
            }
            onRunCancel={(run) => void runOfficeAction(run, "cancel")}
            onRunRetry={(run) => void runOfficeAction(run, "retry")}
            pendingDelegationId={pendingDelegationId}
            pendingVerificationCheckId={pendingVerificationCheckId}
            pendingRunAction={pendingRunAction?.action ?? null}
            pendingRunId={pendingRunAction?.runId ?? null}
          />
        ) : (
          <p className="activity-empty">
            {locale === "zh" ? "暂无运行记录。" : "No activity yet."}
          </p>
        )
      ) : (
        <div className="office-grid">
          <OfficeMembersPanel
            actions={panel.actions}
            workspace={workspace}
            locale={locale}
            contextRun={memberContextRun}
            isLoadingRecruitableAgents={isLoadingRecruitableAgents}
            recruitableAgentError={recruitableAgentError}
            recruitableAgents={recruitableAgents}
            onMemberContextPreview={onMemberContextPreview}
            onPanelAction={onPanelAction}
            onRefreshRecruitableAgents={loadRecruitableAgents}
          />
          <OfficeChatPanel
            workspace={workspace}
            locale={locale}
            draft={draft}
            streamRef={streamRef}
            isSubmitting={isSendingOfficeMessage}
            onDraftChange={setDraft}
            onSubmit={() => void submit()}
          />
          <OfficeTasksPanel workspace={workspace} locale={locale} />
        </div>
      )}
    </main>
  );
}

function latestOfficeRun(runs: OfficeRunActivity[] | undefined) {
  if (!runs?.length) {
    return null;
  }
  return [...runs].sort((left, right) =>
    officeRunTimestamp(right).localeCompare(officeRunTimestamp(left)),
  )[0];
}

function officeRunTimestamp(run: OfficeRunActivity) {
  return run.updatedAt ?? run.completedAt ?? run.createdAt ?? "";
}

export function OfficeMemoryReviewPanel({
  locale,
  memories,
  status,
  isLoading,
  nextCursor,
  error,
  canDecide,
  pendingDecision,
  onDecision,
  onLoadMore,
  onRefresh,
  onStatusChange,
}: {
  locale: Locale;
  memories: OfficeMemoryRecord[];
  status: OfficeMemoryStatus;
  isLoading: boolean;
  nextCursor: string | null;
  error: string | null;
  canDecide: boolean;
  pendingDecision: {
    memoryId: string;
    status: OfficeMemoryStatus;
  } | null;
  onDecision: (memoryId: string, status: OfficeMemoryStatus) => void;
  onLoadMore: (cursor: string) => void;
  onRefresh: () => void;
  onStatusChange: (status: OfficeMemoryStatus) => void;
}) {
  const isZh = locale === "zh";
  const statusOptions: OfficeMemoryStatus[] = [
    "pending",
    "accepted",
    "rejected",
  ];
  const statusLabel = (value: OfficeMemoryStatus) =>
    isZh
      ? value === "pending"
        ? "待审核"
        : value === "accepted"
          ? "已接受"
          : "已拒绝"
      : value === "pending"
        ? "Pending"
        : value === "accepted"
          ? "Accepted"
          : "Rejected";
  const decisionLabel = (value: OfficeMemoryStatus) =>
    value === "pending"
      ? isZh
        ? "移回待审核"
        : "Move to pending"
      : statusLabel(value);
  const savingLabel = isZh ? "处理中" : "Saving";

  return (
    <section className="office-memory-panel" aria-label={statusLabel(status)}>
      <div className="office-memory-toolbar">
        <div
          className="office-memory-status-tabs"
          role="tablist"
          aria-label={isZh ? "记忆状态" : "Memory status"}
        >
          {statusOptions.map((option) => (
            <button
              type="button"
              role="tab"
              aria-selected={status === option}
              data-active={status === option}
              key={option}
              onClick={() => onStatusChange(option)}
            >
              {statusLabel(option)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="office-memory-refresh"
          disabled={isLoading}
          onClick={onRefresh}
          title={isZh ? "刷新" : "Refresh"}
          aria-label={isZh ? "刷新记忆" : "Refresh memories"}
        >
          <RefreshCw size={14} />
          {isLoading ? (isZh ? "刷新中" : "Refreshing") : null}
        </button>
      </div>

      {error ? <p className="office-memory-error">{error}</p> : null}

      <div className="office-memory-list">
        {memories.length === 0 && !isLoading ? (
          <p className="office-memory-empty">
            {isZh ? "没有匹配的记忆。" : "No matching memories."}
          </p>
        ) : null}
        {memories.map((memory) => {
          const pendingStatus = pendingDecision?.memoryId === memory.id;
          const memoryStatus =
            normalizedOfficeMemoryStatus(memory.status) ?? status;
          const decisionOptions = officeMemoryDecisionOptions(memoryStatus);
          const identity = officeMemoryIdentity(memory);
          const evidenceSummary = officeMemoryEvidenceSummary(memory);
          return (
            <article className="office-memory-row" key={memory.id}>
              <div className="office-memory-row-main">
                <div className="office-memory-row-meta">
                  <span>{memory.scope}</span>
                  <span>{memory.kind}</span>
                  {identity ? <span>{identity}</span> : null}
                  {memory.confidence ? <span>{memory.confidence}</span> : null}
                  {memory.importance ? (
                    <span>
                      {isZh ? "重要性" : "Importance"} {memory.importance}
                    </span>
                  ) : null}
                </div>
                <p>{memory.content}</p>
                <div className="office-memory-row-foot">
                  <span>
                    {isZh ? "更新" : "Updated"} {memory.updatedAt}
                  </span>
                  {memory.lastUsedAt ? (
                    <span>
                      {isZh ? "最近使用" : "Last used"} {memory.lastUsedAt}
                    </span>
                  ) : null}
                  {evidenceSummary ? (
                    <span title={evidenceSummary}>
                      {isZh ? "证据" : "Evidence"} {evidenceSummary}
                    </span>
                  ) : null}
                  {memory.usageCount ? (
                    <span>
                      {isZh ? "使用" : "Used"} {memory.usageCount}
                    </span>
                  ) : null}
                  {memory.keywords.length ? (
                    <span>
                      {isZh ? "关键词" : "Keywords"}{" "}
                      {memory.keywords.slice(0, 4).join(", ")}
                    </span>
                  ) : null}
                </div>
              </div>
              {decisionOptions.length > 0 && canDecide ? (
                <div className="office-memory-actions">
                  {decisionOptions.map((targetStatus) => (
                    <button
                      type="button"
                      disabled={pendingStatus}
                      key={targetStatus}
                      onClick={() => onDecision(memory.id, targetStatus)}
                      title={decisionLabel(targetStatus)}
                      aria-label={`${decisionLabel(targetStatus)} ${memory.content}`}
                    >
                      {memoryDecisionIcon(targetStatus)}
                      {pendingStatus && pendingDecision?.status === targetStatus
                        ? savingLabel
                        : decisionLabel(targetStatus)}
                    </button>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
        {nextCursor ? (
          <button
            type="button"
            className="office-memory-load-more"
            disabled={isLoading}
            onClick={() => onLoadMore(nextCursor)}
          >
            <ChevronDown size={14} />
            {isZh ? "加载更多" : "Load more"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function normalizedOfficeMemoryStatus(
  status: string,
): OfficeMemoryStatus | null {
  if (status === "pending" || status === "accepted" || status === "rejected") {
    return status;
  }
  return null;
}

function officeMemoryDecisionOptions(
  status: OfficeMemoryStatus,
): OfficeMemoryStatus[] {
  switch (status) {
    case "pending":
      return ["accepted", "rejected"];
    case "accepted":
      return ["pending", "rejected"];
    case "rejected":
      return ["pending", "accepted"];
  }
}

function memoryDecisionIcon(status: OfficeMemoryStatus) {
  switch (status) {
    case "accepted":
      return <Check size={14} />;
    case "pending":
      return <RefreshCw size={14} />;
    case "rejected":
      return <X size={14} />;
  }
}

function officeMemoryIdentity(memory: OfficeMemoryRecord) {
  if (memory.member && memory.agentId) {
    return `${memory.member}/${memory.agentId}`;
  }
  return memory.member ?? memory.agentId;
}

function officeMemoryEvidenceSummary(memory: OfficeMemoryRecord) {
  const allRefs = memory.evidenceRefs
    .map((ref) =>
      [ref.runId, ref.threadId, ref.turnId].filter(Boolean).join("/"),
    )
    .filter(Boolean);
  const refs = allRefs.slice(0, 2);
  const remaining = allRefs.length - refs.length;
  return remaining > 0 ? `${refs.join(" | ")} +${remaining}` : refs.join(" | ");
}
