import {
  ArrowUp,
  Circle,
  FolderOpen,
  Paperclip,
  RefreshCw,
  Settings2,
  Square,
} from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useRef } from "react";

type ComposerProps = {
  attachContextLabel: string;
  autoModeLabel: string;
  connectionStatusLabel: string;
  connectionTone: "connected" | "connecting" | "demo";
  disabled: boolean;
  cwd: string;
  draftUnsavedLabel: string;
  focusSignal: number;
  noWorkspaceSelectedLabel: string;
  placeholder: string;
  retryConnectionLabel: string;
  sendLabel: string;
  sendShortcutLabel: string;
  stopLabel: string;
  isRunning: boolean;
  busyStatusLabel: string;
  threadSettingsLabel: string;
  value: string;
  onAttachContext: () => void;
  onChange: (text: string) => void;
  onRetryConnection: () => void;
  onSend: (text: string) => void;
  onThreadSettings: () => void;
  onStop: () => void;
};

export function Composer({
  attachContextLabel,
  autoModeLabel,
  connectionStatusLabel,
  connectionTone,
  disabled,
  cwd,
  draftUnsavedLabel,
  focusSignal,
  noWorkspaceSelectedLabel,
  placeholder,
  retryConnectionLabel,
  sendLabel,
  sendShortcutLabel,
  stopLabel,
  isRunning,
  busyStatusLabel,
  threadSettingsLabel,
  value,
  onAttachContext,
  onChange,
  onRetryConnection,
  onSend,
  onThreadSettings,
  onStop,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasDraft = Boolean(value.trim());
  const composerState = isRunning ? "running" : disabled ? "busy" : hasDraft ? "draft" : "idle";
  const statusText = isRunning ? busyStatusLabel : hasDraft ? draftUnsavedLabel : disabled ? busyStatusLabel : autoModeLabel;

  useEffect(() => {
    if (disabled) {
      return;
    }

    textareaRef.current?.focus();
  }, [disabled, focusSignal]);

  useEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    if (!value) {
      textarea.style.height = "34px";
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 168)}px`;
  }, [value]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendValue();
  }

  function sendValue() {
    const trimmedValue = value.trim();

    if (isRunning && !trimmedValue) {
      onStop();
      return;
    }

    if (disabled || !trimmedValue) {
      return;
    }

    onChange("");
    onSend(trimmedValue);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      sendValue();
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-context">
        <span className="composer-workspace-chip" title={cwd || noWorkspaceSelectedLabel}>
          <FolderOpen size={14} />
          {cwd || noWorkspaceSelectedLabel}
        </span>
        <div className="composer-context-actions">
          <span className="composer-status-pill" data-tone={connectionTone} title={connectionStatusLabel}>
            <Circle size={8} fill="currentColor" />
            {connectionStatusLabel}
          </span>
          {connectionTone === "demo" ? (
            <button className="composer-retry-button" type="button" title={retryConnectionLabel} onClick={onRetryConnection}>
              <RefreshCw size={13} />
              {retryConnectionLabel}
            </button>
          ) : null}
          <button className="icon-button" type="button" aria-label={threadSettingsLabel} title={threadSettingsLabel} onClick={onThreadSettings}>
            <Settings2 size={16} />
          </button>
        </div>
      </div>
      <div className="composer-input-row" data-state={composerState}>
        <button className="icon-button" type="button" aria-label={attachContextLabel} title={attachContextLabel} disabled={disabled} onClick={onAttachContext}>
          <Paperclip size={17} />
        </button>
        <textarea
          ref={textareaRef}
          value={value}
          rows={2}
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={handleKeyDown}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="send-button"
          type={isRunning && !value.trim() ? "button" : "submit"}
          aria-label={isRunning && !value.trim() ? stopLabel : sendLabel}
          title={isRunning && !value.trim() ? stopLabel : `${sendLabel} (${sendShortcutLabel})`}
          disabled={!isRunning && (disabled || !value.trim())}
          onClick={isRunning && !value.trim() ? onStop : undefined}
        >
          {isRunning && !value.trim() ? <Square size={13} fill="currentColor" /> : <ArrowUp size={18} />}
        </button>
        <div className="composer-tool-row">
          <span className={hasDraft ? "composer-draft-status" : disabled ? "composer-busy-status" : undefined}>
            <span className="composer-state-dot" data-state={composerState} aria-hidden="true" />
            <span className="composer-state-text">{statusText}</span>
          </span>
          <kbd className="composer-shortcut" title={`${sendLabel} (${sendShortcutLabel})`}>
            {sendShortcutLabel}
          </kbd>
        </div>
      </div>
    </form>
  );
}
