import type { Locale } from "../../lib/i18n";
import type {
  CommandHomeSlots,
  CommandShellView,
} from "./commandWorkspaceState";
import type {
  CommandLinkedThread,
  CommandWorkspaceAuthority,
} from "./CommandWorkspaceChrome";

export type CommandSearchResult =
  | {
      action: "thread";
      detail: string;
      key: string;
      kind: string;
      threadId: string;
      title: string;
    }
  | {
      action: "view";
      detail: string;
      key: string;
      kind: string;
      title: string;
      view: CommandShellView;
    };

function workspaceName(path: string, emptyLabel = "工作空间"): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return (
    normalized.split("/").filter(Boolean).pop() || normalized || emptyLabel
  );
}

export function commandSearchResults({
  locale,
  slots,
  linkedThreads,
  workspaceAuthority,
  query,
  copy,
}: {
  locale: Locale;
  slots: CommandHomeSlots;
  linkedThreads: CommandLinkedThread[];
  workspaceAuthority: CommandWorkspaceAuthority;
  query: string;
  copy: { feature: string; conversation: string; noWorkspace: string };
}): CommandSearchResult[] {
  return [
    ...[
      {
        view: "agents" as const,
        title: locale === "zh" ? "智能体" : "Agents",
        detail: slots.agent.title,
      },
      {
        view: "team" as const,
        title: locale === "zh" ? "团队" : "Teams",
        detail:
          locale === "zh"
            ? "办公室、协作流与专家团"
            : "Offices, workflows and expert teams",
      },
      {
        view: "knowledge" as const,
        title: locale === "zh" ? "知识库" : "Knowledge base",
        detail: slots.knowledge.title,
      },
      {
        view: "projects" as const,
        title: locale === "zh" ? "任务" : "Tasks",
        detail: locale === "zh" ? "查看任务进度" : "Review task progress",
      },
      {
        view: "assist" as const,
        title: locale === "zh" ? "助理" : "Assistant",
        detail: locale === "zh" ? "个人助理" : "Personal assistant",
      },
      {
        view: "schedule" as const,
        title: locale === "zh" ? "日程安排" : "Schedule",
        detail: locale === "zh" ? "管理定时任务" : "Manage scheduled tasks",
      },
    ].map((item) => ({
      ...item,
      action: "view" as const,
      key: `view-${item.view}`,
      kind: copy.feature,
    })),
    ...linkedThreads.map((thread) => ({
      action: "thread" as const,
      detail: [
        ...(workspaceAuthority === "legacy"
          ? [workspaceName(thread.cwd ?? "", copy.noWorkspace)]
          : []),
        thread.preview || thread.updatedLabel,
      ]
        .filter(Boolean)
        .join(" · "),
      key: `thread-${thread.id}`,
      kind: copy.conversation,
      threadId: thread.id,
      title: thread.title,
    })),
  ].filter((item) =>
    [item.kind, item.title, item.detail]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
}
