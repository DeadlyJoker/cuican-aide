import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { NoticeState } from "../shared/noticeState";
import type {
  AgentConfig,
  ApprovalRequest,
  LibraryItemAction,
  LibraryPanel,
  LibraryPanelAction,
  OfficeConfig,
  OfficeMember,
  OfficeMessage,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  mergeOfficeMessages,
  officeMessagesFromThread,
  workspaceFromBackendThread,
} from "./officeWorkspace";

type OfficeDetailAction = Extract<LibraryItemAction, { type: "office-detail" }>;
type OfficeRecruitCapabilitySummary = {
  enabledMcp: string;
  enabledSkills: string;
};
type OfficeApprovalDecision = "approved" | "denied";

export function officeCreateTitle(timeLabel: string, locale: Locale): string {
  return locale === "zh"
    ? `新办公室 ${timeLabel}`
    : `New office ${timeLabel}`;
}

export function officeCreateSubtitle(locale: Locale): string {
  return locale === "zh"
    ? "新建办公室 · 配置阶段"
    : "New office · configuration stage";
}

export function officeCreateTurnPrompt(params: {
  locale: Locale;
  title: string;
  workspace: OfficeWorkspace;
}): string {
  const { locale, title, workspace } = params;
  return [
    locale === "zh" ? `创建办公室：${title}` : `Create office: ${title}`,
    locale === "zh" ? "状态：准备创建" : "Status: ready to create",
    locale === "zh" ? `目标：${workspace.goal}` : `Goal: ${workspace.goal}`,
  ].join("\n");
}

export function buildOfficeCreatePanel(params: {
  configPath: string | null | undefined;
  locale: Locale;
  subtitle: string;
  title: string;
  workspace: OfficeWorkspace;
}): LibraryPanel {
  const { configPath, locale, subtitle, title, workspace } = params;
  return {
    kind: "office",
    title,
    subtitle,
    configPath: configPath ?? undefined,
    body: configPath
      ? locale === "zh"
        ? "办公室已保存。"
        : "Office saved."
      : undefined,
    items: [],
    actions: [
      {
        id: "recruit-agent",
        label: locale === "zh" ? "招募智能体" : "Recruit agent",
        tone: "primary",
      },
    ],
    workspace,
  };
}

export function officeCreateFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "创建办公室失败"
      : "Unable to create office";
}

export function officeCreateFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text: officeCreateFailureMessage(error, locale),
    tone: "warning",
  };
}

export function officeCreateFailurePanel(
  panel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        error: officeCreateFailureMessage(error, locale),
      }
    : panel;
}

export function officeRecruitMissingAgentNotice(locale: Locale): string {
  return locale === "zh"
    ? "没有可招募的后端智能体。请先在智能体库中新建并保存智能体，再招募进办公室。"
    : "No backend agent is available to recruit. Create and save an agent in the agent library first, then recruit it into the office.";
}

export function officeRecruitUnavailableNoticeState(
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? "连接 App Server 后才能招募真实智能体；当前办公室不会创建演示成员。"
        : "Connect to the App Server to recruit a real agent; the Office will not create demo members.",
    tone: "warning",
  };
}

export function officeRecruitMissingAgentNoticeState(
  locale: Locale,
): NoticeState {
  return {
    text: officeRecruitMissingAgentNotice(locale),
    tone: "warning",
  };
}

export function officeRecruitPersistenceWarning(locale: Locale): string {
  return locale === "zh"
    ? "招募智能体未写入后端办公室配置，请稍后重试。"
    : "Agent recruitment was not written to the backend office config. Try again later.";
}

export function officeRecruitPersistenceWarningNotice(
  locale: Locale,
): NoticeState {
  return {
    text: officeRecruitPersistenceWarning(locale),
    tone: "warning",
  };
}

export function officeRecruitFallbackError(locale: Locale): string {
  return locale === "zh"
    ? "招募智能体写入后端失败"
    : "Unable to write agent recruitment to backend";
}

export function officeRecruitFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error ? error.message : officeRecruitFallbackError(locale),
    tone: "warning",
  };
}

export function officeRecruitSuccessNotice(
  memberName: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `已招募 ${memberName}，并写入后端办公室配置`
    : `Recruited ${memberName} and wrote it to the backend office config`;
}

export function officeRecruitSuccessNoticeState(
  memberName: string,
  locale: Locale,
): NoticeState {
  return {
    text: officeRecruitSuccessNotice(memberName, locale),
    tone: "success",
  };
}

export function officeRecruitCapabilitySummary(
  agent: AgentConfig,
): OfficeRecruitCapabilitySummary {
  return {
    enabledMcp: agent.mcp
      .filter((option) => option.enabled)
      .map((option) => option.name)
      .join(", "),
    enabledSkills: agent.skills
      .filter((option) => option.enabled)
      .map((option) => option.name)
      .join(", "),
  };
}

export function officeRecruitJoinMessage(params: {
  agent: AgentConfig;
  enabledMcp: string;
  enabledSkills: string;
  locale: Locale;
  member: OfficeMember;
}): OfficeMessage {
  const { agent, enabledMcp, enabledSkills, locale, member } = params;
  return {
    author: locale === "zh" ? "系统" : "System",
    glyph: "⌗",
    accent: "slate",
    time: locale === "zh" ? "现在" : "now",
    kind: "system",
    text:
      locale === "zh"
        ? [
            `已从智能体库招募 ${member.name}（模型 ${agent.model}）。`,
            enabledMcp ? `已启用 MCP：${enabledMcp}。` : "",
            enabledSkills ? `已启用 Skill：${enabledSkills}。` : "",
          ]
            .filter(Boolean)
            .join(" ")
        : [
            `Recruited ${member.name} from agents (model ${agent.model}).`,
            enabledMcp ? `MCP: ${enabledMcp}.` : "",
            enabledSkills ? `Skills: ${enabledSkills}.` : "",
          ]
            .filter(Boolean)
            .join(" "),
  };
}

export function officeWorkspaceWithRecruitMessage(
  workspace: OfficeWorkspace,
  message: OfficeMessage,
): OfficeWorkspace {
  return {
    ...workspace,
    messages: [...workspace.messages, message],
  };
}

export function officeRecruitSavedPanel(
  panel: LibraryPanel | null,
  params: {
    config: OfficeConfig;
    threadId: string | null;
  },
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        ...(params.threadId
          ? officeWorkspaceConnectedPatch(params.config.workspace, params.threadId)
          : { workspace: params.config.workspace }),
      }
    : panel;
}

export function officeRecruitTurnPrompt(params: {
  agent: AgentConfig;
  enabledMcp: string;
  enabledSkills: string;
  locale: Locale;
  member: OfficeMember;
  officeTitle: string;
  threadId: string;
}): string {
  const {
    agent,
    enabledMcp,
    enabledSkills,
    locale,
    member,
    officeTitle,
  } = params;
  return [
    locale === "zh"
      ? `办公室「${officeTitle}」招募智能体：${member.name}，角色：${member.role}。模型：${agent.model}。MCP：${enabledMcp || "无"}。Skill：${enabledSkills || "无"}。请把它纳入后续协作。`
      : `Office "${officeTitle}" recruited agent: ${member.name}, role: ${member.role}. Model: ${agent.model}. MCP: ${enabledMcp || "none"}. Skills: ${enabledSkills || "none"}. Include it in future collaboration.`,
    locale === "zh" ? "状态：成员已加入办公室" : "Status: member added",
  ].join("\n");
}

export function officeWorkspaceConnected(
  workspace: OfficeWorkspace,
  threadId: string,
): OfficeWorkspace {
  return {
    ...workspace,
    threadId,
    backendStatus: "connected",
  };
}

export function officeWorkspaceConnectedPatch(
  workspace: OfficeWorkspace,
  threadId: string,
): Partial<LibraryPanel> {
  return {
    workspace: officeWorkspaceConnected(workspace, threadId),
  };
}

export function officeWorkspaceConnectedPanel(
  panel: LibraryPanel | null,
  workspace: OfficeWorkspace,
  threadId: string,
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        ...officeWorkspaceConnectedPatch(workspace, threadId),
      }
    : panel;
}

export function matchingOfficeWorkspaceConnectedPanel(
  panel: LibraryPanel | null,
  workspace: OfficeWorkspace,
  threadId: string,
): LibraryPanel | null {
  return panel?.kind === "office" && panel.workspace?.threadId === threadId
    ? {
        ...panel,
        ...officeWorkspaceConnectedPatch(workspace, threadId),
      }
    : panel;
}

export function officeThreadBindingPatch(
  workspace: OfficeWorkspace,
): Partial<LibraryPanel> {
  return {
    workspace: {
      ...workspace,
      threadId: undefined,
      backendStatus: "binding",
    },
  };
}

export function officeThreadBindingPanel(
  panel: LibraryPanel | null,
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        ...officeThreadBindingPatch(panel.workspace),
      }
    : panel;
}

export function officeThreadBoundPatch(params: {
  locale: Locale;
  subtitle: string;
  threadId: string;
  workspace: OfficeWorkspace;
}): Partial<LibraryPanel> {
  const { locale, subtitle, threadId, workspace } = params;
  const normalizedSubtitle = subtitle
    .replace(" · 已绑定后端线程", "")
    .replace(" · backend thread bound", "");
  return {
    subtitle:
      normalizedSubtitle.includes("运行已连接") ||
      normalizedSubtitle.includes("runtime connected")
        ? normalizedSubtitle
        : locale === "zh"
          ? `${normalizedSubtitle} · 运行已连接`
          : `${normalizedSubtitle} · runtime connected`,
    workspace: officeWorkspaceConnected(workspace, threadId),
  };
}

export function officeThreadBoundPanel(
  panel: LibraryPanel | null,
  params: {
    config?: OfficeConfig;
    filePath?: string | null;
    locale: Locale;
    threadId: string;
  },
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        ...(params.filePath ? { configPath: params.filePath } : {}),
        ...officeThreadBoundPatch({
          locale: params.locale,
          subtitle: params.config?.subtitle ?? panel.subtitle,
          threadId: params.threadId,
          workspace: params.config?.workspace ?? panel.workspace,
        }),
        title: params.config?.title ?? panel.title,
      }
    : panel;
}

export function officeBindThreadTurnPrompt(params: {
  config: OfficeConfig;
  locale: Locale;
  officeConfigPath: string | null | undefined;
  panel: Pick<LibraryPanel, "title">;
}): string {
  const { config, locale, panel } = params;
  return [
    locale === "zh"
      ? `绑定办公室：${panel.title}`
      : `Bind office: ${panel.title}`,
    locale === "zh" ? "状态：办公室已保存" : "Status: office saved",
    locale === "zh"
      ? `目标：${config.workspace.goal}`
      : `Goal: ${config.workspace.goal}`,
  ].join("\n");
}

export function officeApprovalDecisionLabel(
  approval: ApprovalRequest | null | undefined,
): string {
  return approval ? `${approval.actor} · ${approval.action}` : "";
}

export function officeApprovalNotice(params: {
  decision: OfficeApprovalDecision;
  label: string;
  locale: Locale;
}): string {
  const { decision, label, locale } = params;
  return locale === "zh"
    ? `${decision === "approved" ? "已批准" : "已拒绝"}：${label}`
    : `${decision === "approved" ? "Approved" : "Denied"}: ${label}`;
}

export function officeApprovalDecisionNotice(params: {
  approval: ApprovalRequest | null;
  decision: OfficeApprovalDecision;
  locale: Locale;
}): NoticeState {
  const { approval, decision, locale } = params;
  return {
    text: officeApprovalNotice({
      decision,
      label: officeApprovalDecisionLabel(approval),
      locale,
    }),
    tone: decision === "approved" ? "success" : "warning",
  };
}

export function officeApprovalSystemMessage(params: {
  approval: ApprovalRequest;
  decision: OfficeApprovalDecision;
  locale: Locale;
}): OfficeMessage {
  const { approval, decision, locale } = params;
  return {
    author: locale === "zh" ? "系统" : "System",
    glyph: "⌗",
    accent: decision === "approved" ? "green" : "rose",
    time: locale === "zh" ? "现在" : "now",
    kind: "system",
    text:
      locale === "zh"
        ? `${decision === "approved" ? "已批准" : "已拒绝"}审批：${approval.actor} · ${approval.action}`
        : `${decision === "approved" ? "Approved" : "Denied"} approval: ${approval.actor} · ${approval.action}`,
  };
}

export function officeWorkspaceWithApprovalDecision(params: {
  decision: OfficeApprovalDecision;
  message?: OfficeMessage | null;
  requestId: string;
  workspace: OfficeWorkspace;
}): OfficeWorkspace {
  const { decision, message, requestId, workspace } = params;
  const activity = workspace.activity
      ? {
          ...workspace.activity,
          approvals: (workspace.activity.approvals ?? []).map((request) =>
            request.id === requestId ? { ...request, decision } : request,
          ),
        }
    : undefined;
  return {
    ...workspace,
    activity,
    messages: message ? [...workspace.messages, message] : workspace.messages,
  };
}

export function officeApprovalFallbackError(locale: Locale): string {
  return locale === "zh"
    ? "审批决策写入后端失败"
    : "Unable to write approval decision to backend";
}

export function officeApprovalFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error ? error.message : officeApprovalFallbackError(locale),
    tone: "warning",
  };
}

export function officeApprovalLocalDecisionPanel(
  panel: LibraryPanel | null,
  params: {
    decision: OfficeApprovalDecision;
    requestId: string;
  },
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        workspace: officeWorkspaceWithApprovalDecision({
          decision: params.decision,
          requestId: params.requestId,
          workspace: panel.workspace,
        }),
      }
    : panel;
}

export function officeApprovalOptimisticPanel(
  panel: LibraryPanel | null,
  params: {
    decision: OfficeApprovalDecision;
    message: OfficeMessage;
    requestId: string;
    workspace: OfficeWorkspace;
  },
): LibraryPanel | null {
  if (!panel?.workspace) {
    return panel;
  }
  const nextWorkspace = officeWorkspaceWithApprovalDecision({
    decision: params.decision,
    message: params.message,
    requestId: params.requestId,
    workspace: params.workspace,
  });
  return {
    ...panel,
    workspace: {
      ...nextWorkspace,
      threadId: panel.workspace.threadId,
      backendStatus: panel.workspace.backendStatus,
    },
  };
}

export function officeApprovalSavedPanel(
  panel: LibraryPanel | null,
  params: {
    config: OfficeConfig;
    threadId: string;
  },
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        workspace: officeWorkspaceConnected(params.config.workspace, params.threadId),
      }
    : panel;
}

export function buildOfficeDetailPanel(
  action: OfficeDetailAction,
  config: OfficeConfig | null,
  locale: Locale,
): LibraryPanel {
  const workspace = config?.workspace ?? action.workspace;
  const title = config?.title ?? action.title;
  const subtitle = config?.subtitle ?? action.subtitle;
  return {
    kind: "office",
    title,
    subtitle,
    configPath: action.configPath,
    workspaceCwd: action.workspaceCwd,
    body: workspace ? undefined : action.body,
    actions: officeDetailActions(action, locale),
    items: action.items,
    workspace,
  };
}

export function officeDetailPanelPatch(panel: LibraryPanel): Partial<LibraryPanel> {
  return {
    ...panel,
    error: undefined,
  };
}

export function officeDetailPanel(
  currentPanel: LibraryPanel | null,
  nextPanel: LibraryPanel,
): LibraryPanel | null {
  return currentPanel
    ? {
        ...currentPanel,
        ...officeDetailPanelPatch(nextPanel),
      }
    : currentPanel;
}

export function matchingOfficeDetailPanel(
  currentPanel: LibraryPanel | null,
  title: string,
  nextPanel: LibraryPanel,
): LibraryPanel | null {
  return currentPanel?.kind === "office" && currentPanel.title === title
    ? {
        ...currentPanel,
        ...officeDetailPanelPatch(nextPanel),
      }
    : currentPanel;
}

export function officeDetailHydratedThreadPatch(params: {
  fallbackWorkspace?: OfficeWorkspace;
  latestPanel: LibraryPanel;
  locale: Locale;
  thread: Thread;
}): Partial<LibraryPanel> {
  const { fallbackWorkspace, latestPanel, locale, thread } = params;
  const latestWorkspace = latestPanel.workspace ?? fallbackWorkspace;
  return {
    title: latestPanel.title,
    subtitle: latestPanel.subtitle,
    body: undefined,
    error: undefined,
    workspace: latestWorkspace
      ? {
          ...latestWorkspace,
          messages: mergeOfficeMessages(
            latestWorkspace.messages,
            officeMessagesFromThread(thread, locale),
          ),
          tasks:
            latestWorkspace.tasks.length > 0
              ? latestWorkspace.tasks
              : workspaceFromBackendThread(thread, locale).tasks,
        }
      : workspaceFromBackendThread(thread, locale),
  };
}

export function officeDetailHydratedThreadPanel(
  currentPanel: LibraryPanel | null,
  threadId: string,
  params: {
    fallbackWorkspace?: OfficeWorkspace;
    latestPanel: LibraryPanel;
    locale: Locale;
    thread: Thread;
  },
): LibraryPanel | null {
  return currentPanel?.workspace?.threadId === threadId
    ? {
        ...currentPanel,
        ...officeDetailHydratedThreadPatch(params),
      }
    : currentPanel;
}

export function officeDetailBindFailurePatch(params: {
  error: unknown;
  locale: Locale;
  workspace: OfficeWorkspace;
}): Partial<LibraryPanel> {
  const { error, locale, workspace } = params;
  return {
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "绑定办公室线程失败"
          : "Unable to bind office thread",
    workspace: {
      ...workspace,
      backendStatus: "error",
    },
  };
}

export function officeDetailBindFailurePanel(
  currentPanel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return currentPanel?.workspace
    ? {
        ...currentPanel,
        ...officeDetailBindFailurePatch({
          error,
          locale,
          workspace: currentPanel.workspace,
        }),
      }
    : currentPanel;
}

function officeDetailActions(
  action: OfficeDetailAction,
  locale: Locale,
): LibraryPanelAction[] {
  const actions: LibraryPanelAction[] = [{
    id: "recruit-agent",
    label: locale === "zh" ? "招募智能体" : "Recruit agent",
    tone: "primary",
  }];

  if (action.configPath) {
    actions.push({
      id: "delete-config-file",
      label: locale === "zh" ? "删除办公室" : "Delete office",
      pathToOpen: action.configPath,
      pathKind: "file",
      domainConfigKind: "office",
      tone: "danger",
    });
  }

  return actions;
}
