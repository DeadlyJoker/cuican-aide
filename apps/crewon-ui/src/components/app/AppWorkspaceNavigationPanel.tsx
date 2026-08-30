import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import { AppWorkspaceNavigation } from "./AppWorkspaceNavigation";
import type { AppView } from "../../lib/shared/appView";
import type { ConnectionState } from "../../lib/shared/connectionState";
import type { LibraryKind } from "../../lib/domain/crewonDomain";
import {
  translate,
  type Locale,
} from "../../lib/i18n";
import type { PlatformKind } from "../../lib/platform";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";

type AppWorkspaceNavigationPanelProps = {
  activeLibraryKind: LibraryKind | null;
  activeSection: SettingsSection;
  appView: AppView;
  connectionState: ConnectionState;
  isSearchingThreads: boolean;
  locale: Locale;
  platform: PlatformKind;
  searchValue: string;
  selectedThreadId: string | null;
  showArchived: boolean;
  threads: Thread[];
  onArchiveThread: (thread: Thread) => void;
  onBackSettings: () => void;
  onDeleteThread: (thread: Thread) => void;
  onLibrary: (kind: LibraryKind) => void;
  onNewThread: () => void;
  onRenameThread: (thread: Thread) => void;
  onSearchChange: (value: string) => void;
  onSelectThread: (threadId: string) => void;
  onSettings: () => void;
  onSettingsSectionChange: (section: SettingsSection) => void;
  onToggleArchived: () => void;
};

export function AppWorkspaceNavigationPanel({
  activeLibraryKind,
  activeSection,
  appView,
  connectionState,
  isSearchingThreads,
  locale,
  platform,
  searchValue,
  selectedThreadId,
  showArchived,
  threads,
  onArchiveThread,
  onBackSettings,
  onDeleteThread,
  onLibrary,
  onNewThread,
  onRenameThread,
  onSearchChange,
  onSelectThread,
  onSettings,
  onSettingsSectionChange,
  onToggleArchived,
}: AppWorkspaceNavigationPanelProps) {
  const t = translate(locale);
  const searchShortcutLabel = platform === "mac" ? "⌘K" : "Ctrl K";
  const newThreadShortcutLabel = platform === "mac" ? "⌘N" : "Ctrl N";

  return (
    <AppWorkspaceNavigation
      activeLibraryKind={activeLibraryKind}
      activeSection={activeSection}
      appView={appView}
      archivedThreadsLabel={locale === "zh" ? "已归档" : "Archived"}
      archiveThreadLabel={locale === "zh" ? "归档会话" : "Archive session"}
      clearSearchLabel={t.clearSearch}
      deleteThreadLabel={locale === "zh" ? "删除会话" : "Delete session"}
      isLoading={connectionState === "connecting" || isSearchingThreads}
      loadingThreadsLabel={t.loadingThreads}
      locale={locale}
      newThreadLabel={t.newThread}
      platform={platform}
      newThreadShortcutLabel={newThreadShortcutLabel}
      noThreadsFoundLabel={t.noThreadsFound}
      renameThreadLabel={locale === "zh" ? "重命名会话" : "Rename session"}
      searchPlaceholder={t.searchThreads}
      searchShortcutLabel={searchShortcutLabel}
      searchValue={searchValue}
      selectedThreadId={selectedThreadId}
      settingsLabel={t.settings}
      showArchived={showArchived}
      threads={threads}
      threadsSectionLabel={t.threadsSection}
      untitledThreadLabel={t.untitledThread}
      workspaceLabel={t.workspaceLabel}
      activeThreadsLabel={locale === "zh" ? "活跃会话" : "Active"}
      onArchiveThread={onArchiveThread}
      onBackSettings={onBackSettings}
      onDeleteThread={onDeleteThread}
      onLibrary={onLibrary}
      onNewThread={onNewThread}
      onRenameThread={onRenameThread}
      onSearchChange={onSearchChange}
      onSelectThread={onSelectThread}
      onSettings={onSettings}
      onSettingsSectionChange={onSettingsSectionChange}
      onToggleArchived={onToggleArchived}
    />
  );
}
