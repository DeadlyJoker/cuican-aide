import type { Thread } from "@crewon-protocol/v2/Thread";
import { MessageSquare, UsersRound } from "lucide-react";

import { Composer } from "../Composer";
import { Transcript } from "../Transcript";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
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
  slashCommands: ComposerSlashCommand[];
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
  onSlashCommandSelect: (command: ComposerSlashCommand) => void;
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
  slashCommands,
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
  onSlashCommandSelect,
  onStop,
  onThreadSettings,
}: AppConversationSurfaceProps) {
  const isThreadRunning =
    Boolean(activeTurnId) ||
    Boolean(thread?.turns.some((turn) => turn.status === "inProgress"));
  const disabled =
    connectionState === "connecting" ||
    connectionState === "disconnected" ||
    isSending;
  const busyStatusLabel = isThreadRunning
    ? locale === "zh"
      ? "正在执行"
      : "Running"
    : isSending
      ? sendingLabel
      : connectingLabel;
  const surfaceTitle = thread?.name || thread?.preview || emptyTitle;
  const surfaceMeta = thread?.cwd || noWorkspaceSelectedLabel;
  const stopLabel = locale === "zh" ? "停止" : "Stop";

  return (
    <section
      className="conversation-surface"
      data-mode={workMode}
      data-state={thread ? "thread" : "start"}
    >
      <div className="conversation-mode-bar">
        <div className="conversation-mode-title">
          <span>{workMode === "office" ? modeOfficeLabel : modeCodeLabel}</span>
          <strong>{surfaceTitle}</strong>
          <em>{surfaceMeta}</em>
        </div>
        <div className="mode-switch" aria-label={modeTitleLabel}>
          <button
            type="button"
            aria-pressed={workMode === "code"}
            data-active={workMode === "code"}
            onClick={() => onModeChange("code")}
          >
            <MessageSquare size={15} />
            {modeCodeLabel}
          </button>
          <button
            type="button"
            aria-pressed={workMode === "office"}
            data-active={workMode === "office"}
            onClick={() => onModeChange("office")}
          >
            <UsersRound size={15} />
            {modeOfficeLabel}
          </button>
        </div>
      </div>
      <Transcript
        activeTurnId={activeTurnId}
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
        onStop={onStop}
        planLabel={planLabel}
        reasoningLabel={reasoningLabel}
        stopLabel={stopLabel}
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
        stopLabel={stopLabel}
        slashCommands={slashCommands}
        isRunning={isThreadRunning}
        busyStatusLabel={busyStatusLabel}
        threadSettingsLabel={threadSettingsLabel}
        value={value}
        onAttachContext={onAttachContext}
        onChange={onChange}
        onRetryConnection={onRetryConnection}
        onSend={onSend}
        onSlashCommandSelect={onSlashCommandSelect}
        onThreadSettings={onThreadSettings}
        onStop={onStop}
      />
    </section>
  );
}
