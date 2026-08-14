import {
  BookOpen,
  Bot,
  FolderOpen,
  PanelLeft,
  Plus,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

import { shellNavItems } from "./commandWorkspaceData";
import type {
  CommandHomeSlots,
  CommandPaletteItem,
  CommandShellView,
} from "./commandWorkspaceState";
import { classNames } from "./commandWorkspaceUtils";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { Locale } from "../../lib/i18n";
import { detectRuntimeSurface } from "../../lib/platform";

export type PaletteItemWithCommand = CommandPaletteItem & {
  action?:
    | "attach-files"
    | "attach-folder"
    | "provider-resources"
    | "toggle-goal"
    | "toggle-plan";
  command?: ComposerSlashCommand;
  selected?: boolean;
};

export type CommandLinkedThread = {
  /** Present in transport DTOs, but never rendered or used as UI authority. */
  cwd?: string | null;
  id: string;
  preview: string;
  title: string;
  updatedAt?: number;
  updatedLabel: string;
};

type SidebarSearchResult =
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

const viewIcons: Record<CommandShellView, ReactNode> = {
  command: <Plus aria-hidden="true" />,
  assist: <Sparkles aria-hidden="true" />,
  projects: <FolderOpen aria-hidden="true" />,
  agents: <Bot aria-hidden="true" />,
  knowledge: <BookOpen aria-hidden="true" />,
  team: <Users aria-hidden="true" />,
};

import { CommandSidebarSearchView } from "./CommandSidebarSearchView";
import { CommandSidebarWorkspaceTree } from "./CommandSidebarWorkspaceTree";
import { SidebarAccount } from "./CommandWorkspaceSidebarAccount";
export { SidebarAccount } from "./CommandWorkspaceSidebarAccount";

export function CommandSidebar({
  activeView,
  isSearchOpen,
  linkedThreads = [],
  locale = "zh",
  query,
  selectedLinkedThreadId,
  slots,
  onNewThread,
  onOpenLinkedThread,
  onCloseSearch,
  onQueryChange,
  onSwitchView,
  onToggleCollapse,
  onToggleSearch,
}: {
  activeView: CommandShellView;
  isSearchOpen: boolean;
  linkedThreads: CommandLinkedThread[];
  locale?: Locale;
  query: string;
  selectedLinkedThreadId: string | null;
  slots: CommandHomeSlots;
  onCloseSearch: () => void;
  onNewThread: () => void;
  onOpenLinkedThread: (threadId: string) => void;
  onOpenSettings?: () => void;
  onQueryChange: (query: string) => void;
  onSwitchView: (view: CommandShellView) => void;
  onToggleCollapse: () => void;
  onToggleSearch: () => void;
}) {
  /*
   * This drives layout only: the drag region and the brand offset that clears
   * the floating window controls. It has to match whatever the window frame
   * decided to draw, so it keys off the surface rather than `isTauri()`.
   */
  const desktopRuntime = detectRuntimeSurface() === "desktop";
  const copy =
    locale === "zh"
      ? {
          addWorkspace: "新增空间",
          cancel: "取消",
          collapseSidebar: "折叠侧栏",
          conversation: "对话",
          feature: "功能",
          folderPath: "文件夹路径",
          folderPathHint: "填写本地绝对路径，会话会绑定到这个目录。",
          knowledge: "知识库",
          chooseFolder: "选择文件夹…",
          newStandaloneThread: "新建无工作空间会话",
          newThread: "新建会话",
          noMatches: "没有匹配",
          noWorkspace: "无工作空间",
          open: "打开",
          remove: "移出列表",
          removeWorkspace: (name: string) => `将 ${name} 移出空间列表`,
          removeWorkspaceHint:
            "只从侧栏移除这个文件夹，磁盘上的文件和已有会话都不会被删除。",
          removeWorkspaceTitle: (name: string) => `移出空间「${name}」`,
          search: "搜索",
          searchLabel: "搜索对话和能力",
          searchResults: "搜索结果",
          sidebarTools: "侧栏工具",
          switchWorkspace: (name: string) => `切换到工作空间 ${name}`,
          threadInWorkspace: (name: string) => `在工作空间 ${name} 中新建会话`,
          workspace: "工作空间",
          workspaceEmpty:
            "当前没有绑定文件夹空间，可以新增空间或直接开始无空间会话。",
          workspaceThreadsEmpty: "开始一次任务后，会话会出现在这个工作空间下。",
          workspaceTree: "工作空间和对话",
          tasks: "任务",
          tasksEmpty: "开始一次任务后，对话会出现在这里。",
          tasksTree: "任务和对话",
        }
      : {
          addWorkspace: "Add workspace",
          cancel: "Cancel",
          collapseSidebar: "Collapse sidebar",
          conversation: "Conversation",
          feature: "Feature",
          folderPath: "Folder path",
          folderPathHint:
            "Use an absolute local path; conversations bind to this folder.",
          knowledge: "Knowledge base",
          chooseFolder: "Choose folder…",
          newStandaloneThread: "New conversation without a workspace",
          newThread: "New conversation",
          noMatches: "No matches",
          noWorkspace: "No workspace",
          open: "Open",
          remove: "Remove",
          removeWorkspace: (name: string) =>
            `Remove ${name} from the workspace list`,
          removeWorkspaceHint:
            "Removes the folder from the sidebar only. Files on disk and existing conversations are kept.",
          removeWorkspaceTitle: (name: string) => `Remove workspace ${name}`,
          search: "Search",
          searchLabel: "Search conversations and capabilities",
          searchResults: "Search results",
          sidebarTools: "Sidebar tools",
          switchWorkspace: (name: string) => `Switch to workspace ${name}`,
          threadInWorkspace: (name: string) =>
            `New conversation in workspace ${name}`,
          workspace: "Workspaces",
          workspaceEmpty:
            "No folder workspace is selected. Add one or start a conversation without a workspace.",
          workspaceThreadsEmpty:
            "Conversations will appear under this workspace after you start a task.",
          workspaceTree: "Workspaces and conversations",
          tasks: "Tasks",
          tasksEmpty: "Conversations will appear here after you start a task.",
          tasksTree: "Tasks and conversations",
        };
  const sidebarSearchResults: SidebarSearchResult[] = [
    {
      action: "view" as const,
      detail: locale === "zh" ? "智能体配置" : "Agent configuration",
      key: "agent-platform-slot",
      kind: copy.feature,
      title: slots.agent.title,
      view: "agents" as const,
    },
    ...linkedThreads.map((thread) => ({
      action: "thread" as const,
      detail: thread.preview || thread.updatedLabel,
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
  function activateSearchResult(item: SidebarSearchResult) {
    if (item.action === "thread") {
      onOpenLinkedThread(item.threadId);
    } else {
      onSwitchView(item.view);
    }
    onQueryChange("");
    onCloseSearch();
  }

  return (
    <aside
      className="command-sidebar"
      data-od-id="desktop-sidebar"
      data-sidebar-current={activeView}
      data-sidebar-log="command-log"
      data-sidebar-prefix="desktop"
      data-sidebar-shell=""
      data-desktop-runtime={desktopRuntime ? "true" : undefined}
    >
      <div
        className="sidebar-topbar"
        data-od-id="desktop-sidebar-topbar"
        data-tauri-drag-region={desktopRuntime ? "" : undefined}
      >
        {/*
         * Window controls come from the global DesktopWindowFrame, which wraps
         * every route. Mounting them here too would show two sets at once, and
         * would leave any screen that forgets them frameless.
         */}
        <div className="sidebar-tools" aria-label={copy.sidebarTools}>
          <button
            aria-label={copy.collapseSidebar}
            aria-pressed="false"
            className="sidebar-tool"
            data-od-id="sidebar-collapse-button"
            data-sidebar-collapse=""
            type="button"
            onClick={onToggleCollapse}
          >
            <PanelLeft aria-hidden="true" />
          </button>
          <button
            aria-controls="sidebar-search-panel"
            aria-expanded={isSearchOpen}
            aria-label={copy.search}
            className="sidebar-tool"
            data-od-id="sidebar-search-button"
            data-sidebar-search-open=""
            type="button"
            onClick={onToggleSearch}
          >
            <Search aria-hidden="true" />
          </button>
        </div>
      </div>

      <CommandSidebarSearchView
        isSearchOpen={isSearchOpen}
        noMatches={copy.noMatches}
        query={query}
        results={sidebarSearchResults}
        searchLabel={copy.searchLabel}
        searchResultsLabel={copy.searchResults}
        onActivate={activateSearchResult}
        onClose={onCloseSearch}
        onQueryChange={onQueryChange}
      />

      <a
        className="sidebar-brand"
        data-od-id="desktop-brand"
        href="#view-command"
        style={desktopRuntime ? { left: 76 } : undefined}
        onClick={(event) => {
          event.preventDefault();
          onSwitchView("command");
        }}
      >
        <span>Crewon</span>
        <small>v0.2</small>
      </a>

      <nav className="sidebar-nav" data-od-id="desktop-nav">
        {shellNavItems.map((item) => (
          <button
            aria-current={activeView === item.key ? "page" : undefined}
            className={classNames(activeView === item.key && "active")}
            data-nav-key={item.key}
            data-shell-view-target={item.key}
            key={item.key}
            type="button"
            onClick={() => {
              if (item.key === "command") {
                onNewThread();
                return;
              }
              onSwitchView(item.key);
            }}
          >
            <span className="nav-glyph" aria-hidden="true">
              {viewIcons[item.key]}
            </span>
            <strong>{locale === "zh" ? item.label : item.en}</strong>
          </button>
        ))}
        <button
          aria-current={activeView === "knowledge" ? "page" : undefined}
          className={classNames(activeView === "knowledge" && "active")}
          data-run-title-zh="知识库"
          data-run-title-en="Knowledge base"
          type="button"
          onClick={() => onSwitchView("knowledge")}
        >
          <span className="nav-glyph" aria-hidden="true">
            <BookOpen aria-hidden="true" />
          </span>
          <strong>{copy.knowledge}</strong>
        </button>
      </nav>

      <CommandSidebarWorkspaceTree
        copy={copy}
        linkedThreads={linkedThreads}
        selectedLinkedThreadId={selectedLinkedThreadId}
        onNewThread={onNewThread}
        onOpenLinkedThread={onOpenLinkedThread}
      />

    </aside>
  );
}

export { Palette, paletteSearchKeyAction } from "./CommandWorkspacePalette";
