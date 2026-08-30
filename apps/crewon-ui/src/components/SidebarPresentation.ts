import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { Locale } from "../lib/i18n";

export type ProjectSessionGroup = {
  cwd: string;
  name: string;
  threads: Thread[];
};

export function sidebarThreadTitle(thread: Thread, fallback: string): string {
  const title = thread.name || thread.preview || fallback;
  const officeTitle = /^CrewON Office Chat · [^·]+ · (.+)$/u
    .exec(title)?.[1]
    ?.trim();
  return officeTitle ? `💬 ${officeTitle}` : title;
}

function workspaceName(cwd: string): string {
  const normalizedCwd = cwd.replace(/\/+$/, "");
  return (
    normalizedCwd.split("/").filter(Boolean).pop() ||
    normalizedCwd ||
    "Workspace"
  );
}

export function sidebarNavLabels(locale: Locale) {
  return locale === "zh"
    ? {
        plugins: "插件",
        tools: "工具",
        agents: "智能体",
        office: "办公室",
        automation: "自动化",
        knowledge: "知识库",
        project: "项目",
        conversations: "对话",
        session: "会话",
      }
    : {
        plugins: "Plugins",
        tools: "Tools",
        agents: "Agents",
        office: "Office",
        automation: "Automations",
        knowledge: "Knowledge",
        project: "Projects",
        conversations: "Chats",
        session: "Sessions",
      };
}

export function filterSidebarThreads({
  controlledSearch,
  searchTerm,
  threads,
}: {
  controlledSearch: boolean;
  searchTerm: string;
  threads: Thread[];
}): Thread[] {
  if (controlledSearch) {
    return threads;
  }

  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  if (!normalizedSearchTerm) {
    return threads;
  }

  return threads.filter((thread) =>
    [thread.name, thread.preview, thread.cwd, thread.modelProvider]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalizedSearchTerm)),
  );
}

export function groupSidebarThreads(threads: Thread[]): {
  projectGroups: ProjectSessionGroup[];
  standaloneThreads: Thread[];
} {
  const groups = new Map<string, ProjectSessionGroup>();
  const standaloneThreads: Thread[] = [];

  for (const thread of threads) {
    const cwd = thread.cwd?.trim();

    if (!cwd) {
      standaloneThreads.push(thread);
      continue;
    }

    const existingGroup = groups.get(cwd);

    if (existingGroup) {
      existingGroup.threads.push(thread);
      continue;
    }

    groups.set(cwd, {
      cwd,
      name: workspaceName(cwd),
      threads: [thread],
    });
  }

  return {
    projectGroups: [...groups.values()],
    standaloneThreads,
  };
}
