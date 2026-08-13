import type { Thread } from "@crewon-protocol/v2/Thread";

import { AppWorkspaceConversationContent } from "./AppWorkspaceConversationContent";
import { AppWorkspaceLibraryContent } from "./AppWorkspaceLibraryContent";
import { AppWorkspaceSettingsContent } from "./AppWorkspaceSettingsContent";
import type { AppView } from "../../lib/shared/appView";
import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type {
  CommandModelOption,
  ThreadRuntimeSettings,
} from "../../lib/thread/threadRuntimeSettings";
import type { LibraryItem, LibraryPanel } from "../../lib/domain/crewonDomain";
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";
import type { ConnectionState } from "../../lib/shared/connectionState";
import type { Locale } from "../../lib/i18n";
import type { PlatformKind } from "../../lib/platform";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";
import type { WorkMode } from "../../lib/workMode";

type AppWorkspaceContentProps = {
  activeTurnId: string | null;
  appView: AppView;
  capabilityPanel: CapabilityPanel | null;
  composerFocusSignal: number;
  composerValue: string;
  connectionState: ConnectionState;
  cwd: string;
  disabled: boolean;
  isSending: boolean;
  isDemo?: boolean;
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  modelOptions?: CommandModelOption[];
  platform: PlatformKind;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  slashCommands: ComposerSlashCommand[];
  settingsSection?: SettingsSection;
  streamingTextByThread: Record<string, string>;
  workMode: WorkMode;
  onAttachContext: () => void;
  onBackLibrary: () => void;
  onChangeComposerValue: (value: string) => void;
  onItemAction: (item: LibraryItem) => void;
  onLibraryPanelAction: LibraryPanelActionCallback;
  onModeChange: (mode: WorkMode) => void;
  onSaveCapability?: import("../../lib/capability/capabilityCatalog").CapabilityEditorSaveHandler;
  onPanelAction: (actionId: string) => void;
  onPanelFieldCommit?: (fieldId: string, value: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onRetryConnection: () => void;
  onSend: (text: string, threadSettings?: ThreadRuntimeSettings) => void;
  onSlashCommandSelect: (command: ComposerSlashCommand) => void;
  onStop: () => void;
  onThreadSettings: (() => void) | null;
};

export function AppWorkspaceContent({
  activeTurnId,
  appView,
  capabilityPanel,
  composerFocusSignal,
  composerValue,
  connectionState,
  cwd,
  disabled,
  isSending,
  isDemo = false,
  libraryPanel,
  locale,
  modelOptions,
  platform,
  selectedThread,
  selectedThreadId,
  slashCommands,
  settingsSection = "account",
  streamingTextByThread,
  workMode,
  onAttachContext,
  onBackLibrary,
  onChangeComposerValue,
  onItemAction,
  onLibraryPanelAction,
  onModeChange,
  onSaveCapability,
  onPanelAction,
  onPanelFieldCommit = () => {},
  onPanelFieldChange,
  onRetryConnection,
  onSend,
  onSlashCommandSelect,
  onStop,
  onThreadSettings,
}: AppWorkspaceContentProps) {
  if (appView === "settings") {
    return (
      <AppWorkspaceSettingsContent
        activeSection={settingsSection}
        capabilityPanel={capabilityPanel}
        dataMode={
          isDemo
            ? "demo"
            : connectionState === "connected"
              ? "live"
              : "disconnected"
        }
        disabled={disabled || isDemo}
        locale={locale}
        onPanelAction={onPanelAction}
        onPanelFieldCommit={onPanelFieldCommit}
        onPanelFieldChange={onPanelFieldChange}
      />
    );
  }

  if (appView === "library" && libraryPanel) {
    return (
      <AppWorkspaceLibraryContent
        libraryPanel={libraryPanel}
        locale={locale}
        onBackLibrary={onBackLibrary}
        onItemAction={onItemAction}
        onLibraryPanelAction={onLibraryPanelAction}
        onPanelFieldChange={onPanelFieldChange}
      />
    );
  }

  return (
    <AppWorkspaceConversationContent
      activeTurnId={activeTurnId}
      composerFocusSignal={composerFocusSignal}
      composerValue={composerValue}
      connectionState={connectionState}
      cwd={cwd}
      isSending={isSending}
      locale={locale}
      modelOptions={modelOptions}
      platform={platform}
      selectedThread={selectedThread}
      selectedThreadId={selectedThreadId}
      slashCommands={slashCommands}
      streamingTextByThread={streamingTextByThread}
      workMode={workMode}
      onAttachContext={onAttachContext}
      onChangeComposerValue={onChangeComposerValue}
      onModeChange={onModeChange}
      onSaveCapability={onSaveCapability}
      onRetryConnection={onRetryConnection}
      onSend={onSend}
      onSlashCommandSelect={onSlashCommandSelect}
      onStop={onStop}
      onThreadSettings={onThreadSettings}
    />
  );
}
