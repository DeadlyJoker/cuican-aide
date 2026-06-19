import { Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Locale } from "../lib/i18n";
import {
  filterSidebarThreads,
  groupSidebarThreads,
  sidebarNavLabels,
} from "./SidebarPresentation";
import { SidebarPrimaryNav, type SidebarLibraryKind } from "./SidebarPrimaryNav";
import { SidebarSearchBox } from "./SidebarSearchBox";
import { SidebarThreadList } from "./SidebarThreadList";

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
  activeLibraryKind?: SidebarLibraryKind | null;
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
  const navLabels = sidebarNavLabels(locale);
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const filteredThreads = useMemo(
    () =>
      filterSidebarThreads({
        controlledSearch: searchValue !== undefined,
        searchTerm,
        threads,
      }),
    [searchTerm, searchValue, threads],
  );
  const { projectGroups, standaloneThreads } = useMemo(
    () => groupSidebarThreads(filteredThreads),
    [filteredThreads],
  );
  function clearSearch() {
    setLocalSearchTerm("");
    onSearchChange?.("");
    searchInputRef.current?.focus();
  }

  function updateSearch(value: string) {
    setLocalSearchTerm(value);
    onSearchChange?.(value);
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
      <SidebarPrimaryNav
        activeLibraryKind={activeLibraryKind}
        locale={locale}
        newThreadLabel={newThreadLabel}
        newThreadShortcutLabel={newThreadShortcutLabel}
        searchPlaceholder={searchPlaceholder}
        workspaceLabel={workspaceLabel}
        onAgents={onAgents}
        onAutomation={onAutomation}
        onFocusSearch={focusSearch}
        onKnowledge={onKnowledge}
        onNewThread={onNewThread}
        onOffice={onOffice}
        onPlugins={onPlugins}
        onTools={onTools}
      />

      {isSearchOpen || searchTerm ? (
        <SidebarSearchBox
          clearSearchLabel={clearSearchLabel}
          searchInputRef={searchInputRef}
          searchPlaceholder={searchPlaceholder}
          searchShortcutLabel={searchShortcutLabel}
          searchTerm={searchTerm}
          onClearSearch={clearSearch}
          onSearchChange={updateSearch}
          onSearchKeyDown={handleSearchKeyDown}
        />
      ) : null}

      <SidebarThreadList
        activeThreadsLabel={activeThreadsLabel}
        archiveThreadLabel={archiveThreadLabel}
        archivedThreadsLabel={archivedThreadsLabel}
        deleteThreadLabel={deleteThreadLabel}
        emptyLabel={noThreadsFoundLabel}
        isLoading={isLoading}
        loadingLabel={loadingThreadsLabel}
        locale={locale}
        navLabels={navLabels}
        normalizedSearchTerm={normalizedSearchTerm}
        projectGroups={projectGroups}
        renameThreadLabel={renameThreadLabel}
        selectedThreadId={selectedThreadId}
        showArchived={showArchived}
        standaloneThreads={standaloneThreads}
        threadsSectionLabel={threadsSectionLabel}
        untitledThreadLabel={untitledThreadLabel}
        onArchiveThread={onArchiveThread}
        onDeleteThread={onDeleteThread}
        onRenameThread={onRenameThread}
        onSelectThread={onSelectThread}
        onToggleArchived={onToggleArchived}
      />

      <div className="sidebar-footer">
        <button className="sidebar-command" type="button" aria-label={settingsLabel} title={settingsLabel} onClick={onSettings}>
          <Settings2 size={15} />
          <span>{settingsLabel}</span>
        </button>
      </div>
    </aside>
  );
}
