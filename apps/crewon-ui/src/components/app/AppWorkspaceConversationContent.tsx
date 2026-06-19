import type { Thread } from "@crewon-protocol/v2/Thread";

import { AppConversationSurface } from "./AppConversationSurface";
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
  platform,
  selectedThread,
  selectedThreadId,
  streamingTextByThread,
  workMode,
  onAttachContext,
  onChangeComposerValue,
  onModeChange,
  onRetryConnection,
  onSend,
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
  platform: PlatformKind;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  streamingTextByThread: Record<string, string>;
  workMode: WorkMode;
  onAttachContext: () => void;
  onChangeComposerValue: (value: string) => void;
  onModeChange: (mode: WorkMode) => void;
  onRetryConnection: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onThreadSettings: () => void;
}) {
  const t = translate(locale);
  const sendShortcutLabel = platform === "mac" ? "⌘ Enter" : "Ctrl Enter";

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
      streamingText={
        selectedThreadId ? (streamingTextByThread[selectedThreadId] ?? "") : ""
      }
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
      onStop={onStop}
      onThreadSettings={onThreadSettings}
    />
  );
}
