import type { Thread } from "@crewon-ui-model/v2/Thread";

import { AppConversationSurface } from "./AppConversationSurface";
import { CommandWorkspace } from "./CommandWorkspace";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type {
  CommandModelOption,
  ThreadRuntimeSettings,
} from "../../lib/thread/threadRuntimeSettings";
import type { ConnectionState } from "../../lib/shared/connectionState";
import { translate, type Locale } from "../../lib/i18n";
import type { PlatformKind } from "../../lib/platform";
import type { WorkMode } from "../../lib/workMode";

export function AppWorkspaceConversationContent({
  activeTurnId,
  composerFocusSignal,
  composerValue,
  connectionState,
  cwd,
  isSending,
  locale,
  modelOptions,
  platform,
  selectedThread,
  selectedThreadId,
  slashCommands,
  streamingTextByThread,
  workMode,
  onAttachContext,
  onChangeComposerValue,
  onModeChange,
  onSaveCapability,
  onRetryConnection,
  onSend,
  onSlashCommandSelect,
  onStop,
  onThreadSettings,
}: {
  activeTurnId: string | null;
  composerFocusSignal: number;
  composerValue: string;
  connectionState: ConnectionState;
  cwd: string;
  isSending: boolean;
  locale: Locale;
  modelOptions?: CommandModelOption[];
  platform: PlatformKind;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  slashCommands: ComposerSlashCommand[];
  streamingTextByThread: Record<string, string>;
  workMode: WorkMode;
  onAttachContext: () => void;
  onChangeComposerValue: (value: string) => void;
  onModeChange: (mode: WorkMode) => void;
  onSaveCapability?: import("../../lib/capability/capabilityCatalog").CapabilityEditorSaveHandler;
  onRetryConnection: () => void;
  onSend: (text: string, threadSettings?: ThreadRuntimeSettings) => void;
  onSlashCommandSelect: (command: ComposerSlashCommand) => void;
  onStop: () => void;
  onThreadSettings: (() => void) | null;
}) {
  const t = translate(locale);
  const sendShortcutLabel = platform === "mac" ? "⌘ Enter" : "Ctrl Enter";

  const streamingText = selectedThreadId
    ? (streamingTextByThread[selectedThreadId] ?? "")
    : "";
  const hasConversation =
    Boolean(selectedThread) &&
    ((selectedThread?.turns.length ?? 0) > 0 || streamingText.length > 0);

  if (!hasConversation) {
    return (
      <CommandWorkspace
        composerValue={composerValue}
        connectionState={connectionState}
        isSending={isSending}
        locale={locale}
        modelOptions={modelOptions}
        slashCommands={slashCommands}
        workMode={workMode}
        onChangeComposerValue={onChangeComposerValue}
        onModeChange={onModeChange}
        onSaveCapability={onSaveCapability}
        onRetryConnection={onRetryConnection}
        onSend={onSend}
        onSendNewThread={onSend}
        onSlashCommandSelect={onSlashCommandSelect}
      />
    );
  }

  return (
    <AppConversationSurface
      activeTurnId={activeTurnId}
      attachContextLabel={t.attachContext}
      autoModeLabel={t.autoMode}
      askPlaceholder={t.askPlaceholder}
      commandLabel={t.command}
      connectingLabel={t.connecting}
      connectionHint={t.connectionHints[connectionState]}
      connectionState={connectionState}
      cwd={cwd}
      crewonLabel={t.crewon}
      draftUnsavedLabel={t.draftUnsaved}
      emptyDescription={t.emptyDescription}
      emptyThreadDescription={t.emptyThreadDescription}
      emptyThreadTitle={t.emptyThreadTitle}
      emptyTitle={t.emptyTitle}
      filesLabel={t.files}
      focusSignal={composerFocusSignal}
      isSending={isSending}
      locale={locale}
      modeCodeDescription={t.modeCodeDescription}
      modeCodeLabel={t.modeCode}
      modeOfficeDescription={t.modeOfficeDescription}
      modeOfficeLabel={t.modeOffice}
      modeTitleLabel={t.modeTitle}
      noWorkspaceSelectedLabel={t.noWorkspaceSelected}
      planLabel={t.plan}
      reasoningLabel={t.reasoning}
      retryConnectionLabel={t.retryConnection}
      sendLabel={t.send}
      sendShortcutLabel={sendShortcutLabel}
      sendingLabel={t.sending}
      slashCommands={slashCommands}
      streamingText={streamingText}
      thread={selectedThread}
      threadSettingsLabel={t.threadSettings}
      value={composerValue}
      workMode={workMode}
      youLabel={t.you}
      onAttachContext={onAttachContext}
      onChange={onChangeComposerValue}
      onModeChange={onModeChange}
      onRetryConnection={onRetryConnection}
      onSend={onSend}
      onSlashCommandSelect={onSlashCommandSelect}
      onStop={onStop}
      onThreadSettings={onThreadSettings}
    />
  );
}
