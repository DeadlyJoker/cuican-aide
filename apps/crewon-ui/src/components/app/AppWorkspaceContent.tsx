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
import type {
  AgentConfig,
  ArtifactItem,
  LibraryItem,
  LibraryPanel,
  OfficeMember,
  OfficeMemberContextPreview,
  OfficeMemoryListResult,
  OfficeMemoryRecord,
  OfficeMemoryStatus,
  OfficeRunActivity,
  OfficeRunDelegationActivity,
  OfficeRunVerificationCheckActivity,
} from "../../lib/domain/crewonDomain";
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";
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
  modelOptions?: CommandModelOption[];
  platform: PlatformKind;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  slashCommands: ComposerSlashCommand[];
  streamingTextByThread: Record<string, string>;
  workMode: WorkMode;
  onApprovalDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
  onAttachContext: () => void;
  onBackLibrary: () => void;
  onChangeComposerValue: (value: string) => void;
  onItemAction: (item: LibraryItem) => void;
  onLibraryPanelAction: LibraryPanelActionCallback;
  onModeChange: (mode: WorkMode) => void;
  onOfficeDelegationDispatch: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void | Promise<void>;
  onOfficeDelegationCancel: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void | Promise<void>;
  onOfficeDelegationRetry: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void | Promise<void>;
  onOfficeDelegationDispatchNext?: (
    run: OfficeRunActivity,
  ) => void | Promise<void>;
  onOfficeVerificationCancel: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => void | Promise<void>;
  onOfficeVerificationRetry: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => void | Promise<void>;
  onOfficeMemoryDecision?: (
    memoryId: string,
    status: OfficeMemoryStatus,
  ) => Promise<OfficeMemoryRecord | null>;
  onOfficeMemoryList?: (
    status: OfficeMemoryStatus,
    cursor?: string | null,
  ) => Promise<OfficeMemoryListResult | null>;
  onOfficeMemberContextPreview?: (
    run: OfficeRunActivity,
    member: OfficeMember,
  ) => Promise<OfficeMemberContextPreview | null>;
  onRecruitableAgentList?: (
    existingMembers: OfficeMember[],
  ) => Promise<AgentConfig[]>;
  onOfficeRunCancel: (run: OfficeRunActivity) => void | Promise<void>;
  onOfficeRunRetry: (run: OfficeRunActivity) => void | Promise<void>;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onRetryConnection: () => void;
  onSaveAgentConfig: () => void;
  onSend: (text: string, threadSettings?: ThreadRuntimeSettings) => void;
  onSlashCommandSelect: (command: ComposerSlashCommand) => void;
  onSendOfficeMessage: (text: string) => void | Promise<void>;
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
  modelOptions,
  platform,
  selectedThread,
  selectedThreadId,
  slashCommands,
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
  onOfficeDelegationDispatch,
  onOfficeDelegationCancel,
  onOfficeDelegationRetry,
  onOfficeDelegationDispatchNext,
  onOfficeVerificationCancel,
  onOfficeVerificationRetry,
  onOfficeMemoryDecision,
  onOfficeMemoryList,
  onOfficeMemberContextPreview,
  onRecruitableAgentList,
  onOfficeRunCancel,
  onOfficeRunRetry,
  onPanelAction,
  onPanelFieldChange,
  onRetryConnection,
  onSaveAgentConfig,
  onSend,
  onSlashCommandSelect,
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
        onOfficeDelegationCancel={onOfficeDelegationCancel}
        onOfficeDelegationDispatch={onOfficeDelegationDispatch}
        onOfficeDelegationRetry={onOfficeDelegationRetry}
        onOfficeDelegationDispatchNext={onOfficeDelegationDispatchNext}
        onOfficeVerificationCancel={onOfficeVerificationCancel}
        onOfficeVerificationRetry={onOfficeVerificationRetry}
        onOfficeMemoryDecision={onOfficeMemoryDecision}
        onOfficeMemoryList={onOfficeMemoryList}
        onOfficeMemberContextPreview={onOfficeMemberContextPreview}
        onRecruitableAgentList={onRecruitableAgentList}
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
      onRetryConnection={onRetryConnection}
      onSend={onSend}
      onSlashCommandSelect={onSlashCommandSelect}
      onStop={onStop}
      onThreadSettings={onThreadSettings}
    />
  );
}
