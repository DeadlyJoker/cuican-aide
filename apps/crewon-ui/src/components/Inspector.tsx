import {
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Github,
  GitPullRequestArrow,
  Globe2,
  HardDrive,
  Laptop,
  ListTodo,
  ShieldCheck,
  Settings2,
  Terminal,
} from "lucide-react";
import type { Account } from "@crewon-protocol/v2/Account";
import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";
import type { Locale } from "../lib/i18n";

export type AccountStatus = {
  account: Account | null;
  requiresOpenaiAuth: boolean;
};

export type GitRemoteDiffSummary = {
  status: "loading" | "ready" | "error";
  added: number;
  removed: number;
  files: number;
  sha?: string;
  error?: string;
};

type InspectorProps = {
  account: AccountStatus | null;
  conversationSummary: ConversationSummary | null;
  gitRemoteDiff: GitRemoteDiffSummary | null;
  loadedThreadIds: string[];
  locale: Locale;
  serverUrl: string;
  thread: Thread | null;
  threadGoal: ThreadGoal | null;
};

function workspaceName(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  return segments.at(-1) ?? cwd;
}

function countItems(thread: Thread | null, type: string): number {
  return thread?.turns.reduce((count, turn) => count + turn.items.filter((item) => item.type === type).length, 0) ?? 0;
}

function countChangedFiles(thread: Thread | null): number {
  return (
    thread?.turns.reduce(
      (count, turn) =>
        count +
        turn.items.reduce((itemCount, item) => (item.type === "fileChange" ? itemCount + item.changes.length : itemCount), 0),
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
            const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
            const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
            return { added: changeStats.added + added, removed: changeStats.removed + removed };
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

function accountLabel(accountStatus: AccountStatus | null, locale: Locale): string {
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

export function Inspector({ account, conversationSummary, gitRemoteDiff, loadedThreadIds, locale, serverUrl, thread, threadGoal }: InspectorProps) {
  const copy =
    locale === "zh"
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

  const changedFiles = countChangedFiles(thread);
  const changes = diffStats(thread);
  const displayChanges = gitRemoteDiff?.status === "ready" ? gitRemoteDiff : { ...changes, files: changedFiles };
  const remoteDiffLabel =
    gitRemoteDiff?.status === "loading"
      ? copy.loading
      : gitRemoteDiff?.status === "error"
        ? gitRemoteDiff.error
        : gitRemoteDiff?.status === "ready"
          ? `${gitRemoteDiff.files} ${copy.filesChanged}${gitRemoteDiff.sha ? ` · ${gitRemoteDiff.sha.slice(0, 7)}` : ""}`
          : copy.noGit;
  const commands = countItems(thread, "commandExecution");
  const totalItems = thread?.turns.reduce((count, turn) => count + turn.items.length, 0) ?? 0;
  const command = latestCommand(thread);
  const branch = thread?.gitInfo?.branch ?? thread?.gitInfo?.sha?.slice(0, 7) ?? copy.noGit;
  const remote = thread?.gitInfo?.originUrl ?? copy.noGit;
  const statusLabel = thread?.status.type ?? copy.noThread;

  return (
    <aside className="inspector" aria-label={copy.title}>
      <div className="inspector-panel">
        <section className="inspector-section">
          <div className="inspector-card-header">
            <strong>{copy.title}</strong>
            <Settings2 size={14} />
          </div>
          <div className="inspector-row">
            <Box size={14} />
            <span>{copy.changes}</span>
            <strong className="inspector-diff-stat">
              <span data-tone="added">+{displayChanges.added || displayChanges.files}</span>
              <span data-tone="removed">-{displayChanges.removed}</span>
            </strong>
          </div>
          <div className="inspector-row">
            <GitPullRequestArrow size={14} />
            <span>{copy.remoteChanges}</span>
            <strong title={remoteDiffLabel}>{remoteDiffLabel}</strong>
          </div>
          <div className="inspector-row">
            <Laptop size={14} />
            <span>{copy.local}</span>
            <strong>
              {thread?.cwd ? workspaceName(thread.cwd) : serverUrl.replace(/^wss?:\/\//, "")}
              <ChevronDown size={11} />
            </strong>
          </div>
          <div className="inspector-row">
            <GitBranch size={14} />
            <span>{copy.branch}</span>
            <strong>
              {branch}
              <ChevronDown size={11} />
            </strong>
          </div>
          <div className="inspector-row">
            <GitPullRequestArrow size={14} />
            <span>{copy.submit}</span>
          </div>
          <div className="inspector-row">
            <CheckCircle2 size={14} />
            <span>{copy.status}</span>
            <strong>{statusLabel}</strong>
          </div>
          <div className="inspector-row">
            <HardDrive size={14} />
            <span>{copy.loadedThreads}</span>
            <strong>{loadedThreadIds.length}</strong>
          </div>
          <div className="inspector-row">
            <ShieldCheck size={14} />
            <span>{copy.account}</span>
            <strong title={accountLabel(account, locale)}>{accountLabel(account, locale)}</strong>
          </div>
          <div className="inspector-row is-muted">
            <Github size={14} />
            <span>{copy.remote}</span>
            <strong title={remote}>{remote}</strong>
          </div>
        </section>

        <section className="inspector-section">
          <div className="inspector-card-header">
            <strong>{copy.progress}</strong>
            <ChevronRight size={13} />
          </div>
          <div className="inspector-progress">
            <span data-complete={Boolean(thread)}>
              <CheckCircle2 size={13} />
              {copy.current}
            </span>
            <span data-complete={totalItems > 0}>
              <ListTodo size={13} />
              {thread ? `${totalItems} ${copy.task}` : copy.noThread}
            </span>
            <span data-complete={commands > 0}>
              <Terminal size={13} />
              {commands} {copy.commands}
            </span>
          </div>
        </section>

        <section className="inspector-section">
          <div className="inspector-card-header">
            <strong>{copy.goal}</strong>
          </div>
          <div className="inspector-row inspector-task">
            <ListTodo size={14} />
            <span title={threadGoal?.objective ?? copy.noGoal}>{threadGoal?.objective || copy.noGoal}</span>
          </div>
          {threadGoal ? (
            <div className="inspector-row is-muted">
              <CheckCircle2 size={14} />
              <span>{threadGoal.status}</span>
              <strong>
                {threadGoal.tokensUsed}
                {threadGoal.tokenBudget ? `/${threadGoal.tokenBudget}` : ""} {copy.tokens}
              </strong>
            </div>
          ) : null}
        </section>

        <section className="inspector-section">
          <div className="inspector-card-header">
            <strong>{copy.task}</strong>
          </div>
          <div className="inspector-row inspector-task">
            <Terminal size={14} />
            <span>{command ?? copy.noTask}</span>
          </div>
        </section>

        <section className="inspector-section">
          <div className="inspector-card-header">
            <strong>{copy.summary}</strong>
          </div>
          <div className="inspector-row inspector-task">
            <ListTodo size={14} />
            <span title={conversationSummary?.preview ?? copy.noSummary}>{conversationSummary?.preview || copy.noSummary}</span>
          </div>
          {conversationSummary ? (
            <div className="inspector-row is-muted">
              <HardDrive size={14} />
              <span>{conversationSummary.modelProvider}</span>
              <strong title={conversationSummary.cliVersion}>{conversationSummary.cliVersion}</strong>
            </div>
          ) : null}
        </section>

        <section className="inspector-section">
          <div className="inspector-card-header">
            <strong>{copy.source}</strong>
          </div>
          <div className="inspector-sources" aria-hidden="true">
            <Globe2 size={13} />
            <Github size={13} />
            <Terminal size={13} />
          </div>
        </section>
      </div>
    </aside>
  );
}
