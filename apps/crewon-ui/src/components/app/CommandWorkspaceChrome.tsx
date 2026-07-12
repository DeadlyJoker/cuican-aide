import {
  BookOpen,
  Bot,
  CalendarDays,
  ChevronRight,
  ChevronUp,
  Folder,
  FolderOpen,
  KeyRound,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  Plus,
  SquarePen,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import { shellNavItems } from "./commandWorkspaceData";
import type {
  CommandHomeSlots,
  CommandPaletteItem,
  CommandShellView,
} from "./commandWorkspaceState";
import { classNames } from "./commandWorkspaceUtils";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import {
  type AgentPlatformAccount,
  useAgentPlatformAccount,
} from "../auth/AgentPlatformAuthGate";

export type PaletteItemWithCommand = CommandPaletteItem & {
  action?: "attach-files";
  command?: ComposerSlashCommand;
};

export type CommandLinkedThread = {
  cwd: string | null;
  id: string;
  preview: string;
  title: string;
  updatedLabel: string;
};

type SidebarSearchResult =
  | {
      action: "thread";
      detail: string;
      key: string;
      kind: "对话";
      threadId: string;
      title: string;
    }
  | {
      action: "view";
      detail: string;
      key: string;
      kind: "功能";
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

export function SidebarAccount({ account }: { account: AgentPlatformAccount }) {
  const displayName =
    (account.user.nickname || account.user.username).trim() ||
    account.user.username;
  const initial = displayName.charAt(0).toUpperCase() || "U";

  return (
    <footer
      aria-label="当前企业账号"
      className="sidebar-account"
      data-od-id="desktop-account-entry"
    >
      <details
        className="sidebar-account-menu"
        onBlur={(event) => {
          const nextTarget = event.relatedTarget;
          if (
            !(nextTarget instanceof Node) ||
            !event.currentTarget.contains(nextTarget)
          ) {
            event.currentTarget.removeAttribute("open");
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.removeAttribute("open");
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}
      >
        <summary aria-label={`账号菜单：${displayName}`} title="账号菜单">
          <span className="account-mark" aria-hidden="true">
            {initial}
          </span>
          <span className="sidebar-account-copy">
            <strong>{displayName}</strong>
            <small>{account.providerLabel}</small>
          </span>
          <span className="sidebar-account-chevron" aria-hidden="true">
            <ChevronUp />
          </span>
        </summary>
        <div className="sidebar-account-popover" role="menu">
          {account.needsPassword ? (
            <button
              role="menuitem"
              type="button"
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                account.onSetPassword();
              }}
            >
              <KeyRound aria-hidden="true" />
              <span>设置登录密码</span>
            </button>
          ) : null}
          <button
            className="danger"
            role="menuitem"
            type="button"
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              account.onLogout();
            }}
          >
            <LogOut aria-hidden="true" />
            <span>退出登录</span>
          </button>
        </div>
      </details>
    </footer>
  );
}

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
  query,
  selectedLinkedThreadId,
  slots,
  onCreateWorkspace,
  onNewThread,
  onOpenLinkedThread,
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
  query: string;
  selectedLinkedThreadId: string | null;
  slots: CommandHomeSlots;
  onCloseSearch: () => void;
  onCreateWorkspace?: (cwd: string) => void;
  onNewThread: (workspaceCwd: string | null) => void;
  onOpenLinkedThread: (threadId: string) => void;
  onQueryChange: (query: string) => void;
  onSwitchView: (view: CommandShellView) => void;
  onToggleCollapse: () => void;
  onToggleSearch: () => void;
}) {
  const account = useAgentPlatformAccount();
  const [workspaceFormOpen, setWorkspaceFormOpen] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState(cwd);
  const [collapsedWorkspaceGroups, setCollapsedWorkspaceGroups] = useState<
    Set<string>
  >(() => new Set());
  const currentWorkspaceName = workspaceName(cwd, "无工作空间");
  const currentWorkspaceThreads = linkedThreads
    .filter((thread) => Boolean(cwd) && thread.cwd === cwd)
    .slice(0, 5);
  const standaloneThreads = linkedThreads
    .filter((thread) => !thread.cwd)
    .slice(0, 5);
  const otherWorkspaceGroups = Array.from(
    linkedThreads.reduce((groups, thread) => {
      const threadCwd = thread.cwd?.trim();
      if (!threadCwd || threadCwd === cwd) {
        return groups;
      }
      const group = groups.get(threadCwd) ?? [];
      if (group.length < 5) {
        group.push(thread);
      }
      groups.set(threadCwd, group);
      return groups;
    }, new Map<string, CommandLinkedThread[]>()),
  )
    .slice(0, 8)
    .map(([path, threads]) => ({ path, threads }));

  useEffect(() => {
    setWorkspaceDraft(cwd);
  }, [cwd]);

  function submitWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = workspaceDraft.trim();
    if (!trimmed) {
      return;
    }
    onCreateWorkspace?.(trimmed);
    setWorkspaceFormOpen(false);
  }

  function toggleWorkspaceGroup(groupId: string) {
    setCollapsedWorkspaceGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  const currentWorkspaceCollapsed =
    Boolean(cwd) && collapsedWorkspaceGroups.has(cwd);
  const standaloneWorkspaceCollapsed =
    collapsedWorkspaceGroups.has("standalone");
  const sidebarSearchResults: SidebarSearchResult[] = [
    {
      action: "view" as const,
      detail: "智能体配置",
      key: "agent-platform-slot",
      kind: "功能" as const,
      title: slots.agent.title,
      view: "agents" as const,
    },
    ...linkedThreads.map((thread) => ({
      action: "thread" as const,
      detail: [
        workspaceName(thread.cwd ?? "", "无工作空间"),
        thread.preview || thread.updatedLabel,
      ]
        .filter(Boolean)
        .join(" · "),
      key: `thread-${thread.id}`,
      kind: "对话" as const,
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
    >
      <div className="sidebar-topbar" data-od-id="desktop-sidebar-topbar">
        <div className="traffic" aria-hidden="true">
          <span className="dot close" />
          <span className="dot min" />
          <span className="dot max" />
        </div>
        <div className="sidebar-tools" aria-label="侧栏工具">
          <button
            aria-label="折叠侧栏"
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
            aria-label="搜索"
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
            aria-label="搜索对话和能力"
            data-sidebar-search-input=""
            placeholder="搜索对话和能力"
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
          aria-label="搜索结果"
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
            没有匹配
          </p>
        </div>
      </section>

      <a
        className="sidebar-brand"
        data-od-id="desktop-brand"
        href="#view-command"
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
                onNewThread(null);
                return;
              }
              onSwitchView(item.key);
            }}
          >
            <span className="nav-glyph" aria-hidden="true">
              {viewIcons[item.key]}
            </span>
            <strong>{item.label}</strong>
            {item.meta ? <em>{item.meta}</em> : null}
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
          <strong>知识库</strong>
        </button>
      </nav>

      <section
        className="space-tree"
        data-od-id="desktop-workspace-tree"
        aria-label="工作空间和对话"
      >
        <div className="tree-head">
          <button type="button">工作空间</button>
          <button
            aria-expanded={workspaceFormOpen}
            aria-label="新增空间"
            className="tree-head-action"
            type="button"
            onClick={() => setWorkspaceFormOpen((open) => !open)}
          >
            <Plus aria-hidden="true" />
          </button>
        </div>
        <form
          className="sidebar-workspace-form"
          hidden={!workspaceFormOpen}
          onSubmit={submitWorkspace}
        >
          <label htmlFor="command-workspace-path">文件夹路径</label>
          <input
            id="command-workspace-path"
            placeholder="/Users/me/project"
            value={workspaceDraft}
            onChange={(event) => setWorkspaceDraft(event.target.value)}
          />
          <button
            type="submit"
            disabled={!workspaceDraft.trim() || !onCreateWorkspace}
          >
            打开
          </button>
        </form>
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
                  aria-expanded={workspaceFormOpen}
                  aria-label="新增空间"
                  type="button"
                  onClick={() => setWorkspaceFormOpen((open) => !open)}
                >
                  <MoreHorizontal aria-hidden="true" />
                </button>
                <button
                  aria-label="新建会话"
                  type="button"
                  onClick={() => onNewThread(cwd)}
                >
                  <SquarePen aria-hidden="true" />
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
                  开始一次任务后，会话会出现在这个工作空间下。
                </p>
              )}
            </div>
          </div>
        ) : standaloneThreads.length === 0 &&
          otherWorkspaceGroups.length === 0 ? (
          <p className="sidebar-empty-hint workspace-empty-hint">
            当前没有绑定文件夹空间，可以新增空间或直接开始无空间会话。
          </p>
        ) : null}
        {otherWorkspaceGroups.map((group, index) => {
          const name = workspaceName(group.path);
          return (
            <div className="space-node real-workspace-node" key={group.path}>
              <div className="space-title real-workspace-title">
                <button
                  aria-controls={`other-workspace-thread-list-${index}`}
                  aria-label={`切换到工作空间 ${name}`}
                  className="workspace-title-toggle"
                  type="button"
                  onClick={() => onCreateWorkspace?.(group.path)}
                >
                  <Folder aria-hidden="true" />
                  <strong>{name}</strong>
                </button>
                <span className="workspace-row-actions">
                  <button
                    aria-label={`在工作空间 ${name} 中新建会话`}
                    type="button"
                    onClick={() => onNewThread(group.path)}
                  >
                    <SquarePen aria-hidden="true" />
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
                <strong>无工作空间</strong>
              </button>
              <span className="workspace-row-actions">
                <button
                  aria-label="新建无工作空间会话"
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
      </section>

      {account ? <SidebarAccount account={account} /> : null}
    </aside>
  );
}
export function Palette({
  id,
  inputId,
  items,
  kind,
  open,
  placeholder,
  query,
  onClose,
  onQueryChange,
  onSelect,
}: {
  id: string;
  inputId: string;
  items: PaletteItemWithCommand[];
  kind: "add" | "context" | "slash";
  open: boolean;
  placeholder: string;
  query: string;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onSelect: (item: PaletteItemWithCommand) => void;
}) {
  const addGroups =
    kind === "add"
      ? [
          {
            id: "files",
            label: "文件",
            items: items.filter((item) => item.kind === "file"),
          },
          {
            id: "knowledge",
            label: "知识库",
            items: items.filter((item) => item.kind === "knowledge"),
          },
          {
            id: "skills",
            label: "Skill",
            items: items.filter((item) => item.kind === "skill"),
          },
          {
            id: "mcp",
            label: "MCP",
            items: items.filter((item) => item.kind === "mcp"),
          },
        ].filter((group) => group.items.length > 0)
      : [];

  function renderItem(item: PaletteItemWithCommand) {
    return (
      <button
        data-context-item={kind === "context" ? "" : undefined}
        data-kind={item.kind}
        data-label={item.title}
        data-slash-item={kind === "slash" ? "" : undefined}
        key={`${item.kind}-${item.title}-${item.token ?? ""}`}
        type="button"
        onClick={() => onSelect(item)}
      >
        <span>{item.label}</span>
        <strong>{item.title}</strong>
        <em>{item.detail}</em>
      </button>
    );
  }

  return (
    <div
      className={
        kind === "slash"
          ? "slash-palette"
          : kind === "add"
            ? "context-palette add-palette"
            : "context-palette"
      }
      data-context-palette={kind === "context" ? "" : undefined}
      data-od-id={id}
      data-composer-palette=""
      data-slash-palette={kind === "slash" ? "" : undefined}
      hidden={!open}
      id={id}
    >
      <label className="visually-hidden" htmlFor={inputId}>
        {placeholder}
      </label>
      <input
        id={inputId}
        placeholder={placeholder}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter" && items[0]) {
            event.preventDefault();
            onSelect(items[0]);
          }
        }}
      />
      <div className={kind === "slash" ? "slash-list" : "context-list"}>
        {kind === "add"
          ? addGroups.map((group) => (
              <section className="add-palette-group" key={group.id}>
                <div className="add-palette-group-label">{group.label}</div>
                {group.items.map(renderItem)}
              </section>
            ))
          : items.map(renderItem)}
        {items.length === 0 ? (
          <button disabled type="button">
            <span>空</span>
            <strong>没有匹配结果</strong>
            <em>换一个关键词继续搜索</em>
          </button>
        ) : null}
      </div>
    </div>
  );
}
