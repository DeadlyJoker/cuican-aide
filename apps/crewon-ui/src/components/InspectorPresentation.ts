import type { ConversationSummary } from "@crewon/app-server-protocol/ConversationSummary";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import type { Locale } from "../lib/i18n";
import type {
  AccountStatus,
  GitRemoteDiffSummary,
} from "../lib/shared/statusTypes";

export function inspectorCopy(locale: Locale) {
  return locale === "zh"
    ? {
        title: "环境信息",
        changes: "变更",
        remoteChanges: "远端差异",
        local: "本地",
        branch: "分支",
        submit: "提交或推送",
        remote: "远端",
        progress: "进度",
        summary: "会话摘要",
        task: "任务",
        source: "来源",
        goal: "目标",
        account: "账号",
        noTask: "暂无任务",
        current: "当前会话",
        noThread: "等待新任务",
        commands: "命令",
        status: "状态",
        noGit: "未检测到 Git",
        loading: "读取中",
        filesChanged: "文件",
        noSummary: "暂无摘要",
        noGoal: "未设置",
        loadedThreads: "已加载",
        tokens: "tokens",
      }
    : {
        title: "Environment",
        changes: "Changes",
        remoteChanges: "Remote diff",
        local: "Local",
        branch: "Branch",
        submit: "Submit or push",
        remote: "Remote",
        progress: "Progress",
        summary: "Summary",
        task: "Task",
        source: "Sources",
        goal: "Goal",
        account: "Account",
        noTask: "No active task",
        current: "Current session",
        noThread: "Waiting for a task",
        commands: "Commands",
        status: "Status",
        noGit: "No Git metadata",
        loading: "Loading",
        filesChanged: "files",
        noSummary: "No summary",
        noGoal: "Not set",
        loadedThreads: "Loaded",
        tokens: "tokens",
      };
}

function workspaceName(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  return segments.at(-1) ?? cwd;
}

function countItems(thread: Thread | null, type: string): number {
  return (
    thread?.turns.reduce(
      (count, turn) =>
        count + turn.items.filter((item) => item.type === type).length,
      0,
    ) ?? 0
  );
}

function countChangedFiles(thread: Thread | null): number {
  return (
    thread?.turns.reduce(
      (count, turn) =>
        count +
        turn.items.reduce(
          (itemCount, item) =>
            item.type === "fileChange"
              ? itemCount + item.changes.length
              : itemCount,
          0,
        ),
      0,
    ) ?? 0
  );
}

function diffStats(thread: Thread | null): { added: number; removed: number } {
  return (
    thread?.turns.reduce(
      (stats, turn) =>
        turn.items.reduce((nextStats, item) => {
          if (item.type !== "fileChange") {
            return nextStats;
          }

          return item.changes.reduce((changeStats, change) => {
            const lines = change.diff.split("\n");
            const added = lines.filter(
              (line) => line.startsWith("+") && !line.startsWith("+++"),
            ).length;
            const removed = lines.filter(
              (line) => line.startsWith("-") && !line.startsWith("---"),
            ).length;
            return {
              added: changeStats.added + added,
              removed: changeStats.removed + removed,
            };
          }, nextStats);
        }, stats),
      { added: 0, removed: 0 },
    ) ?? { added: 0, removed: 0 }
  );
}

function latestCommand(thread: Thread | null): string | null {
  if (!thread) {
    return null;
  }

  for (const turn of [...thread.turns].reverse()) {
    for (const item of [...turn.items].reverse()) {
      if (item.type === "commandExecution") {
        return item.command;
      }
    }
  }

  return null;
}

function accountLabel(
  accountStatus: AccountStatus | null,
  locale: Locale,
): string {
  if (!accountStatus) {
    return locale === "zh" ? "读取中" : "Loading";
  }

  if (!accountStatus.account) {
    return accountStatus.requiresOpenaiAuth
      ? locale === "zh"
        ? "需要登录"
        : "Auth required"
      : locale === "zh"
        ? "未登录"
        : "Signed out";
  }

  switch (accountStatus.account.type) {
    case "apiKey":
      return "API Key";
    case "amazonBedrock":
      return "Bedrock";
    case "chatgpt":
      return `${accountStatus.account.email} · ${accountStatus.account.planType}`;
  }
}

type InspectorPresentationParams = {
  account: AccountStatus | null;
  conversationSummary: ConversationSummary | null;
  gitRemoteDiff: GitRemoteDiffSummary | null;
  locale: Locale;
  serverUrl: string;
  thread: Thread | null;
  threadGoal: ThreadGoalView | null;
};

export function inspectorPresentation({
  account,
  conversationSummary,
  gitRemoteDiff,
  locale,
  serverUrl,
  thread,
  threadGoal,
}: InspectorPresentationParams) {
  const copy = inspectorCopy(locale);
  const changedFiles = countChangedFiles(thread);
  const changes = diffStats(thread);
  const displayChanges =
    gitRemoteDiff?.status === "ready"
      ? gitRemoteDiff
      : { ...changes, files: changedFiles };
  const remoteDiffLabel =
    gitRemoteDiff?.status === "loading"
      ? copy.loading
      : gitRemoteDiff?.status === "error"
        ? gitRemoteDiff.error
        : gitRemoteDiff?.status === "ready"
          ? `${gitRemoteDiff.files} ${copy.filesChanged}${gitRemoteDiff.sha ? ` · ${gitRemoteDiff.sha.slice(0, 7)}` : ""}`
          : copy.noGit;
  const commands = countItems(thread, "commandExecution");
  const totalItems =
    thread?.turns.reduce((count, turn) => count + turn.items.length, 0) ?? 0;

  return {
    accountLabel: accountLabel(account, locale),
    branch:
      thread?.gitInfo?.branch ??
      thread?.gitInfo?.sha?.slice(0, 7) ??
      copy.noGit,
    command: latestCommand(thread),
    commands,
    copy,
    displayChanges,
    remote: thread?.gitInfo?.originUrl ?? copy.noGit,
    remoteDiffLabel,
    statusLabel: thread?.status.type ?? copy.noThread,
    summaryLabel: conversationSummary?.preview || copy.noSummary,
    taskGoalLabel: threadGoal?.objective || copy.noGoal,
    totalItems,
    workspaceLabel: thread?.cwd
      ? workspaceName(thread.cwd)
      : serverUrl.replace(/^wss?:\/\//, ""),
  };
}
