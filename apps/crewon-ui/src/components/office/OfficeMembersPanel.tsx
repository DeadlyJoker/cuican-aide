import { Eye, LoaderCircle, RefreshCw, UserPlus, X } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import type {
  AgentConfig,
  LibraryPanel,
  OfficeMember,
  OfficeMemberContextPreview,
  OfficeRunActivity,
  OfficeWorkspace,
} from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";

export function OfficeMembersPanel({
  actions,
  contextRun,
  isLoadingRecruitableAgents,
  recruitableAgentError,
  recruitableAgents,
  workspace,
  locale,
  onMemberContextPreview,
  onPanelAction,
  onRefreshRecruitableAgents,
}: {
  actions: LibraryPanel["actions"];
  contextRun?: OfficeRunActivity | null;
  isLoadingRecruitableAgents?: boolean;
  recruitableAgentError?: string | null;
  recruitableAgents?: AgentConfig[];
  workspace: OfficeWorkspace;
  locale: Locale;
  onMemberContextPreview?: (
    run: OfficeRunActivity,
    member: OfficeMember,
  ) => Promise<OfficeMemberContextPreview | null>;
  onPanelAction: LibraryPanelActionCallback;
  onRefreshRecruitableAgents?: () => Promise<void> | void;
}) {
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [contextPreview, setContextPreview] = useState<{
    memberKey: string;
    loading: boolean;
    preview: OfficeMemberContextPreview | null;
    error: string | null;
  } | null>(null);
  const isZh = locale === "zh";
  const recruitAction = actions?.find((action) => action.id === "recruit-agent");
  const secondaryActions = actions?.filter(
    (action) => action.id !== "recruit-agent",
  );
  const agents = (recruitableAgents ?? []).filter(
    (agent): agent is AgentConfig & { agentId: string } =>
      Boolean(agent.agentId),
  );
  const selectedAgent =
    agents.find((agent) => agent.agentId === selectedAgentId) ?? agents[0];

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId("");
      return;
    }
    if (!agents.some((agent) => agent.agentId === selectedAgentId)) {
      setSelectedAgentId(agents[0]?.agentId ?? "");
    }
  }, [agents, selectedAgentId]);

  async function previewMemberContext(member: OfficeMember, memberKey: string) {
    if (!contextRun || !onMemberContextPreview) {
      return;
    }
    const isOpen = contextPreview?.memberKey === memberKey;
    if (isOpen && contextPreview.preview && !contextPreview.loading) {
      setContextPreview(null);
      return;
    }
    setContextPreview({
      memberKey,
      loading: true,
      preview: null,
      error: null,
    });
    try {
      const preview = await onMemberContextPreview(contextRun, member);
      setContextPreview({
        memberKey,
        loading: false,
        preview,
        error: preview
          ? null
          : isZh
            ? "暂无可用上下文预览。"
            : "No context preview is available.",
      });
    } catch (error) {
      setContextPreview({
        memberKey,
        loading: false,
        preview: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function recruitSelectedAgent() {
    if (!recruitAction || !selectedAgent) {
      return;
    }
    setPendingActionId("recruit-agent");
    try {
      await onPanelAction({
        ...recruitAction,
        agentConfig: selectedAgent,
        label:
          locale === "zh"
            ? `招募 ${selectedAgent.name}`
            : `Recruit ${selectedAgent.name}`,
      });
      await onRefreshRecruitableAgents?.();
    } finally {
      setPendingActionId(null);
    }
  }

  return (
    <aside
      className="office-members"
      aria-label={locale === "zh" ? "成员" : "Members"}
    >
      <div className="office-rail-head">
        <strong>{locale === "zh" ? "成员" : "Members"}</strong>
        <span>{workspace.members.length}</span>
      </div>
      {workspace.members.map((member, index) => {
        const memberKey = member.agentId ?? `${member.name}:${index}`;
        const canPreview = Boolean(contextRun && onMemberContextPreview);
        const previewOpen = contextPreview?.memberKey === memberKey;
        return (
          <Fragment key={memberKey}>
            <div
              className="office-member"
              data-preview-open={previewOpen ? "true" : undefined}
            >
              <span
                className="office-avatar"
                data-accent={member.accent}
                aria-hidden="true"
              >
                {member.glyph}
                <i
                  className="office-presence"
                  data-online={member.online ?? true}
                />
              </span>
              <span className="office-member-text">
                <strong>{member.name}</strong>
                <span>{member.role}</span>
                <em>{member.status}</em>
                {member.runtime?.contextPolicy || member.runtime?.memoryScope ? (
                  <small>
                    {[
                      member.runtime?.contextPolicy,
                      member.runtime?.memoryScope,
                    ]
                      .filter(Boolean)
                      .join(" / ")}
                  </small>
                ) : null}
              </span>
              {canPreview ? (
                <button
                  type="button"
                  className="office-member-context-button"
                  title={
                    isZh ? "预览成员上下文" : "Preview member context"
                  }
                  aria-label={
                    isZh ? "预览成员上下文" : "Preview member context"
                  }
                  aria-expanded={previewOpen}
                  disabled={contextPreview?.loading}
                  onClick={() => void previewMemberContext(member, memberKey)}
                >
                  {previewOpen && contextPreview.loading ? (
                    <LoaderCircle size={15} aria-hidden="true" />
                  ) : (
                    <Eye size={15} aria-hidden="true" />
                  )}
                </button>
              ) : null}
            </div>
            {previewOpen ? (
              <MemberContextPreviewCard
                locale={locale}
                preview={contextPreview.preview}
                error={contextPreview.error}
                loading={contextPreview.loading}
                onClose={() => setContextPreview(null)}
              />
            ) : null}
          </Fragment>
        );
      })}
      {recruitAction || onRefreshRecruitableAgents ? (
        <div className="office-recruit">
          <div className="office-rail-head">
            <strong>{isZh ? "选择智能体" : "Choose agent"}</strong>
            <button
              type="button"
              disabled={isLoadingRecruitableAgents}
              title={isZh ? "刷新智能体" : "Refresh agents"}
              aria-label={isZh ? "刷新智能体" : "Refresh agents"}
              onClick={() => void onRefreshRecruitableAgents?.()}
            >
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          </div>
          {recruitableAgentError ? (
            <p className="office-recruit-error">{recruitableAgentError}</p>
          ) : null}
          {agents.length > 0 ? (
            <select
              value={selectedAgent?.agentId ?? ""}
              disabled={pendingActionId !== null}
              aria-label={isZh ? "可招募智能体" : "Recruitable agents"}
              onChange={(event) => setSelectedAgentId(event.target.value)}
            >
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name} · {agent.role}
                </option>
              ))}
            </select>
          ) : (
            <p className="office-recruit-empty">
              {isLoadingRecruitableAgents
                ? isZh
                  ? "正在读取可招募智能体..."
                  : "Loading recruitable agents..."
                : isZh
                  ? "暂无可招募智能体。"
                  : "No recruitable agents yet."}
            </p>
          )}
          {recruitAction ? (
            <button
              type="button"
              data-tone={recruitAction.tone}
              disabled={
                pendingActionId !== null ||
                isLoadingRecruitableAgents ||
                !selectedAgent
              }
              onClick={() => void recruitSelectedAgent()}
            >
              <UserPlus size={14} aria-hidden="true" />
              {pendingActionId === "recruit-agent"
                ? isZh
                  ? "招募中..."
                  : "Recruiting..."
                : isZh
                  ? "加入成员"
                  : "Add member"}
            </button>
          ) : null}
        </div>
      ) : null}
      {secondaryActions && secondaryActions.length > 0 ? (
        <div className="office-rail-actions">
          {secondaryActions.map((action) => (
            <button
              type="button"
              data-tone={action.tone}
              key={action.id}
              disabled={pendingActionId !== null}
              onClick={async () => {
                setPendingActionId(action.id);
                try {
                  await onPanelAction(action);
                } finally {
                  setPendingActionId(null);
                }
              }}
            >
              {pendingActionId === action.id ? `${action.label}…` : action.label}
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function MemberContextPreviewCard({
  error,
  loading,
  locale,
  preview,
  onClose,
}: {
  error: string | null;
  loading: boolean;
  locale: Locale;
  preview: OfficeMemberContextPreview | null;
  onClose: () => void;
}) {
  const isZh = locale === "zh";
  return (
    <div className="office-member-context-preview">
      <div className="office-member-context-head">
        <strong>{isZh ? "上下文预览" : "Context preview"}</strong>
        <button
          type="button"
          title={isZh ? "关闭" : "Close"}
          aria-label={isZh ? "关闭" : "Close"}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {loading ? (
        <p>{isZh ? "加载中…" : "Loading…"}</p>
      ) : error ? (
        <p>{error}</p>
      ) : preview ? (
        <>
          <div className="office-member-context-meta">
            <span>{preview.contextPolicy}</span>
            <span>{preview.memoryScope}</span>
            <span>{preview.threadId}</span>
          </div>
          <PreviewBlock
            title={isZh ? "共享摘要" : "Shared digest"}
            value={preview.sharedContext}
          />
          <PreviewBlock
            title={isZh ? "长期记忆" : "Long-term memory"}
            value={preview.memoryContext}
          />
        </>
      ) : null}
    </div>
  );
}

function PreviewBlock({ title, value }: { title: string; value: string }) {
  return (
    <section className="office-member-context-block">
      <strong>{title}</strong>
      <pre>{value}</pre>
    </section>
  );
}
