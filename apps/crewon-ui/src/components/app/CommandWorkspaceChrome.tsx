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

type PlatformLoadState = "loading" | "ready" | "fallback";

const viewIcons: Record<CommandShellView, ReactNode> = {
  command: <Plus aria-hidden="true" />,
  assist: <Sparkles aria-hidden="true" />,
  projects: <FolderOpen aria-hidden="true" />,
  agents: <Bot aria-hidden="true" />,
  schedule: <CalendarDays aria-hidden="true" />,
  team: <Users aria-hidden="true" />,
};

export function CommandSidebar({
  activeConversation,
  activeSpaceId,
  activeView,
  collapsedSpaces,
  isSearchOpen,
  query,
  slots,
  onChooseConversation,
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
  isSearchOpen: boolean;
  query: string;
  slots: CommandHomeSlots;
  onChooseConversation: (spaceId: string, conversation: string) => void;
  onQueryChange: (query: string) => void;
  onSwitchView: (view: CommandShellView) => void;
  onToggleCollapse: () => void;
  onToggleSearch: () => void;
  onToggleSpace: (spaceId: string) => void;
}) {
  const sidebarSearchResults = [
    ["Space", "Agent 小队交付空间", "当前空间"],
    ["Chat", "小队创建草稿", "Agent 小队交付空间"],
    ["Space", "Skill/MCP 能力空间", "Schema · Sandbox"],
    ["Agent", slots.agent.title, "智能体配置"],
  ].filter((item) =>
    item.join(" ").toLowerCase().includes(query.trim().toLowerCase()),
  );

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
          />
          <kbd>⌘K</kbd>
        </div>
        <div className="sidebar-search-results" role="listbox" aria-label="搜索结果">
          {sidebarSearchResults.map(([kind, title, detail]) => (
            <button
              className="sidebar-search-result"
              data-search-result=""
              key={`${kind}-${title}`}
              type="button"
            >
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
              <em>{kind}</em>
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
          data-run-title-zh="知识库"
          data-run-title-en="Knowledge base"
          type="button"
          onClick={() => onSwitchView("agents")}
        >
          <span className="nav-glyph" aria-hidden="true">
            <BookOpen aria-hidden="true" />
          </span>
          <strong>知识库</strong>
        </button>
      </nav>

      <section className="space-tree" data-od-id="desktop-workspace-tree" aria-label="工作空间">
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
                {node.conversations.map((conversation) => (
                  <button
                    className={classNames(
                      "conversation-item",
                      activeSpaceId === node.id &&
                        activeConversation === conversation &&
                        "active",
                    )}
                    key={conversation}
                    type="button"
                    onClick={() => onChooseConversation(node.id, conversation)}
                  >
                    {conversation}
                  </button>
                ))}
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
              ? "资源服务未连接"
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
