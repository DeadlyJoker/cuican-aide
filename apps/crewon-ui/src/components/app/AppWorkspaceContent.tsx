import type { Thread } from "@crewon-protocol/v2/Thread";

import { AppWorkspaceConversationContent } from "./AppWorkspaceConversationContent";
import { AppWorkspaceLibraryContent } from "./AppWorkspaceLibraryContent";
import { AppWorkspaceSettingsContent } from "./AppWorkspaceSettingsContent";
import type { AppView } from "../../lib/shared/appView";
import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import type {
  AgentConfig,
  ArtifactItem,
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
  OfficeRunActivity,
} from "../../lib/domain/crewonDomain";
import type { ConnectionState } from "../../lib/shared/connectionState";
import type { Locale } from "../../lib/i18n";
import type { PlatformKind } from "../../lib/platform";
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
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  platform: PlatformKind;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  streamingTextByThread: Record<string, string>;
  workMode: WorkMode;
  onApprovalDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
  onAttachContext: () => void;
  onBackLibrary: () => void;
  onChangeComposerValue: (value: string) => void;
  onItemAction: (item: LibraryItem) => void;
  onLibraryPanelAction: (action: LibraryPanelAction) => void;
  onModeChange: (mode: WorkMode) => void;
  onOfficeRunCancel: (run: OfficeRunActivity) => void;
  onOfficeRunRetry: (run: OfficeRunActivity) => void;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onRetryConnection: () => void;
  onSaveAgentConfig: () => void;
  onSend: (text: string) => void;
  onSendOfficeMessage: (text: string) => void;
  onStop: () => void;
  onThreadSettings: () => void;
  onToggleAgentCapability: (group: "mcp" | "skills", id: string) => void;
  onUpdateAgentConfig: (patch: Partial<AgentConfig>) => void;
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
  libraryPanel,
  locale,
  platform,
  selectedThread,
  selectedThreadId,
  streamingTextByThread,
  workMode,
  onApprovalDecision,
  onArtifact,
  onAttachContext,
  onBackLibrary,
  onChangeComposerValue,
  onItemAction,
  onLibraryPanelAction,
  onModeChange,
  onOfficeRunCancel,
  onOfficeRunRetry,
  onPanelAction,
  onPanelFieldChange,
  onRetryConnection,
  onSaveAgentConfig,
  onSend,
  onSendOfficeMessage,
  onStop,
  onThreadSettings,
  onToggleAgentCapability,
  onUpdateAgentConfig,
}: AppWorkspaceContentProps) {
  if (appView === "settings") {
    return (
      <AppWorkspaceSettingsContent
        capabilityPanel={capabilityPanel}
        disabled={disabled}
        locale={locale}
        onPanelAction={onPanelAction}
        onPanelFieldChange={onPanelFieldChange}
      />
    );
  }

  if (appView === "library" && libraryPanel) {
    return (
      <AppWorkspaceLibraryContent
        libraryPanel={libraryPanel}
        locale={locale}
        onApprovalDecision={onApprovalDecision}
        onArtifact={onArtifact}
        onBackLibrary={onBackLibrary}
        onItemAction={onItemAction}
        onLibraryPanelAction={onLibraryPanelAction}
        onOfficeRunCancel={onOfficeRunCancel}
        onOfficeRunRetry={onOfficeRunRetry}
        onPanelFieldChange={onPanelFieldChange}
        onSaveAgentConfig={onSaveAgentConfig}
        onSendOfficeMessage={onSendOfficeMessage}
        onToggleAgentCapability={onToggleAgentCapability}
        onUpdateAgentConfig={onUpdateAgentConfig}
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
      platform={platform}
      selectedThread={selectedThread}
      selectedThreadId={selectedThreadId}
      streamingTextByThread={streamingTextByThread}
      workMode={workMode}
      onAttachContext={onAttachContext}
      onChangeComposerValue={onChangeComposerValue}
      onModeChange={onModeChange}
      onRetryConnection={onRetryConnection}
      onSend={onSend}
      onStop={onStop}
      onThreadSettings={onThreadSettings}
    />
  );
}
