import {
  BookOpen,
  Bot,
  CalendarDays,
  ChevronRight,
  ChevronUp,
  Cloud,
  Folder,
  FolderOpen,
  KeyRound,
  ListChecks,
  LogOut,
  Paperclip,
  PanelLeft,
  Plug,
  Plus,
  SquarePen,
  Search,
  Settings2,
  Sparkles,
  Target,
  Trash2,
  Users,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { shellNavItems } from "./commandWorkspaceData";
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
    | "provider-resources"
    | "toggle-goal"
    | "toggle-plan";
  command?: ComposerSlashCommand;
  selected?: boolean;
};

export type CommandLinkedThread = {
  cwd: string | null;
  id: string;
  preview: string;
  title: string;
  updatedAt?: number;
  updatedLabel: string;
};

export type CommandWorkspaceAuthority = "control" | "legacy";

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
  schedule: <CalendarDays aria-hidden="true" />,
  team: <Users aria-hidden="true" />,
};

import { SidebarAccount } from "./CommandWorkspaceSidebarAccount";
import { useCommandSidebarWorkspaceController } from "./useCommandSidebarWorkspaceController";
export { SidebarAccount } from "./CommandWorkspaceSidebarAccount";

function workspaceName(path: string, emptyLabel = "工作空间"): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return (
    normalized.split("/").filter(Boolean).pop() || normalized || emptyLabel
  );
}

export function CommandSidebar({
  activeView,
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
  onOpenLinkedThread,
  onOpenSettings,
  onCloseSearch,
  onQueryChange,
  onSwitchView,
  onToggleCollapse,
  onToggleSearch,
}: {
  activeView: CommandShellView;
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

      <section
        className="sidebar-search-panel"
        data-od-id="sidebar-search-panel"
        data-sidebar-search=""
        hidden={!isSearchOpen}
        id="sidebar-search-panel"
      >
        <div className="sidebar-search-field">
          <Search aria-hidden="true" />
          <input
            aria-label={copy.searchLabel}
            data-sidebar-search-input=""
            placeholder={copy.searchLabel}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCloseSearch();
              } else if (event.key === "Enter" && sidebarSearchResults[0]) {
                event.preventDefault();
                activateSearchResult(sidebarSearchResults[0]);
              }
            }}
          />
          <kbd>⌘K</kbd>
        </div>
        <div
          className="sidebar-search-results"
          role="listbox"
          aria-label={copy.searchResults}
        >
          {sidebarSearchResults.map((item) => (
            <button
              className="sidebar-search-result"
              data-search-action={item.action}
              data-search-result=""
              data-thread-id={
                item.action === "thread" ? item.threadId : undefined
              }
              key={item.key}
              type="button"
              onClick={() => activateSearchResult(item)}
            >
              <span>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </span>
              <em>{item.kind}</em>
            </button>
          ))}
          <p
            className="sidebar-search-empty"
            data-search-empty=""
            hidden={sidebarSearchResults.length > 0}
          >
            {copy.noMatches}
          </p>
        </div>
      </section>

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
                onNewThread(
                  workspaceAuthority === "legacy" ? cwd || null : null,
                );
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

      <section
        className="space-tree"
        data-od-id="desktop-workspace-tree"
        aria-label={
          workspaceAuthority === "control" ? copy.tasksTree : copy.workspaceTree
        }
      >
        {workspaceAuthority === "control" ? (
          <>
            <div className="tree-head">
              <strong className="tree-head-label">{copy.tasks}</strong>
              <button
                aria-label={copy.newThread}
                className="tree-head-action"
                title={copy.newThread}
                type="button"
                onClick={() => onNewThread(null)}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
            <div className="space-node current control-task-node">
              <div className="conversation-list recent-thread-list">
                {linkedThreads.length > 0 ? (
                  linkedThreads.slice(0, 10).map((thread) => (
                    <button
                      className={classNames(
                        "conversation-item linked-conversation-item recent-thread-item",
                        selectedLinkedThreadId === thread.id && "active",
                      )}
                      data-linked-thread-id={thread.id}
                      key={thread.id}
                      title={thread.preview}
                      type="button"
                      onClick={() => onOpenLinkedThread(thread.id)}
                    >
                      <span>{thread.title}</span>
                      <em>{thread.updatedLabel}</em>
                    </button>
                  ))
                ) : (
                  <p className="sidebar-empty-hint">{copy.tasksEmpty}</p>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="tree-head">
              <strong className="tree-head-label">{copy.workspace}</strong>
              <button
                aria-expanded={
                  nativeFolderPicker ? undefined : workspaceFormOpen
                }
                aria-label={
                  nativeFolderPicker ? copy.chooseFolder : copy.addWorkspace
                }
                className="tree-head-action"
                /*
                 * Only the picker path disables: a dialog already on screen must not
                 * be asked for a second one. The form path keeps its old behaviour of
                 * opening regardless, with the submit button carrying the guard.
                 */
                disabled={
                  nativeFolderPicker && (pickerBusy || !onCreateWorkspace)
                }
                title={
                  nativeFolderPicker ? copy.chooseFolder : copy.addWorkspace
                }
                type="button"
                onClick={() => {
                  if (nativeFolderPicker) {
                    void chooseWorkspaceFolder();
                    return;
                  }
                  setWorkspaceFormOpen((open) => !open);
                }}
              >
                <Plus aria-hidden="true" />
              </button>
              <form
                className="sidebar-workspace-form"
                hidden={nativeFolderPicker || !workspaceFormOpen}
                onSubmit={submitWorkspace}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setWorkspaceFormOpen(false);
                  }
                }}
              >
                <strong className="sidebar-workspace-form-title">
                  {copy.addWorkspace}
                </strong>
                <label htmlFor="command-workspace-path">
                  {copy.folderPath}
                </label>
                <input
                  id="command-workspace-path"
                  placeholder="/Users/me/project"
                  value={workspaceDraft}
                  onChange={(event) => setWorkspaceDraft(event.target.value)}
                />
                <p className="sidebar-workspace-form-hint">
                  {copy.folderPathHint}
                </p>
                <div className="sidebar-workspace-form-actions">
                  <button
                    type="button"
                    onClick={() => setWorkspaceFormOpen(false)}
                  >
                    {copy.cancel}
                  </button>
                  <button
                    className="primary"
                    type="submit"
                    disabled={!workspaceDraft.trim() || !onCreateWorkspace}
                  >
                    {copy.open}
                  </button>
                </div>
              </form>
            </div>
            {cwd ? (
              <div
                className={classNames(
                  "space-node current real-workspace-node",
                  currentWorkspaceCollapsed && "collapsed",
                )}
              >
                <div className="space-title real-workspace-title">
                  <button
                    aria-controls="current-workspace-thread-list"
                    aria-expanded={!currentWorkspaceCollapsed}
                    className="workspace-title-toggle"
                    type="button"
                    onClick={() => toggleWorkspaceGroup(cwd)}
                  >
                    {currentWorkspaceCollapsed ? (
                      <Folder aria-hidden="true" />
                    ) : (
                      <FolderOpen aria-hidden="true" />
                    )}
                    <strong>{currentWorkspaceName}</strong>
                  </button>
                  <span className="workspace-row-actions">
                    <button
                      aria-label={copy.newThread}
                      title={copy.newThread}
                      type="button"
                      onClick={() => onNewThread(cwd)}
                    >
                      <SquarePen aria-hidden="true" />
                    </button>
                    <button
                      aria-label={copy.removeWorkspace(currentWorkspaceName)}
                      className="workspace-remove-action"
                      title={copy.removeWorkspace(currentWorkspaceName)}
                      type="button"
                      onClick={() => setPendingRemoval(cwd)}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </span>
                </div>
                <div
                  className="conversation-list recent-thread-list"
                  hidden={currentWorkspaceCollapsed}
                  id="current-workspace-thread-list"
                >
                  {currentWorkspaceThreads.length > 0 ? (
                    currentWorkspaceThreads.map((thread) => (
                      <button
                        className={classNames(
                          "conversation-item linked-conversation-item recent-thread-item",
                          selectedLinkedThreadId === thread.id && "active",
                        )}
                        data-linked-thread-id={thread.id}
                        key={thread.id}
                        title={thread.preview}
                        type="button"
                        onClick={() => onOpenLinkedThread(thread.id)}
                      >
                        <span>{thread.title}</span>
                        <em>{thread.updatedLabel}</em>
                      </button>
                    ))
                  ) : (
                    <p className="sidebar-empty-hint">
                      {copy.workspaceThreadsEmpty}
                    </p>
                  )}
                </div>
              </div>
            ) : standaloneThreads.length === 0 &&
              otherWorkspaceGroups.length === 0 ? (
              <p className="sidebar-empty-hint workspace-empty-hint">
                {copy.workspaceEmpty}
              </p>
            ) : null}
            {otherWorkspaceGroups.map((group, index) => {
              const name = workspaceName(group.path);
              return (
                <div
                  className="space-node real-workspace-node"
                  key={group.path}
                >
                  <div className="space-title real-workspace-title">
                    <button
                      aria-controls={`other-workspace-thread-list-${index}`}
                      aria-label={copy.switchWorkspace(name)}
                      className="workspace-title-toggle"
                      type="button"
                      onClick={() => onCreateWorkspace?.(group.path)}
                    >
                      <Folder aria-hidden="true" />
                      <strong>{name}</strong>
                    </button>
                    <span className="workspace-row-actions">
                      <button
                        aria-label={copy.threadInWorkspace(name)}
                        title={copy.threadInWorkspace(name)}
                        type="button"
                        onClick={() => onNewThread(group.path)}
                      >
                        <SquarePen aria-hidden="true" />
                      </button>
                      <button
                        aria-label={copy.removeWorkspace(name)}
                        className="workspace-remove-action"
                        title={copy.removeWorkspace(name)}
                        type="button"
                        onClick={() => setPendingRemoval(group.path)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                  <div
                    className="conversation-list recent-thread-list"
                    id={`other-workspace-thread-list-${index}`}
                  >
                    {group.threads.map((thread) => (
                      <button
                        className={classNames(
                          "conversation-item linked-conversation-item recent-thread-item",
                          selectedLinkedThreadId === thread.id && "active",
                        )}
                        data-linked-thread-id={thread.id}
                        key={thread.id}
                        title={thread.preview}
                        type="button"
                        onClick={() => onOpenLinkedThread(thread.id)}
                      >
                        <span>{thread.title}</span>
                        <em>{thread.updatedLabel}</em>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            {standaloneThreads.length > 0 ? (
              <div
                className={classNames(
                  "space-node standalone-workspace-node",
                  standaloneWorkspaceCollapsed && "collapsed",
                )}
              >
                <div className="space-title standalone-workspace-title">
                  <button
                    aria-controls="standalone-workspace-thread-list"
                    aria-expanded={!standaloneWorkspaceCollapsed}
                    className="workspace-title-toggle standalone-workspace-toggle"
                    type="button"
                    onClick={() => toggleWorkspaceGroup("standalone")}
                  >
                    <ChevronRight aria-hidden="true" />
                    <strong>{copy.noWorkspace}</strong>
                  </button>
                  <span className="workspace-row-actions">
                    <button
                      aria-label={copy.newStandaloneThread}
                      type="button"
                      onClick={() => onNewThread(null)}
                    >
                      <SquarePen aria-hidden="true" />
                    </button>
                  </span>
                </div>
                <div
                  className="conversation-list recent-thread-list standalone-thread-list"
                  hidden={standaloneWorkspaceCollapsed}
                  id="standalone-workspace-thread-list"
                >
                  {standaloneThreads.map((thread) => (
                    <button
                      className={classNames(
                        "conversation-item linked-conversation-item recent-thread-item",
                        selectedLinkedThreadId === thread.id && "active",
                      )}
                      data-linked-thread-id={thread.id}
                      key={thread.id}
                      title={thread.preview}
                      type="button"
                      onClick={() => onOpenLinkedThread(thread.id)}
                    >
                      <span>{thread.title}</span>
                      <em>{thread.updatedLabel}</em>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      {workspaceAuthority === "legacy" && pendingRemoval ? (
        <WorkspaceRemoveDialog
          cancelLabel={copy.cancel}
          confirmLabel={copy.remove}
          hint={copy.removeWorkspaceHint}
          path={pendingRemoval}
          title={copy.removeWorkspaceTitle(workspaceName(pendingRemoval))}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => {
            removeWorkspace(pendingRemoval);
            setPendingRemoval(null);
          }}
        />
      ) : null}

      {account ? (
        <SidebarAccount
          account={account}
          locale={locale}
          onSettings={onOpenSettings}
        />
      ) : null}
    </aside>
  );
}

/**
 * Removal is not undoable, so it asks first and states what is *not* affected.
 * Users read "remove workspace" as "delete my folder", and the sidebar has no
 * way to walk that back.
 */
function WorkspaceRemoveDialog({
  cancelLabel,
  confirmLabel,
  hint,
  path,
  title,
  onCancel,
  onConfirm,
}: {
  cancelLabel: string;
  confirmLabel: string;
  hint: string;
  path: string;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="workspace-remove-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        aria-labelledby="workspace-remove-title"
        aria-modal="true"
        className="workspace-remove-dialog"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onCancel();
          }
        }}
      >
        <strong id="workspace-remove-title">{title}</strong>
        <code title={path}>{path}</code>
        <p>{hint}</p>
        <footer>
          <button autoFocus type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="danger" type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
export { Palette, paletteSearchKeyAction } from "./CommandWorkspacePalette";
