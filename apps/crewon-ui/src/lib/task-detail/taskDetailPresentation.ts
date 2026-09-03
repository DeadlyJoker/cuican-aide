import type {
  TaskDetailAgentPresentation,
  TaskDetailCollection,
  TaskDetailEnvironmentPresentation,
  TaskDetailLoadable,
  TaskDetailPresentation,
  TaskDetailProcessPresentation,
  TaskDetailSourcePresentation,
} from "../../components/task-detail/TaskDetailPopover";
import type { Locale } from "../i18n";
import type { ConnectionState } from "../shared/connectionState";
import type { TaskDetailProcessState } from "./useTaskDetailProcesses";
import type { TaskDetailWorkspaceGitState } from "./useTaskDetailWorkspaceGit";
import type {
  TaskDetailProjection,
  TaskDetailSourceKind,
  TaskDetailSubagentStatus,
} from "./taskDetailProjection";

export type TaskDetailPresentationAuthority = "control" | "legacy";
export type TaskDetailPresentationInput = {
  authority: TaskDetailPresentationAuthority;
  connectionState: ConnectionState;
  locale: Locale;
  projection: TaskDetailProjection;
  workspaceGit?: TaskDetailWorkspaceGitState | null;
};

const COPY = {
  zh: {
    controlRuntime: "控制运行时",
    currentBranch: "当前分支",
    currentWorkspace: "当前工作区",
    detached: "分离头指针",
    gitError: "无法读取当前工作区 Git 信息",
    gitRepository: "Git 工作区",
    gitUnavailable: "当前运行环境未提供 Git 信息",
    gitForbidden: "无权查看当前工作区 Git 信息",
    localRuntime: "本地",
    nonGit: "非 Git 工作区",
    noWorkspace: "默认执行环境",
    offlineSnapshot: "离线快照",
    processForbidden: "无权查看后台进程信息",
    processError: "无法读取后台进程，请稍后重试",
    processUnavailable: "当前运行环境未提供后台进程信息",
    recordedTask: "任务记录",
    source: {
      image: "图片",
      localImage: "本地图片",
      mcpResource: "MCP 资源",
      mention: "对话引用",
      skill: "技能",
      webSearch: "网页搜索",
    },
    startupSnapshot: "启动快照",
  },
  en: {
    controlRuntime: "Control runtime",
    currentBranch: "Current branch",
    currentWorkspace: "Current workspace",
    detached: "Detached HEAD",
    gitError: "Unable to read Git information for the current workspace",
    gitRepository: "Git workspace",
    gitUnavailable: "Git information is unavailable in this runtime",
    gitForbidden:
      "You do not have permission to view workspace Git information",
    localRuntime: "Local",
    nonGit: "Not a Git workspace",
    noWorkspace: "Default execution environment",
    offlineSnapshot: "Offline snapshot",
    processForbidden: "You do not have permission to view background processes",
    processError: "Background processes could not be loaded. Try again later",
    processUnavailable: "Background processes are unavailable in this runtime",
    recordedTask: "Task record",
    source: {
      image: "Image",
      localImage: "Local image",
      mcpResource: "MCP resource",
      mention: "Conversation reference",
      skill: "Skill",
      webSearch: "Web search",
    },
    startupSnapshot: "startup snapshot",
  },
} as const;

function agentStatus(
  status: TaskDetailSubagentStatus,
): TaskDetailAgentPresentation["status"] {
  if (status === "pendingInit") return "pending";
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "errored" || status === "notFound") return "failed";
  if (status === "interrupted" || status === "shutdown") return "interrupted";
  return "unknown";
}

function sourceKind(
  kind: TaskDetailSourceKind,
): TaskDetailSourcePresentation["kind"] {
  if (kind === "image" || kind === "localImage") return "image";
  if (kind === "skill") return "skill";
  if (kind === "webSearch") return "link";
  if (kind === "mcpResource") return "mcp";
  return "file";
}

function statusTone(
  phase: TaskDetailProjection["status"]["phase"],
): NonNullable<TaskDetailEnvironmentPresentation["status"]>["tone"] {
  if (phase === "completed") return "success";
  if (phase === "failed") return "danger";
  if (
    phase === "interrupted" ||
    phase === "waitingOnApproval" ||
    phase === "waitingOnUserInput"
  ) {
    return "warning";
  }
  return "neutral";
}

function compactLabel(value: string, fallback: string): string {
  const compact = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!compact) return fallback;
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
}

export function taskDetailPresentation({
  authority,
  connectionState,
  locale,
  projection,
  workspaceGit = null,
}: TaskDetailPresentationInput): TaskDetailPresentation {
  const copy = COPY[locale];
  const offline = connectionState !== "connected";
  const git = projection.environment.gitSnapshot;
  const recordedBranch = git?.branch
    ? { detail: copy.startupSnapshot, label: git.branch }
    : git?.sha
      ? {
          detail: copy.startupSnapshot,
          label: `${copy.detached} ${git.sha.slice(0, 8)}`,
        }
      : null;
  const currentWorkspaceGit = workspaceGit;
  const liveGit = currentWorkspaceGit?.data ?? null;
  const branch: TaskDetailEnvironmentPresentation["branch"] = liveGit
    ? liveGit.isGitRepository === false
      ? { detail: copy.currentWorkspace, label: copy.nonGit }
      : liveGit.branch
        ? { detail: copy.currentWorkspace, label: liveGit.branch }
        : liveGit.head
          ? {
              detail: copy.currentWorkspace,
              label: `${copy.detached} ${liveGit.head.slice(0, 8)}`,
            }
          : liveGit.isGitRepository === true
            ? { detail: copy.currentWorkspace, label: copy.gitRepository }
            : recordedBranch
    : recordedBranch;
  const changes: TaskDetailEnvironmentPresentation["changes"] =
    liveGit?.isGitRepository === true && liveGit.changes
      ? {
          added: liveGit.changes.additions,
          detail: copy.currentBranch,
          files: liveGit.changes.files,
          removed: liveGit.changes.deletions,
        }
      : null;
  const workspace = projection.environment.workspaceName ?? copy.noWorkspace;
  const modelProvider = projection.environment.modelProvider.trim();
  const workspaceDetail = [
    liveGit ? copy.currentWorkspace : workspace,
    modelProvider,
    liveGit ? null : copy.recordedTask,
    offline ? copy.offlineSnapshot : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const environmentData = {
    branch,
    changes,
    status: {
      label: offline
        ? `${copy.offlineSnapshot} · ${projection.status.label}`
        : projection.status.label,
      tone: offline
        ? ("neutral" as const)
        : statusTone(projection.status.phase),
    },
    target: authority === "legacy" ? copy.localRuntime : copy.controlRuntime,
    workspace: workspaceDetail,
  };
  const environment = (() => {
    if (currentWorkspaceGit?.status === "loading") {
      return { status: "loading" as const, data: environmentData };
    }
    if (currentWorkspaceGit?.status === "error") {
      return {
        status: "error" as const,
        data: environmentData,
        error: copy.gitError,
      };
    }
    if (currentWorkspaceGit?.status === "forbidden") {
      return {
        status: "unavailable" as const,
        data: environmentData,
        unavailableReason: copy.gitForbidden,
      };
    }
    if (currentWorkspaceGit?.status === "unavailable" && !recordedBranch) {
      return {
        status: "unavailable" as const,
        data: environmentData,
        unavailableReason: copy.gitUnavailable,
      };
    }
    return { status: "ready" as const, data: environmentData };
  })();

  return {
    environment,
    agents: {
      status: "ready",
      data: {
        items: projection.subagents.agents.slice(0, 5).map((agent) => ({
          id: agent.threadId,
          name: compactLabel(agent.displayName, agent.threadId.slice(0, 12)),
          role: agent.role ? compactLabel(agent.role, "") : null,
          status: agentStatus(agent.status),
        })),
        summary:
          projection.subagents.total > 0
            ? locale === "zh"
              ? "最近记录"
              : "Recent records"
            : null,
        total: projection.subagents.total,
      },
    },
    sources: {
      status: "ready",
      data: {
        items: projection.sources.items.map((source, index) => ({
          detail: copy.source[source.kind],
          id: `${source.turnId}:${source.itemId}:${source.kind}:${index}`,
          kind: sourceKind(source.kind),
          label: compactLabel(source.displayName, copy.source[source.kind]),
        })),
        total: projection.sources.total,
      },
    },
  };
}

export function taskDetailProcessesPresentation(
  state: TaskDetailProcessState,
  locale: Locale,
  canTerminate: boolean,
): TaskDetailLoadable<TaskDetailCollection<TaskDetailProcessPresentation>> {
  const data = {
    items: state.data.map((process) => ({
      canTerminate,
      command: process.command,
      detail: [
        process.cwdLabel,
        process.pidLabel,
        process.cpuLabel,
        process.memoryLabel,
      ]
        .filter(Boolean)
        .join(" · "),
      processId: process.id,
      status: state.terminatingIds.includes(process.id)
        ? ("stopping" as const)
        : ("running" as const),
    })),
    total: state.data.length,
  };

  if (state.status === "forbidden") {
    return {
      status: "unavailable",
      unavailableReason: COPY[locale].processForbidden,
    };
  }
  if (state.status === "unavailable") {
    return {
      status: "unavailable",
      unavailableReason: COPY[locale].processUnavailable,
    };
  }
  if (state.status === "error") {
    return { status: "error", data, error: COPY[locale].processError };
  }
  if (state.status === "ready") {
    return { status: "ready", data };
  }
  return { status: "loading", data: state.data.length > 0 ? data : undefined };
}
