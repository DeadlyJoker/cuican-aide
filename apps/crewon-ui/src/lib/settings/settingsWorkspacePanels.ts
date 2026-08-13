import type { ConfigReadResponse } from "@crewon-ui-model/v2/ConfigReadResponse";
import type { ConversationSummary } from "@crewon-ui-model/ConversationSummary";
import type { Thread } from "@crewon-ui-model/v2/Thread";

import type { GitRemoteDiffSummary } from "../shared/statusTypes";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import { threadTitle } from "../thread/threadModel";

export function gitSettingsText(
  cwd: string | null,
  thread: Thread | null,
  summary: ConversationSummary | null,
  remoteDiff: GitRemoteDiffSummary | null,
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  const threadGit = thread?.gitInfo ?? null;
  const summaryGit = summary?.gitInfo ?? null;
  const branch = threadGit?.branch ?? summaryGit?.branch ?? null;
  const sha = threadGit?.sha ?? summaryGit?.sha ?? remoteDiff?.sha ?? null;
  const origin =
    threadGit?.originUrl ??
    (summaryGit && "origin_url" in summaryGit ? summaryGit.origin_url : null) ??
    null;
  const diffLine =
    remoteDiff?.status === "ready"
      ? `${remoteDiff.files} files · +${remoteDiff.added} -${remoteDiff.removed}`
      : remoteDiff?.status === "loading"
        ? locale === "zh"
          ? "读取中"
          : "loading"
        : remoteDiff?.status === "error"
          ? remoteDiff.error
          : locale === "zh"
            ? "未读取"
            : "not read";

  return [
    locale === "zh" ? "Git 工作区" : "Git workspace",
    `${locale === "zh" ? "路径" : "Path"}: ${cwd ?? (locale === "zh" ? "未选择" : "not selected")}`,
    branch ? `${locale === "zh" ? "分支" : "Branch"}: ${branch}` : null,
    sha ? `SHA: ${sha}` : null,
    origin ? `${locale === "zh" ? "远端" : "Remote"}: ${origin}` : null,
    `${locale === "zh" ? "远端差异" : "Remote diff"}: ${diffLine}`,
    configRead?.config?.approval_policy
      ? `${locale === "zh" ? "审批策略" : "Approval policy"}: ${
          typeof configRead.config.approval_policy === "string"
            ? configRead.config.approval_policy
            : locale === "zh"
              ? "细粒度"
              : "granular"
        }`
      : null,
    configRead?.config?.sandbox_mode
      ? `${locale === "zh" ? "沙箱" : "Sandbox"}: ${configRead.config.sandbox_mode}`
      : null,
    `${locale === "zh" ? "配置层" : "Config layers"}: ${configRead?.layers?.length ?? 0}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function gitDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: "Git",
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function gitMissingWorkspacePanel(locale: Locale): CapabilityPanel {
  return {
    title: "Git",
    subtitle: locale === "zh" ? "未选择工作区" : "No workspace selected",
    error:
      locale === "zh"
        ? "当前没有工作区路径，无法读取 Git 状态。"
        : "No workspace path is available for reading Git status.",
  };
}

export function gitLoadingPanel(cwd: string, locale: Locale): CapabilityPanel {
  return {
    title: "Git",
    subtitle: cwd,
    body: locale === "zh" ? "正在读取 Git 状态..." : "Reading Git status...",
  };
}

export function gitPanel(params: {
  configRead: ConfigReadResponse | null;
  conversationSummary: ConversationSummary | null;
  cwd: string;
  error?: string;
  locale: Locale;
  remoteDiff: GitRemoteDiffSummary | null;
  selectedThread: Thread | null;
}): CapabilityPanel {
  const {
    configRead,
    conversationSummary,
    cwd,
    error,
    locale,
    remoteDiff,
    selectedThread,
  } = params;

  return {
    title: "Git",
    subtitle:
      remoteDiff?.status === "ready"
        ? `${cwd} · +${remoteDiff.added} -${remoteDiff.removed}`
        : cwd,
    body: gitSettingsText(
      cwd,
      selectedThread,
      conversationSummary,
      remoteDiff,
      configRead,
      locale,
    ),
    actions: [
      {
        id: "refresh-git",
        label: locale === "zh" ? "刷新 Git" : "Refresh Git",
      },
    ],
    error,
  };
}

export function worktreesSettingsText(
  cwd: string | null,
  thread: Thread | null,
  relatedThreads: Thread[],
  summary: ConversationSummary | null,
  remoteDiff: GitRemoteDiffSummary | null,
  locale: Locale,
): string {
  const threadGit = thread?.gitInfo ?? null;
  const summaryGit = summary?.gitInfo ?? null;
  const branch = threadGit?.branch ?? summaryGit?.branch ?? null;
  const sha = threadGit?.sha ?? summaryGit?.sha ?? remoteDiff?.sha ?? null;
  const diffLine =
    remoteDiff?.status === "ready"
      ? `${remoteDiff.files} files · +${remoteDiff.added} -${remoteDiff.removed}`
      : remoteDiff?.status === "error"
        ? remoteDiff.error
        : locale === "zh"
          ? "未读取"
          : "not read";
  const currentTitle = thread ? threadTitle(thread, "") : null;
  const relatedLines = relatedThreads.slice(0, 6).map((candidate) => {
    const title = threadTitle(candidate, "") || candidate.id;
    const status =
      typeof candidate.status === "string"
        ? candidate.status
        : JSON.stringify(candidate.status);
    const forked = candidate.forkedFromId
      ? locale === "zh"
        ? " · 分叉"
        : " · fork"
      : "";
    return `- ${title} · ${status}${forked}`;
  });

  return [
    locale === "zh" ? "工作树" : "Worktrees",
    `${locale === "zh" ? "工作区路径" : "Workspace"}: ${
      cwd ?? (locale === "zh" ? "未选择" : "not selected")
    }`,
    currentTitle
      ? `${locale === "zh" ? "当前会话" : "Current session"}: ${currentTitle}`
      : null,
    thread?.id
      ? `${locale === "zh" ? "会话 ID" : "Thread ID"}: ${thread.id}`
      : null,
    thread?.threadSource
      ? `${locale === "zh" ? "来源" : "Source"}: ${thread.threadSource}`
      : null,
    branch ? `${locale === "zh" ? "分支" : "Branch"}: ${branch}` : null,
    sha ? `SHA: ${sha}` : null,
    `${locale === "zh" ? "远端差异" : "Remote diff"}: ${diffLine}`,
    `${locale === "zh" ? "同工作区会话" : "Sessions in workspace"}: ${relatedThreads.length}`,
    relatedLines.length > 0 ? relatedLines.join("\n") : null,
    locale === "zh"
      ? "新建会话会在当前工作区打开独立对话；分叉会话会保留当前上下文，适合并行验证不同方案。"
      : "New sessions open an independent conversation in this workspace. Forked sessions keep the current context for parallel exploration.",
  ]
    .filter(Boolean)
    .join("\n");
}

function worktreesTitle(locale: Locale): string {
  return locale === "zh" ? "工作树" : "Worktrees";
}

export function worktreesDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: worktreesTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function worktreesMissingWorkspacePanel(locale: Locale): CapabilityPanel {
  return {
    title: worktreesTitle(locale),
    subtitle: locale === "zh" ? "未选择工作区" : "No workspace selected",
    error:
      locale === "zh"
        ? "当前没有工作区路径，无法创建工作树会话。"
        : "No workspace path is available for creating worktree sessions.",
  };
}

export function worktreesLoadingPanel(
  cwd: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: worktreesTitle(locale),
    subtitle: cwd,
    body:
      locale === "zh"
        ? "正在读取工作区会话..."
        : "Reading workspace sessions...",
  };
}

export function worktreesPanel(params: {
  conversationSummary: ConversationSummary | null;
  cwd: string;
  error?: string;
  locale: Locale;
  relatedThreads: Thread[];
  remoteDiff: GitRemoteDiffSummary | null;
  selectedThread: Thread | null;
}): CapabilityPanel {
  const {
    conversationSummary,
    cwd,
    error,
    locale,
    relatedThreads,
    remoteDiff,
    selectedThread,
  } = params;

  return {
    title: worktreesTitle(locale),
    subtitle:
      locale === "zh"
        ? `${relatedThreads.length} 个会话 · ${cwd}`
        : `${relatedThreads.length} sessions · ${cwd}`,
    body: worktreesSettingsText(
      cwd,
      selectedThread,
      relatedThreads,
      conversationSummary,
      remoteDiff,
      locale,
    ),
    actions: [
      {
        id: "create-worktree-session",
        label: locale === "zh" ? "新建会话" : "New session",
        tone: "primary",
      },
      {
        id: "fork-worktree",
        label: locale === "zh" ? "分叉当前会话" : "Fork current session",
      },
      {
        id: "refresh-worktrees",
        label: locale === "zh" ? "刷新工作树" : "Refresh worktrees",
      },
    ],
    error,
  };
}

export type WorktreeSessionAction = "create" | "fork";

export function worktreeSessionActionInProgressPanel(params: {
  action: WorktreeSessionAction;
  cwd: string;
  locale: Locale;
}): CapabilityPanel {
  const { action, cwd, locale } = params;
  return {
    title: worktreesTitle(locale),
    subtitle: cwd,
    body:
      action === "fork"
        ? locale === "zh"
          ? "正在分叉当前会话..."
          : "Forking current session..."
        : locale === "zh"
          ? "正在新建工作区会话..."
          : "Creating workspace session...",
    error: undefined,
  };
}

export function worktreeSessionActionInProgressPanelState(
  currentPanel: CapabilityPanel | null,
  params: {
    action: WorktreeSessionAction;
    cwd: string;
    locale: Locale;
  },
): CapabilityPanel {
  const progressPanel = worktreeSessionActionInProgressPanel(params);
  return {
    ...(currentPanel ?? { title: progressPanel.title }),
    ...progressPanel,
  };
}

export function worktreeSessionMissingWorkspaceMessage(locale: Locale): string {
  return locale === "zh"
    ? "当前没有工作区路径，无法创建会话。"
    : "No workspace path is available for creating a session.";
}

export function worktreeSessionForkSelectionMessage(locale: Locale): string {
  return locale === "zh"
    ? "请先选择一个可分叉的对话。"
    : "Select a conversation before forking.";
}

export function worktreeSessionCreateFailureMessage(locale: Locale): string {
  return locale === "zh" ? "创建会话失败" : "Unable to create session";
}

export function worktreeSessionActionFailurePanel(params: {
  error: unknown;
  locale: Locale;
}): Pick<CapabilityPanel, "error" | "title"> {
  const { error, locale } = params;
  return {
    title: worktreesTitle(locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "工作树操作失败"
          : "Worktree action failed",
  };
}

export function worktreeSessionActionFailurePanelState(
  currentPanel: CapabilityPanel | null,
  params: {
    error: unknown;
    locale: Locale;
  },
): CapabilityPanel {
  const errorPanel = worktreeSessionActionFailurePanel(params);
  return {
    ...(currentPanel ?? { title: errorPanel.title }),
    ...errorPanel,
  };
}
