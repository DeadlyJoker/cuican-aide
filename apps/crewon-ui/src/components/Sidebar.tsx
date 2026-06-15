import { Archive, AtSign, BookOpen, Bot, BriefcaseBusiness, Clock3, FolderClosed, Pencil, Plus, RotateCcw, Search, Settings2, Trash2, Wrench, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Locale } from "../lib/i18n";
import { formatRelativeTime, formatThreadTimestamp } from "../lib/text";

type SidebarProps = {
  threads: Thread[];
  selectedThreadId: string | null;
  clearSearchLabel: string;
  newThreadLabel: string;
  newThreadShortcutLabel: string;
  noThreadsFoundLabel: string;
  searchPlaceholder: string;
  searchShortcutLabel: string;
  settingsLabel: string;
  threadsSectionLabel: string;
  untitledThreadLabel: string;
  workspaceLabel: string;
  archiveThreadLabel: string;
  deleteThreadLabel: string;
  renameThreadLabel: string;
  archivedThreadsLabel: string;
  activeThreadsLabel: string;
  activeLibraryKind?: "plugins" | "tools" | "agents" | "office" | "automation" | "knowledge" | null;
  showArchived: boolean;
  isLoading: boolean;
  searchValue?: string;
  locale: Locale;
  loadingThreadsLabel: string;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onArchiveThread: (thread: Thread) => void;
  onDeleteThread: (thread: Thread) => void;
  onAgents: () => void;
  onAutomation: () => void;
  onOffice: () => void;
  onPlugins: () => void;
  onKnowledge: () => void;
  onSearchChange?: (value: string) => void;
  onRenameThread: (thread: Thread) => void;
  onSettings: () => void;
  onTools: () => void;
  onToggleArchived: () => void;
};

function threadTitle(thread: Thread, fallback: string): string {
  return thread.name || thread.preview || fallback;
}

function workspaceName(cwd: string): string {
  const normalizedCwd = cwd.replace(/\/+$/, "");
  return normalizedCwd.split("/").filter(Boolean).pop() || normalizedCwd || "Workspace";
}

type ProjectSessionGroup = {
  cwd: string;
  name: string;
  threads: Thread[];
};

export function Sidebar({
  threads,
  selectedThreadId,
  clearSearchLabel,
  newThreadLabel,
  newThreadShortcutLabel,
  noThreadsFoundLabel,
  searchPlaceholder,
  searchShortcutLabel,
  settingsLabel,
  threadsSectionLabel,
  untitledThreadLabel,
  workspaceLabel,
  archiveThreadLabel,
  deleteThreadLabel,
  renameThreadLabel,
  archivedThreadsLabel,
  activeThreadsLabel,
  activeLibraryKind = null,
  showArchived,
  isLoading,
  searchValue,
  locale,
  loadingThreadsLabel,
  onSelectThread,
  onNewThread,
  onArchiveThread,
  onDeleteThread,
  onAgents,
  onAutomation,
  onOffice,
  onPlugins,
  onKnowledge,
  onSearchChange,
  onRenameThread,
  onSettings,
  onTools,
  onToggleArchived,
}: SidebarProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [localSearchTerm, setLocalSearchTerm] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchTerm = searchValue ?? localSearchTerm;
  const navLabels =
    locale === "zh"
      ? { plugins: "插件", tools: "工具", agents: "智能体", office: "办公室", automation: "自动化", knowledge: "知识库", project: "项目", conversations: "对话", session: "会话" }
      : { plugins: "Plugins", tools: "Tools", agents: "Agents", office: "Office", automation: "Automations", knowledge: "Knowledge", project: "Projects", conversations: "Chats", session: "Sessions" };
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const filteredThreads = useMemo(() => {
    if (searchValue !== undefined) {
      return threads;
    }

    if (!normalizedSearchTerm) {
      return threads;
    }

    return threads.filter((thread) =>
      [thread.name, thread.preview, thread.cwd, thread.modelProvider]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(normalizedSearchTerm)),
    );
  }, [normalizedSearchTerm, searchValue, threads]);
  const { projectGroups, standaloneThreads } = useMemo(() => {
    const groups = new Map<string, ProjectSessionGroup>();
    const standalone: Thread[] = [];

    for (const thread of filteredThreads) {
      const cwd = thread.cwd?.trim();

      if (!cwd) {
        standalone.push(thread);
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
      standaloneThreads: standalone,
    };
  }, [filteredThreads]);
  const hasVisibleThreads = filteredThreads.length > 0;

  function renderSessionRow(thread: Thread) {
    const title = threadTitle(thread, untitledThreadLabel);
    const actionLabel = showArchived ? activeThreadsLabel : archiveThreadLabel;

    return (
      <div
        className={clsx("thread-row", selectedThreadId === thread.id && "selected")}
        aria-current={selectedThreadId === thread.id ? "page" : undefined}
        key={thread.id}
      >
        <button className="thread-row-main" type="button" onClick={() => onSelectThread(thread.id)}>
          <span className="thread-row-top">
            <span className="thread-title">{title}</span>
            <span className="thread-time" title={formatThreadTimestamp(thread.updatedAt, locale)}>
              {formatRelativeTime(thread.updatedAt, locale)}
            </span>
          </span>
        </button>
        <span className="thread-row-actions">
          <button className="thread-row-action" type="button" aria-label={renameThreadLabel} title={renameThreadLabel} onClick={() => onRenameThread(thread)}>
            <Pencil size={12} />
          </button>
          <button className="thread-row-action" type="button" aria-label={actionLabel} title={actionLabel} onClick={() => onArchiveThread(thread)}>
            {showArchived ? <RotateCcw size={13} /> : <Archive size={13} />}
          </button>
          {showArchived ? (
            <button className="thread-row-action" type="button" aria-label={deleteThreadLabel} title={deleteThreadLabel} onClick={() => onDeleteThread(thread)}>
              <Trash2 size={13} />
            </button>
          ) : null}
        </span>
      </div>
    );
  }

  function renderArchivedToggle() {
    return (
      <button className="thread-section-action" type="button" onClick={onToggleArchived}>
        {showArchived ? activeThreadsLabel : archivedThreadsLabel}
      </button>
    );
  }

  function renderStandaloneThreads() {
    if (standaloneThreads.length > 0) {
      return standaloneThreads.map(renderSessionRow);
    }

    if (showArchived && projectGroups.length > 0) {
      return null;
    }

    return null;
  }

  function renderCurrentSectionLabel() {
    return (
      <div className="thread-section-label">
        <span>{showArchived ? archivedThreadsLabel : navLabels.project}</span>
        {renderArchivedToggle()}
      </div>
    );
  }

  function renderStandaloneSectionLabel() {
    return (
      <div className="thread-section-label is-subtle">
        <span>{showArchived ? navLabels.session : navLabels.conversations}</span>
      </div>
    );
  }

  function clearSearch() {
    setLocalSearchTerm("");
    onSearchChange?.("");
    searchInputRef.current?.focus();
  }

  function focusSearch() {
    setIsSearchOpen(true);
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") {
      return;
    }

    event.stopPropagation();
    if (searchTerm) {
      setLocalSearchTerm("");
      onSearchChange?.("");
      return;
    }

    setIsSearchOpen(false);
    searchInputRef.current?.blur();
  }

  useEffect(() => {
    if (!isSearchOpen) {
      return;
    }

    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [isSearchOpen]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusSearch();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <aside className="sidebar">
      <nav className="sidebar-primary-nav" aria-label={workspaceLabel}>
        <button type="button" title={newThreadShortcutLabel ? `${newThreadLabel} (${newThreadShortcutLabel})` : newThreadLabel} onClick={() => onNewThread()}>
          <Plus size={14} />
          <span>{newThreadLabel}</span>
        </button>
        <button type="button" onClick={focusSearch}>
          <Search size={14} />
          <span>{searchPlaceholder}</span>
        </button>
        <button type="button" data-active={activeLibraryKind === "plugins"} onClick={onPlugins}>
          <AtSign size={14} />
          <span>{navLabels.plugins}</span>
        </button>
        <button type="button" data-active={activeLibraryKind === "tools"} onClick={onTools}>
          <Wrench size={14} />
          <span>{navLabels.tools}</span>
        </button>
        <button type="button" data-active={activeLibraryKind === "agents"} onClick={onAgents}>
          <Bot size={14} />
          <span>{navLabels.agents}</span>
        </button>
        <button type="button" data-active={activeLibraryKind === "office"} onClick={onOffice}>
          <BriefcaseBusiness size={14} />
          <span>{navLabels.office}</span>
        </button>
        <button type="button" data-active={activeLibraryKind === "automation"} onClick={onAutomation}>
          <Clock3 size={14} />
          <span>{navLabels.automation}</span>
        </button>
        <button type="button" data-active={activeLibraryKind === "knowledge"} onClick={onKnowledge}>
          <BookOpen size={14} />
          <span>{navLabels.knowledge}</span>
        </button>
      </nav>

      {isSearchOpen || searchTerm ? (
        <label className="search-box">
          <Search size={15} />
          <input
            ref={searchInputRef}
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            value={searchTerm}
            onKeyDown={handleSearchKeyDown}
            onChange={(event) => {
              setLocalSearchTerm(event.target.value);
              onSearchChange?.(event.target.value);
            }}
          />
          {searchTerm ? (
            <button className="search-clear-button" type="button" aria-label={clearSearchLabel} title={clearSearchLabel} onClick={clearSearch}>
              <X size={13} />
            </button>
          ) : (
            <span className="search-shortcut" aria-hidden="true">
              {searchShortcutLabel}
            </span>
          )}
        </label>
      ) : null}

      {renderCurrentSectionLabel()}

      <nav className="thread-list" aria-label={threadsSectionLabel}>
        {projectGroups.map((group) => (
          <section className="project-session-group" aria-label={`${group.name} ${navLabels.session}`} key={group.cwd}>
            <div className="project-row" title={group.cwd}>
              <FolderClosed size={14} />
              <strong>{group.name}</strong>
            </div>
            <div className="project-session-list">{group.threads.map(renderSessionRow)}</div>
          </section>
        ))}

        {renderStandaloneSectionLabel()}
        <div className="project-session-list standalone-session-list">
          {renderStandaloneThreads()}
        </div>

        {!hasVisibleThreads && isLoading && !normalizedSearchTerm ? (
          <div className="thread-loading-state" aria-label={loadingThreadsLabel} aria-live="polite">
            <span>{loadingThreadsLabel}</span>
            <div aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </div>
        ) : null}
        {!hasVisibleThreads && (!isLoading || normalizedSearchTerm) ? (
          <div className="thread-empty-state" aria-live="polite">
            {noThreadsFoundLabel}
          </div>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-command" type="button" aria-label={settingsLabel} title={settingsLabel} onClick={onSettings}>
          <Settings2 size={15} />
          <span>{settingsLabel}</span>
        </button>
      </div>
    </aside>
  );
}
