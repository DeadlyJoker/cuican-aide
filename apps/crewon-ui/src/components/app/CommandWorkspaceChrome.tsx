import {
  commandSearchResults,
  type CommandSearchResult,
} from "./commandSearchResults";
import { useCommandSidebarSearchShortcut } from "./useCommandSidebarSearchShortcut";
import { CommandRailAccount } from "./CommandRailAccount";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  ChevronUp,
  Cloud,
  Folder,
  KeyRound,
  LogOut,
  Paperclip,
  PanelLeft,
  Plug,
  SquarePen,
  Search,
  Settings2,
  Target,
  Trash2,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  CommandNavigationRail,
  CommandRailButton,
} from "./CommandNavigationRail";
import {
  commandSidebarHasContext,
  commandSidebarSection,
} from "./commandSidebarSections";
import { CommandSidebarNavigation } from "./CommandSidebarNavigation";
import {
  commandSidebarThreadHasUnreadSignal,
  type CommandSidebarThreadScope,
  type CommandSidebarThreadState,
} from "./commandSidebarThreadPresentation";
import type {
  CommandHomeSlots,
  CommandPaletteItem,
  CommandShellView,
} from "./commandWorkspaceState";
import { classNames } from "./commandWorkspaceUtils";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { Locale } from "../../lib/i18n";
import {
  canPickWorkspaceFolder,
  pickWorkspaceFolder,
} from "../../lib/desktop/workspaceFolderPicker";
import { detectRuntimeSurface, type PlatformKind } from "../../lib/platform";
import {
  forgetWorkspace,
  mergeWorkspaceRoster,
  nextActiveWorkspace,
  normalizeWorkspacePath,
  readWorkspaceRoster,
  rememberWorkspace,
  writeWorkspaceRoster,
  type WorkspaceRosterEntry,
} from "../../lib/workspace/workspaceRoster";
import { TitleBarWindowControls } from "../TitleBarWindowControls";
import {
  type AgentPlatformAccount,
  useAgentPlatformAccount,
} from "../auth/AgentPlatformAuthGate";

export type PaletteItemWithCommand = CommandPaletteItem & {
  action?:
    | "attach-files"
    | "attach-folder"
    | "intent-goal"
    | "intent-plan"
    | "mention-member"
    | "provider-resources";
  command?: ComposerSlashCommand;
};

export type CommandLinkedThread = {
  cwd: string | null;
  id: string;
  preview: string;
  scope?: CommandSidebarThreadScope;
  scopeLabel?: string;
  state?: CommandSidebarThreadState;
  stateLabel?: string;
  title: string;
  updatedAt?: number;
  updatedLabel: string;
  workspaceLabel?: string;
};

export type CommandWorkspaceAuthority = "control" | "legacy";

/*
 * The sidebar tree only needs the workspace's name and its folder mutations;
 * the per-operation execution feed stays inside the Control runtime and is no
 * longer surfaced next to the conversation.
 */
export type CommandControlWorkspaceNav = {
  name: string | null;
  busy: boolean;
  revisionKey?: string | null;
  error?: string | null;
  onClear?: () => void;
  onSelect?: () => void;
};

export function readCommandSidebarWorkspaceRoster(
  authority: CommandWorkspaceAuthority,
  accountId: string | null,
): WorkspaceRosterEntry[] {
  return authority === "legacy" ? readWorkspaceRoster(accountId) : [];
}

export function writeCommandSidebarWorkspaceRoster(
  authority: CommandWorkspaceAuthority,
  accountId: string | null,
  entries: WorkspaceRosterEntry[],
): void {
  if (authority === "legacy") {
    writeWorkspaceRoster(accountId, entries);
  }
}

export function commandSidebarHasFolderPicker(
  authority: CommandWorkspaceAuthority,
  canPick: () => boolean = canPickWorkspaceFolder,
): boolean {
  return authority === "legacy" && canPick();
}

export async function pickCommandSidebarWorkspaceFolder(
  authority: CommandWorkspaceAuthority,
  title: string,
  pick: (title: string) => Promise<string | null> = pickWorkspaceFolder,
): Promise<string | null> {
  return authority === "legacy" ? pick(title) : null;
}

import { CommandSidebarSearchView } from "./CommandSidebarSearchView";
import { CommandSidebarWorkspaceTree } from "./CommandSidebarWorkspaceTree";
import { useCommandSidebarWorkspaceController } from "./useCommandSidebarWorkspaceController";
export { SidebarAccount } from "./CommandWorkspaceSidebarAccount";

export function CommandSidebar({
  chromeTarget,
  activeView,
  collapsed = false,
  controlWorkspace,
  cwd,
  isSearchOpen,
  linkedThreads = [],
  locale = "zh",
  platform = "web",
  query,
  selectedLinkedThreadId,
  slots,
  workspaceAuthority,
  onCreateWorkspace,
  onNewThread,
  onArchiveThread,
  onOpenLinkedThread,
  onOpenSettings,
  onCloseSearch,
  onQueryChange,
  onSwitchView,
  onToggleCollapse,
  onToggleSearch,
}: {
  chromeTarget?: HTMLElement | null;
  activeView: CommandShellView;
  collapsed?: boolean;
  controlWorkspace?: CommandControlWorkspaceNav;
  cwd: string;
  isSearchOpen: boolean;
  linkedThreads: CommandLinkedThread[];
  locale?: Locale;
  platform?: PlatformKind;
  query: string;
  selectedLinkedThreadId: string | null;
  slots: CommandHomeSlots;
  workspaceAuthority: CommandWorkspaceAuthority;
  onCloseSearch: () => void;
  onCreateWorkspace?: (cwd: string) => void;
  onNewThread: (workspaceCwd: string | null) => void;
  onArchiveThread?: (threadId: string) => void;
  onOpenLinkedThread: (threadId: string) => void;
  onOpenSettings?: () => void;
  onQueryChange: (query: string) => void;
  onSwitchView: (view: CommandShellView) => void;
  onToggleCollapse: () => void;
  onToggleSearch: () => void;
}) {
  const account = useAgentPlatformAccount();
  /*
   * This drives layout only: the drag region and the brand offset that clears
   * the floating window controls. It has to match whatever the window frame
   * decided to draw, so it keys off the surface rather than the host bridge.
   */
  const desktopRuntime = detectRuntimeSurface() === "desktop";
  const copy =
    locale === "zh"
      ? {
          addWorkspace: "新增空间",
          archiveThread: "归档会话",
          cancel: "取消",
          collapseSidebar: "折叠侧栏",
          conversation: "对话",
          controlWorkspaceEmpty: "尚未绑定本机文件夹作为工作空间。",
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
          replaceWorkspace: "更换工作空间",
          search: "搜索",
          searchLabel: "搜索对话和能力",
          searchResults: "搜索结果",
          selectWorkspace: "选择工作空间",
          sidebarTools: "侧栏工具",
          switchWorkspace: (name: string) => `切换到工作空间 ${name}`,
          threadInWorkspace: (name: string) => `在工作空间 ${name} 中新建会话`,
          unbindWorkspace: (name: string) => `解除与「${name}」的绑定`,
          workspace: "工作空间",
          workspaceEmpty:
            "当前没有绑定文件夹空间，可以新增空间或直接开始无空间会话。",
          workspaceSelectFailed: (detail: string) =>
            `工作空间切换失败：${detail}`,
          workspaceThreadsEmpty: "暂无任务",
          workspaceTree: "工作空间和对话",
        }
      : {
          addWorkspace: "Add workspace",
          archiveThread: "Archive conversation",
          cancel: "Cancel",
          collapseSidebar: "Collapse sidebar",
          conversation: "Conversation",
          controlWorkspaceEmpty: "No local folder is bound as a workspace yet.",
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
          replaceWorkspace: "Change workspace",
          search: "Search",
          searchLabel: "Search conversations and capabilities",
          searchResults: "Search results",
          selectWorkspace: "Select workspace",
          sidebarTools: "Sidebar tools",
          switchWorkspace: (name: string) => `Switch to workspace ${name}`,
          threadInWorkspace: (name: string) =>
            `New conversation in workspace ${name}`,
          unbindWorkspace: (name: string) => `Unbind workspace ${name}`,
          workspace: "Workspaces",
          workspaceEmpty:
            "No folder workspace is selected. Add one or start a conversation without a workspace.",
          workspaceSelectFailed: (detail: string) =>
            `Workspace switch failed: ${detail}`,
          workspaceThreadsEmpty: "No tasks yet",
          workspaceTree: "Workspaces and conversations",
        };
  const {
    workspaceFormOpen,
    setWorkspaceFormOpen,
    workspaceDraft,
    setWorkspaceDraft,
    nativeFolderPicker,
    pickerBusy,
    workspaceFormRef,
    pendingRemoval,
    setPendingRemoval,
    workspaces,
    removeWorkspace,
    currentWorkspaceName,
    currentWorkspaceThreads,
    standaloneThreads,
    otherWorkspaceGroups,
    submitWorkspace,
    chooseWorkspaceFolder,
    toggleWorkspaceGroup,
    currentWorkspaceCollapsed,
    standaloneWorkspaceCollapsed,
  } = useCommandSidebarWorkspaceController({
    accountId: account ? String(account.user.id) : null,
    addWorkspaceLabel: copy.addWorkspace,
    cwd,
    linkedThreads,
    noWorkspaceLabel: copy.noWorkspace,
    onCreateWorkspace,
    workspaceAuthority,
  });
  const sidebarSearchResults = commandSearchResults({
    locale,
    slots,
    linkedThreads,
    workspaceAuthority,
    query,
    copy,
  });
  const taskAttentionCount = linkedThreads.filter(
    (thread) =>
      thread.state !== undefined &&
      commandSidebarThreadHasUnreadSignal(thread.state),
  ).length;

  function activateSearchResult(item: CommandSearchResult) {
    if (item.action === "thread") {
      onOpenLinkedThread(item.threadId);
    } else {
      onSwitchView(item.view);
    }
    onQueryChange("");
    onCloseSearch();
  }

  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  useCommandSidebarSearchShortcut({
    available: commandSidebarHasContext(activeView),
    isOpen: isSearchOpen,
    onClose: onCloseSearch,
    onOpen: onToggleSearch,
  });
  function toggleSearch() {
    if (isSearchOpen) onCloseSearch();
    else onToggleSearch();
  }
  const section = commandSidebarSection(activeView);
  const contextVisible = !collapsed && commandSidebarHasContext(activeView);
  const chrome = commandSidebarHasContext(activeView) ? (
    <div className="command-sidebar-chrome">
      <TooltipProvider delayDuration={250}>
        <CommandRailButton
          label={
            locale === "zh"
              ? collapsed
                ? "展开侧栏"
                : "折叠侧栏"
              : collapsed
                ? "Expand sidebar"
                : "Collapse sidebar"
          }
          aria-expanded={!collapsed}
          aria-controls="command-sidebar-context"
          data-sidebar-collapse=""
          onClick={onToggleCollapse}
        >
          <PanelLeft aria-hidden="true" />
        </CommandRailButton>
      </TooltipProvider>
    </div>
  ) : null;

  return (
    <aside
      className="command-sidebar command-sidebar--tiered"
      data-context-visible={contextVisible}
      data-sidebar-section={section}
      data-od-id="desktop-sidebar"
      data-sidebar-current={activeView}
      data-sidebar-log="command-log"
      data-sidebar-prefix="desktop"
      data-sidebar-shell=""
      data-desktop-runtime={desktopRuntime ? "true" : undefined}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          contextVisible &&
          !isSearchOpen &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(max-width: 680px)").matches
        ) {
          event.preventDefault();
          onToggleCollapse();
        }
      }}
    >
      {chromeTarget ? createPortal(chrome, chromeTarget) : chrome}
      <CommandNavigationRail
        activeView={activeView}
        collapsed={collapsed}
        locale={locale}
        taskAttentionCount={taskAttentionCount}
        onSwitchView={onSwitchView}
        onToggleCollapse={onToggleCollapse}
        accountMenu={
          <CommandRailAccount
            account={account}
            locale={locale}
            onSettings={onOpenSettings}
          />
        }
      />
      {contextVisible ? (
        <button
          aria-label={locale === "zh" ? "关闭侧栏" : "Close sidebar"}
          className="command-sidebar-backdrop"
          type="button"
          onClick={onToggleCollapse}
        />
      ) : null}
      <div
        className="command-sidebar-context"
        hidden={!contextVisible}
        id="command-sidebar-context"
      >
        <div
          className="sidebar-topbar"
          data-od-id="desktop-sidebar-topbar"
          data-desktop-drag-region={desktopRuntime ? "" : undefined}
        >
          <a
            className="sidebar-context-title"
            data-od-id="desktop-brand"
            href="#view-command"
            onClick={(event) => {
              event.preventDefault();
              onSwitchView("command");
            }}
          >
            {section === "resources"
              ? locale === "zh"
                ? "资源"
                : "Resources"
              : "CrewON"}
          </a>
          <div className="sidebar-tools" aria-label={copy.sidebarTools}>
            <button
              aria-controls="sidebar-search-panel"
              aria-haspopup="dialog"
              aria-expanded={isSearchOpen}
              aria-label={copy.search}
              className="sidebar-tool"
              data-od-id="sidebar-search-button"
              data-sidebar-search-open=""
              type="button"
              ref={searchTriggerRef}
              onClick={toggleSearch}
            >
              <Search aria-hidden="true" />
            </button>
          </div>
        </div>

        <CommandSidebarSearchView
          locale={locale}
          isSearchOpen={isSearchOpen}
          noMatches={copy.noMatches}
          query={query}
          results={sidebarSearchResults}
          searchLabel={copy.searchLabel}
          searchResultsLabel={copy.searchResults}
          shortcutLabel={platform === "windows" ? "Ctrl K" : "⌘K"}
          triggerRef={searchTriggerRef}
          onActivate={activateSearchResult}
          onClose={onCloseSearch}
          onQueryChange={onQueryChange}
        />

        <CommandSidebarNavigation
          activeView={activeView}
          locale={locale}
          onNewThread={() => onNewThread(null)}
          onSwitchView={onSwitchView}
        />

        <div className="command-sidebar-workspaces" hidden={section !== "work"}>
          <CommandSidebarWorkspaceTree
            workspaceAuthority={workspaceAuthority}
            copy={copy}
            onNewThread={onNewThread}
            linkedThreads={linkedThreads}
            selectedLinkedThreadId={selectedLinkedThreadId}
            onArchiveThread={onArchiveThread}
            onOpenLinkedThread={onOpenLinkedThread}
            nativeFolderPicker={nativeFolderPicker}
            workspaceFormOpen={workspaceFormOpen}
            pickerBusy={pickerBusy}
            onCreateWorkspace={onCreateWorkspace}
            chooseWorkspaceFolder={chooseWorkspaceFolder}
            setWorkspaceFormOpen={setWorkspaceFormOpen}
            submitWorkspace={submitWorkspace}
            workspaceDraft={workspaceDraft}
            setWorkspaceDraft={setWorkspaceDraft}
            cwd={cwd}
            currentWorkspaceCollapsed={currentWorkspaceCollapsed}
            toggleWorkspaceGroup={toggleWorkspaceGroup}
            currentWorkspaceName={currentWorkspaceName}
            setPendingRemoval={setPendingRemoval}
            currentWorkspaceThreads={currentWorkspaceThreads}
            standaloneThreads={standaloneThreads}
            otherWorkspaceGroups={otherWorkspaceGroups}
            standaloneWorkspaceCollapsed={standaloneWorkspaceCollapsed}
            pendingRemoval={pendingRemoval}
            removeWorkspace={removeWorkspace}
            controlWorkspace={controlWorkspace}
          />
        </div>
      </div>
    </aside>
  );
}

export { Palette, paletteSearchKeyAction } from "./CommandWorkspacePalette";
