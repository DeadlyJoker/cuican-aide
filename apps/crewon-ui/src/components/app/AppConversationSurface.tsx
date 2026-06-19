import type { Thread } from "@crewon-protocol/v2/Thread";

import { Composer } from "../Composer";
import { Transcript } from "../Transcript";
import type { ConnectionState } from "../../lib/shared/connectionState";
import type { Locale } from "../../lib/i18n";
import type { WorkMode } from "../../lib/workMode";

type AppConversationSurfaceProps = {
  activeTurnId: string | null;
  attachContextLabel: string;
  autoModeLabel: string;
  askPlaceholder: string;
  commandLabel: string;
  connectingLabel: string;
  connectionHint: string;
  connectionState: ConnectionState;
  cwd: string;
  crewonLabel: string;
  draftUnsavedLabel: string;
  emptyDescription: string;
  emptyThreadDescription: string;
  emptyThreadTitle: string;
  emptyTitle: string;
  filesLabel: string;
  focusSignal: number;
  isSending: boolean;
  locale: Locale;
  modeCodeDescription: string;
  modeCodeLabel: string;
  modeOfficeDescription: string;
  modeOfficeLabel: string;
  modeTitleLabel: string;
  noWorkspaceSelectedLabel: string;
  planLabel: string;
  reasoningLabel: string;
  retryConnectionLabel: string;
  sendLabel: string;
  sendShortcutLabel: string;
  sendingLabel: string;
  streamingText: string;
  thread: Thread | null;
  threadSettingsLabel: string;
  value: string;
  workMode: WorkMode;
  youLabel: string;
  onAttachContext: () => void;
  onChange: (text: string) => void;
  onModeChange: (mode: WorkMode) => void;
  onRetryConnection: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onThreadSettings: () => void;
};

export function AppConversationSurface({
  activeTurnId,
  attachContextLabel,
  autoModeLabel,
  askPlaceholder,
  commandLabel,
  connectingLabel,
  connectionHint,
  connectionState,
  cwd,
  crewonLabel,
  draftUnsavedLabel,
  emptyDescription,
  emptyThreadDescription,
  emptyThreadTitle,
  emptyTitle,
  filesLabel,
  focusSignal,
  isSending,
  locale,
  modeCodeDescription,
  modeCodeLabel,
  modeOfficeDescription,
  modeOfficeLabel,
  modeTitleLabel,
  noWorkspaceSelectedLabel,
  planLabel,
  reasoningLabel,
  retryConnectionLabel,
  sendLabel,
  sendShortcutLabel,
  sendingLabel,
  streamingText,
  thread,
  threadSettingsLabel,
  value,
  workMode,
  youLabel,
  onAttachContext,
  onChange,
  onModeChange,
  onRetryConnection,
  onSend,
  onStop,
  onThreadSettings,
}: AppConversationSurfaceProps) {
  const disabled = connectionState === "connecting" || isSending;
  const busyStatusLabel = activeTurnId
    ? locale === "zh"
      ? "正在执行"
      : "Running"
    : isSending
      ? sendingLabel
      : connectingLabel;

  return (
    <section
      className="conversation-surface"
      data-mode={workMode}
      data-state={thread ? "thread" : "start"}
    >
      <Transcript
        commandLabel={commandLabel}
        crewonLabel={crewonLabel}
        emptyDescription={emptyDescription}
        emptyThreadDescription={emptyThreadDescription}
        emptyThreadTitle={emptyThreadTitle}
        emptyTitle={emptyTitle}
        filesLabel={filesLabel}
        locale={locale}
        mode={workMode}
        modeCodeLabel={modeCodeLabel}
        modeCodeDescription={modeCodeDescription}
        modeOfficeLabel={modeOfficeLabel}
        modeOfficeDescription={modeOfficeDescription}
        modeTitleLabel={modeTitleLabel}
        onModeChange={onModeChange}
        planLabel={planLabel}
        reasoningLabel={reasoningLabel}
        thread={thread}
        streamingText={streamingText}
        youLabel={youLabel}
      />
      <Composer
        attachContextLabel={attachContextLabel}
        autoModeLabel={autoModeLabel}
        connectionStatusLabel={connectionHint}
        connectionTone={connectionState}
        disabled={disabled}
        cwd={cwd}
        draftUnsavedLabel={draftUnsavedLabel}
        focusSignal={focusSignal}
        noWorkspaceSelectedLabel={noWorkspaceSelectedLabel}
        placeholder={askPlaceholder}
        retryConnectionLabel={retryConnectionLabel}
        sendLabel={sendLabel}
        sendShortcutLabel={sendShortcutLabel}
        stopLabel={locale === "zh" ? "停止当前任务" : "Stop current turn"}
        isRunning={Boolean(activeTurnId)}
        busyStatusLabel={busyStatusLabel}
        threadSettingsLabel={threadSettingsLabel}
        value={value}
        onAttachContext={onAttachContext}
        onChange={onChange}
        onRetryConnection={onRetryConnection}
        onSend={onSend}
        onThreadSettings={onThreadSettings}
        onStop={onStop}
      />
    </section>
  );
}
