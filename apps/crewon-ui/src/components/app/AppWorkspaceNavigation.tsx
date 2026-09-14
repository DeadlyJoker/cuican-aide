import type { ThreadCatalogNavigation } from "../../lib/thread/threadCatalogNavigation";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import { Sidebar } from "../Sidebar";
import { SettingsNavigation } from "../settings/SettingsNavigation";
import type { AppView } from "../../lib/shared/appView";
import type { LibraryKind } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import type { PlatformKind } from "../../lib/platform";
import type { ProjectSessionGroup } from "../SidebarPresentation";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";

type AppWorkspaceNavigationProps = {
  threadCatalogNavigation?: ThreadCatalogNavigation;
  activeLibraryKind: LibraryKind | null;
  activeSection: SettingsSection;
  appView: AppView;
  archivedThreadsLabel: string;
  archiveThreadLabel: string;
  clearSearchLabel: string;
  deleteThreadLabel: string;
  archiveWorkspaceLabel: string;
  deleteWorkspaceLabel: string;
  isLoading: boolean;
  loadingThreadsLabel: string;
  locale: Locale;
  newThreadLabel: string;
  newThreadShortcutLabel: string;
  noThreadsFoundLabel: string;
  platform: PlatformKind;
  renameThreadLabel: string;
  searchPlaceholder: string;
  searchShortcutLabel: string;
  searchValue: string;
  selectedThreadId: string | null;
  settingsLabel: string;
  showArchived: boolean;
  threads: Thread[];
  threadsSectionLabel: string;
  untitledThreadLabel: string;
  workspaceLabel: string;
  activeThreadsLabel: string;
  onArchiveThread: (thread: Thread) => void;
  onBackSettings: () => void;
  onDeleteThread: (thread: Thread) => void;
  onArchiveWorkspaceThreads: (group: ProjectSessionGroup) => void;
  onDeleteWorkspaceThreads: (group: ProjectSessionGroup) => void;
  onLibrary: (kind: LibraryKind) => void;
  onNewThread: () => void;
  onRenameThread: (thread: Thread) => void;
  onSearchChange: (value: string) => void;
  onSelectThread: (threadId: string) => void;
  onSettings: () => void;
  onSettingsSectionChange: (section: SettingsSection) => void;
  onToggleArchived: () => void;
};

export function AppWorkspaceNavigation({
  threadCatalogNavigation,
  activeLibraryKind,
  activeSection,
  appView,
  archivedThreadsLabel,
  archiveThreadLabel,
  clearSearchLabel,
  deleteThreadLabel,
  archiveWorkspaceLabel,
  deleteWorkspaceLabel,
  isLoading,
  loadingThreadsLabel,
  locale,
  newThreadLabel,
  newThreadShortcutLabel,
  noThreadsFoundLabel,
  platform,
  renameThreadLabel,
  searchPlaceholder,
  searchShortcutLabel,
  searchValue,
  selectedThreadId,
  settingsLabel,
  showArchived,
  threads,
  threadsSectionLabel,
  untitledThreadLabel,
  workspaceLabel,
  activeThreadsLabel,
  onArchiveThread,
  onBackSettings,
  onDeleteThread,
  onArchiveWorkspaceThreads,
  onDeleteWorkspaceThreads,
  onLibrary,
  onNewThread,
  onRenameThread,
  onSearchChange,
  onSelectThread,
  onSettings,
  onSettingsSectionChange,
  onToggleArchived,
}: AppWorkspaceNavigationProps) {
  if (appView === "settings") {
    return (
      <SettingsNavigation
        activeSection={activeSection}
        locale={locale}
        onBack={onBackSettings}
        onSectionChange={onSettingsSectionChange}
      />
    );
  }

  return (
    <Sidebar
      threadCatalogNavigation={threadCatalogNavigation}
      threads={threads}
      selectedThreadId={selectedThreadId}
      clearSearchLabel={clearSearchLabel}
      newThreadLabel={newThreadLabel}
      newThreadShortcutLabel={newThreadShortcutLabel}
      noThreadsFoundLabel={noThreadsFoundLabel}
      searchPlaceholder={searchPlaceholder}
      searchShortcutLabel={searchShortcutLabel}
      settingsLabel={settingsLabel}
      threadsSectionLabel={threadsSectionLabel}
      untitledThreadLabel={untitledThreadLabel}
      workspaceLabel={workspaceLabel}
      archiveThreadLabel={archiveThreadLabel}
      deleteThreadLabel={deleteThreadLabel}
      renameThreadLabel={renameThreadLabel}
      archivedThreadsLabel={archivedThreadsLabel}
      activeThreadsLabel={activeThreadsLabel}
      archiveWorkspaceLabel={archiveWorkspaceLabel}
      deleteWorkspaceLabel={deleteWorkspaceLabel}
      activeLibraryKind={activeLibraryKind}
      showArchived={showArchived}
      isLoading={isLoading}
      searchValue={searchValue}
      locale={locale}
      loadingThreadsLabel={loadingThreadsLabel}
      onSelectThread={onSelectThread}
      onNewThread={onNewThread}
      onArchiveThread={onArchiveThread}
      onDeleteThread={onDeleteThread}
      onArchiveWorkspaceThreads={onArchiveWorkspaceThreads}
      onDeleteWorkspaceThreads={onDeleteWorkspaceThreads}
      onAgents={() => onLibrary("agents")}
      onAutomation={() => onLibrary("automation")}
      onPlugins={() => onLibrary("plugins")}
      onKnowledge={() => onLibrary("knowledge")}
      onSearchChange={onSearchChange}
      onRenameThread={onRenameThread}
      onSettings={onSettings}
      onTools={() => onLibrary("tools")}
      onToggleArchived={onToggleArchived}
    />
  );
}
