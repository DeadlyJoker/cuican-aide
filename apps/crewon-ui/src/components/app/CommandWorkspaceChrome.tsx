import {
  BookOpen,
  Bot,
  CalendarDays,
  FolderOpen,
  PanelLeft,
  Plus,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

import { shellNavItems, workspaceNodes } from "./commandWorkspaceData";
import {
  conversationBindingKey,
  findLinkedThreadForConversation,
  type ConversationThreadBindings,
} from "./commandWorkspaceThreadLinks";
import type {
  CommandHomeSlots,
  CommandPaletteItem,
  CommandShellView,
} from "./commandWorkspaceState";
import { classNames } from "./commandWorkspaceUtils";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";

export type PaletteItemWithCommand = CommandPaletteItem & {
  command?: ComposerSlashCommand;
};

export type CommandLinkedThread = {
  id: string;
  preview: string;
  title: string;
  updatedLabel: string;
};

type PlatformLoadState = "loading" | "ready" | "fallback";

type SidebarSearchResult =
  | {
      action: "conversation";
      detail: string;
      key: string;
      kind: "Chat" | "Space";
      spaceId: string;
      title: string;
      conversation: string;
    }
  | {
      action: "thread";
      detail: string;
      key: string;
      kind: "Thread";
      threadId: string;
      title: string;
    }
  | {
      action: "view";
      detail: string;
      key: string;
      kind: "Agent";
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

export function CommandSidebar({
  activeConversation,
  activeSpaceId,
  activeView,
  collapsedSpaces,
  conversationThreadBindings,
  isSearchOpen,
  linkedThreads = [],
  query,
  selectedLinkedThreadId,
  slots,
  onChooseConversation,
  onOpenLinkedThread,
  onCloseSearch,
  onQueryChange,
  onSwitchView,
  onToggleCollapse,
  onToggleSearch,
  onToggleSpace,
}: {
  activeConversation: string;
  activeSpaceId: string;
  activeView: CommandShellView;
  collapsedSpaces: Set<string>;
  conversationThreadBindings: ConversationThreadBindings;
  isSearchOpen: boolean;
  linkedThreads: CommandLinkedThread[];
  query: string;
  selectedLinkedThreadId: string | null;
  slots: CommandHomeSlots;
  onChooseConversation: (spaceId: string, conversation: string) => void;
  onCloseSearch: () => void;
  onOpenLinkedThread: (threadId: string) => void;
  onQueryChange: (query: string) => void;
  onSwitchView: (view: CommandShellView) => void;
  onToggleCollapse: () => void;
  onToggleSearch: () => void;
  onToggleSpace: (spaceId: string) => void;
}) {
  const recentLinkedThreads = linkedThreads.slice(0, 5);
  const sidebarSearchResults: SidebarSearchResult[] = [
    ...workspaceNodes.flatMap((node) => {
      const firstConversation = node.conversations[0]?.title ?? node.title;
      return [
        {
          action: "conversation" as const,
          conversation: firstConversation,
          detail: node.conversations
            .map((conversation) => conversation.title)
            .join(" · "),
          key: `space-${node.id}`,
          kind: "Space" as const,
          spaceId: node.id,
          title: node.title,
        },
        ...node.conversations.map((conversation) => ({
          action: "conversation" as const,
          conversation: conversation.title,
          detail: [node.title, ...conversation.aliases].join(" · "),
          key: `chat-${node.id}-${conversation.title}`,
          kind: "Chat" as const,
          spaceId: node.id,
          title: conversation.title,
        })),
      ];
    }),
    {
      action: "view" as const,
      detail: "智能体配置",
      key: "agent-platform-slot",
      kind: "Agent" as const,
      title: slots.agent.title,
      view: "agents" as const,
    },
    ...linkedThreads.map((thread) => ({
      action: "thread" as const,
      detail: thread.preview || thread.updatedLabel,
      key: `thread-${thread.id}`,
      kind: "Thread" as const,
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
    } else if (item.action === "view") {
      onSwitchView(item.view);
    } else {
      onSwitchView("command");
      onChooseConversation(item.spaceId, item.conversation);
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
            aria-label="搜索空间、会话、能力和智能体"
            data-sidebar-search-input=""
            placeholder="搜索空间、会话、能力和智能体"
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
            onClick={() => onSwitchView(item.key)}
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
        aria-label="工作空间"
      >
        <div className="tree-head">
          <button type="button">空间</button>
          <button className="tree-add" type="button" aria-label="新建空间">
            +
          </button>
        </div>
        {workspaceNodes.map((node) => {
          const collapsed = collapsedSpaces.has(node.id);
          return (
            <div
              className={classNames(
                "space-node",
                activeSpaceId === node.id && "current",
                collapsed && "collapsed",
              )}
              data-od-id={`workspace-node-${node.id}`}
              key={node.id}
            >
              <button
                className="space-title"
                type="button"
                onClick={() => onToggleSpace(node.id)}
              >
                <span aria-hidden="true">{collapsed ? "›" : node.icon}</span>
                <strong>{node.title}</strong>
              </button>
              <div
                className={classNames(
                  "conversation-list",
                  node.conversations.length < 3 && "compact",
                )}
                hidden={collapsed}
              >
                {node.conversations.map((conversation) => {
                  const bindingKey = conversationBindingKey(
                    node.id,
                    conversation.title,
                  );
                  const linkedThread = findLinkedThreadForConversation(
                    linkedThreads,
                    conversation.title,
                    conversation.aliases,
                    conversationThreadBindings[bindingKey],
                  );
                  return (
                    <button
                      className={classNames(
                        "conversation-item",
                        linkedThread && "is-linked",
                        ((activeSpaceId === node.id &&
                          activeConversation === conversation.title) ||
                          selectedLinkedThreadId === linkedThread?.id) &&
                          "active",
                      )}
                      data-linked-thread-id={linkedThread?.id}
                      key={conversation.title}
                      title={
                        linkedThread
                          ? `已连接后端会话：${linkedThread.title}`
                          : undefined
                      }
                      type="button"
                      onClick={() =>
                        onChooseConversation(node.id, conversation.title)
                      }
                    >
                      {conversation.title}
                    </button>
                  );
                })}
                {node.id === "product" && recentLinkedThreads.length > 0 ? (
                  <div className="linked-conversation-group">
                    <span className="linked-conversation-label">后端会话</span>
                    {recentLinkedThreads.map((thread) => (
                      <button
                        className={classNames(
                          "conversation-item linked-conversation-item",
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
                ) : null}
              </div>
            </div>
          );
        })}
      </section>

      <footer className="sidebar-account" data-od-id="desktop-account-entry">
        <span className="account-mark">R</span>
        <strong>Turning_Around</strong>
        <button className="locale-toggle" type="button">
          EN
        </button>
      </footer>
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
  kind: "context" | "slash";
  open: boolean;
  placeholder: string;
  query: string;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onSelect: (item: PaletteItemWithCommand) => void;
}) {
  return (
    <div
      className={kind === "context" ? "context-palette" : "slash-palette"}
      data-context-palette={kind === "context" ? "" : undefined}
      data-od-id={id}
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
      <div className={kind === "context" ? "context-list" : "slash-list"}>
        {items.map((item) => (
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
        ))}
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

export function ResourceDock({
  platformState,
  slots,
}: {
  platformState: PlatformLoadState;
  slots: CommandHomeSlots;
}) {
  const resources = [
    slots.agent,
    slots.skills[0],
    slots.mcps[0],
    slots.knowledge,
    slots.workflow,
  ];
  return (
    <section className="resource-dock" data-od-id="capability-dock">
      <header>
        <strong>Agent / Skill / MCP / Knowledge / Workflow</strong>
        <span>
          {platformState === "ready"
            ? "资源入口已就绪"
            : platformState === "fallback"
              ? "可选资源服务未启动，对话后端可用"
              : "同步中"}
        </span>
      </header>
      <div className="resource-grid">
        {resources.map((resource, index) => (
          <article className="resource-card" key={`${resource.value}-${index}`}>
            <span>{resource.label}</span>
            <strong>{resource.title}</strong>
            <p>{resource.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
