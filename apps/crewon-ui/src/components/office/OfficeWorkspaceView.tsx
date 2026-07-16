import { Check, ChevronDown, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Locale } from "../../lib/i18n";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
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
import type {
  OfficeMessageSendResult,
  OfficeMessageSubmitMention,
  PendingOfficeMessageDelivery,
} from "../../lib/domain/officeMessageDelivery";
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";
import { deriveOfficeComposerRuntimeState } from "../../lib/office/officeComposerRuntime";
import { latestOfficeTaskRun } from "../../lib/office/latestOfficeTaskRun";
import type { OfficeIdentity } from "../../lib/office/officeIdentity";
import {
  officeIdentityFromPanel,
  officeIdentitySnapshotFromPanel,
  officeIdentitySnapshotsMatch,
  officePanelMatchesIdentity,
} from "../../lib/office/officeIdentity";
import { OfficeChatPanel } from "./OfficeChatPanel";
import { OfficeMembersPanel } from "./OfficeMembersPanel";
import {
  OfficeWorkspaceHeader,
  type OfficeWorkspaceTab,
} from "./OfficeWorkspaceHeader";

export async function submitOfficeDraft({
  draft,
  isSubmitting,
  onSend,
  onSuccess,
}: {
  draft: string;
  isSubmitting: boolean;
  onSend: (
    text: string,
  ) => OfficeMessageSendResult | Promise<OfficeMessageSendResult>;
  onSuccess: () => void;
}) {
  const text = draft.trim();
  if (!text || isSubmitting) {
    return false;
  }
  const result = await onSend(text);
  if (result.disposition === "clearOutbox") onSuccess();
  return result;
}

export type OfficeMessageOutbox = {
  clientUserMessageId: string;
  mentions: OfficeMessageSubmitMention[];
  officeIdentity: OfficeIdentity;
  text: string;
};

export function resolveOfficeMessageOutbox(
  current: OfficeMessageOutbox | null,
  draft: string,
  panel: LibraryPanel,
  createId: () => string = createOfficeMessageClientUserMessageId,
  mentions: OfficeMessageSubmitMention[] = [],
): OfficeMessageOutbox | null {
  const text = draft.trim();
  const officeIdentity = officeIdentityFromPanel(panel);
  if (!text || !officeIdentity) return null;
  return current?.text === text &&
    officeMessageMentionsEqual(current.mentions, mentions) &&
    officePanelMatchesIdentity(panel, current.officeIdentity)
    ? current
    : {
        clientUserMessageId: createId(),
        mentions: mentions.map((mention) => ({ ...mention })),
        officeIdentity,
        text,
      };
}

function officeMessageMentionsEqual(
  left: OfficeMessageSubmitMention[],
  right: OfficeMessageSubmitMention[],
): boolean {
  return (
    left.length === right.length &&
    left.every((mention, index) => mention.memberId === right[index]?.memberId)
  );
}

export function createOfficeMessageClientUserMessageId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId
    ? `office-message-${randomId}`
    : `office-message-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function OfficeWorkspaceView({
  activeTurnByThread = {},
  panel,
  locale,
  onBack,
  onAttachContext,
  onPanelAction,
  onSendMessage,
  onMemoryDecision,
  onMemoryList,
  onMemberContextPreview,
  onRecruitableAgentList,
  onRunCancel,
  slashCommands = [],
}: {
  activeTurnByThread?: Record<string, string>;
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onAttachContext?: (
    workspaceCwd: string | undefined,
    onSelectPath: (path: string) => void,
  ) => void;
  onPanelAction: LibraryPanelActionCallback;
  onSendMessage: (
    text: string,
    clientUserMessageId: string,
    mentions: OfficeMessageSubmitMention[],
  ) => OfficeMessageSendResult | Promise<OfficeMessageSendResult>;
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
  slashCommands?: ComposerSlashCommand[];
}) {
  const workspace = panel.workspace;
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<OfficeWorkspaceTab>("chat");
  const [membersOpen, setMembersOpen] = useState(false);
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
  const [recruitableAgents, setRecruitableAgents] = useState<AgentConfig[]>([]);
  const [isLoadingRecruitableAgents, setIsLoadingRecruitableAgents] =
    useState(false);
  const [recruitableAgentError, setRecruitableAgentError] = useState<
    string | null
  >(null);
  const [isSendingOfficeMessage, setIsSendingOfficeMessage] = useState(false);
  const [pendingMessageDelivery, setPendingMessageDelivery] =
    useState<PendingOfficeMessageDelivery | null>(null);
  const [pendingRunAction, setPendingRunAction] = useState<{
    runId: string;
  } | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const messageOutboxRef = useRef<OfficeMessageOutbox | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const officeIdentityRef = useRef(officeIdentitySnapshotFromPanel(panel));

  useEffect(() => {
    const previous = officeIdentityRef.current;
    const next = officeIdentitySnapshotFromPanel(panel);
    const changedOffice = !officeIdentitySnapshotsMatch(previous, next);
    officeIdentityRef.current = next;
    if (changedOffice) {
      messageOutboxRef.current = null;
      setPendingMessageDelivery(null);
      setDraft("");
    }
  }, [
    panel,
    panel.configPath,
    panel.title,
    panel.workspace?.recordId,
    panel.workspace?.threadId,
  ]);

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
    if (tab === "chat" && membersOpen && onRecruitableAgentList) {
      void loadRecruitableAgents();
    }
  }, [loadRecruitableAgents, membersOpen, onRecruitableAgentList, tab]);

  useEffect(() => {
    if (tab !== "chat") {
      setMembersOpen(false);
    }
  }, [tab]);

  if (!workspace) {
    return null;
  }
  const memberContextRun = latestOfficeTaskRun(workspace.activity?.runs);
  const composerRuntime = deriveOfficeComposerRuntimeState(
    workspace,
    activeTurnByThread,
  );
  const composerRun = composerRuntime.run;

  async function submit(
    submittedDraft = draft,
    mentions: OfficeMessageSubmitMention[] = [],
  ) {
    const outbox = resolveOfficeMessageOutbox(
      messageOutboxRef.current,
      submittedDraft,
      panel,
      createOfficeMessageClientUserMessageId,
      mentions,
    );
    if (!outbox) {
      return;
    }
    messageOutboxRef.current = outbox;
    setIsSendingOfficeMessage(true);
    try {
      const result = await submitOfficeDraft({
        draft: outbox.text,
        isSubmitting: isSendingOfficeMessage,
        onSend: (text) =>
          onSendMessage(text, outbox.clientUserMessageId, outbox.mentions),
        onSuccess: () => {
          if (
            !officePanelMatchesIdentity(panelRef.current, outbox.officeIdentity)
          ) {
            return;
          }
          messageOutboxRef.current = null;
          setPendingMessageDelivery(null);
          setDraft("");
        },
      });
      if (
        result !== false &&
        result.disposition === "retainOutbox" &&
        result.delivery &&
        (result.delivery.type === "queued" ||
          result.delivery.type === "processing") &&
        officePanelMatchesIdentity(panelRef.current, outbox.officeIdentity)
      ) {
        setPendingMessageDelivery(result.delivery);
      }
    } catch {
      // The Office action already reconciles the canonical config and visible
      // error state. Keep the draft/outbox without leaking a rejected promise
      // from the UI event boundary.
    } finally {
      setIsSendingOfficeMessage(false);
    }
  }

  function changeDraft(nextDraft: string) {
    setDraft(nextDraft);
    if (messageOutboxRef.current?.text !== nextDraft.trim()) {
      messageOutboxRef.current = null;
      setPendingMessageDelivery(null);
    }
  }

  async function cancelOfficeRun(run: OfficeRunActivity) {
    if (pendingRunAction) {
      return;
    }
    setPendingRunAction({ runId: run.id });
    try {
      await onRunCancel(run);
    } finally {
      setPendingRunAction(null);
    }
  }

  async function decideMemory(memoryId: string, status: OfficeMemoryStatus) {
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
        activeTab={tab}
        membersOpen={membersOpen}
        panel={panel}
        workspace={workspace}
        locale={locale}
        showMemory={Boolean(onMemoryList)}
        onBack={onBack}
        onMembersToggle={() => setMembersOpen((open) => !open)}
        onTabChange={setTab}
      />

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
      ) : (
        <div
          className="office-room-body"
          data-members-open={membersOpen || undefined}
        >
          <OfficeChatPanel
            workspace={workspace}
            locale={locale}
            onAttachContext={
              onAttachContext
                ? (onSelectPath) =>
                    onAttachContext(panel.workspaceCwd, onSelectPath)
                : undefined
            }
            draft={draft}
            streamRef={streamRef}
            isSubmitting={isSendingOfficeMessage}
            isStopping={
              pendingRunAction?.runId === composerRun?.id
            }
            onDraftChange={changeDraft}
            onStop={
              composerRun
                ? () => cancelOfficeRun(composerRun)
                : undefined
            }
            onSubmit={submit}
            pendingDelivery={pendingMessageDelivery}
            runtimeMode={composerRuntime.mode}
            slashCommands={slashCommands}
          />
          <button
            type="button"
            className="office-members-backdrop"
            aria-label={
              locale === "zh" ? "关闭成员面板" : "Close members panel"
            }
            hidden={!membersOpen}
            onClick={() => setMembersOpen(false)}
          />
          <div className="office-members-drawer" hidden={!membersOpen}>
            <OfficeMembersPanel
              actions={panel.actions}
              workspace={workspace}
              locale={locale}
              contextRun={memberContextRun}
              isLoadingRecruitableAgents={isLoadingRecruitableAgents}
              recruitableAgentError={recruitableAgentError}
              recruitableAgents={recruitableAgents}
              onClose={() => setMembersOpen(false)}
              onMemberContextPreview={onMemberContextPreview}
              onPanelAction={onPanelAction}
              onRefreshRecruitableAgents={loadRecruitableAgents}
            />
          </div>
        </div>
      )}
    </main>
  );
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
