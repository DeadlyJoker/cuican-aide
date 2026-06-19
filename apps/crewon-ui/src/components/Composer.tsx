import { FormEvent, KeyboardEvent, useEffect, useRef } from "react";
import { ComposerContextBar } from "./ComposerContextBar";
import { ComposerInputRow } from "./ComposerInputRow";

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
      <ComposerContextBar
        connectionStatusLabel={connectionStatusLabel}
        connectionTone={connectionTone}
        cwd={cwd}
        noWorkspaceSelectedLabel={noWorkspaceSelectedLabel}
        retryConnectionLabel={retryConnectionLabel}
        threadSettingsLabel={threadSettingsLabel}
        onRetryConnection={onRetryConnection}
        onThreadSettings={onThreadSettings}
      />
      <ComposerInputRow
        attachContextLabel={attachContextLabel}
        composerState={composerState}
        disabled={disabled}
        hasDraft={hasDraft}
        isRunning={isRunning}
        placeholder={placeholder}
        sendLabel={sendLabel}
        sendShortcutLabel={sendShortcutLabel}
        statusText={statusText}
        stopLabel={stopLabel}
        textareaRef={textareaRef}
        value={value}
        onAttachContext={onAttachContext}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        onStop={onStop}
      />
    </form>
  );
}
