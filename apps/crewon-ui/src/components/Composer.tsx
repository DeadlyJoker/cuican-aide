import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComposerSlashCommand } from "../lib/composer/composerSlashCommands";
import { ComposerContextBar } from "./ComposerContextBar";
import { ComposerInputRow } from "./ComposerInputRow";

type ComposerProps = {
  attachContextLabel: string;
  autoModeLabel: string;
  connectionStatusLabel: string;
  connectionTone: "connected" | "connecting" | "disconnected" | "demo";
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
  slashCommands?: ComposerSlashCommand[];
  isRunning: boolean;
  busyStatusLabel: string;
  threadSettingsLabel: string;
  value: string;
  onAttachContext: () => void;
  onChange: (text: string) => void;
  onRetryConnection: () => void;
  onSend: (text: string) => void;
  onSlashCommandSelect?: (command: ComposerSlashCommand) => void;
  onThreadSettings: () => void;
  onStop: () => void;
};

function trailingSlashQuery(value: string): string | null {
  const match = value.match(/(^|\s)\/([^\s/]*)$/);
  return match ? match[2] : null;
}

function replaceTrailingSlash(value: string, token: string): string {
  return value.replace(/(^|\s)\/([^\s/]*)$/, (_match, prefix: string) =>
    `${prefix}${token} `,
  );
}

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
  slashCommands = [],
  isRunning,
  busyStatusLabel,
  threadSettingsLabel,
  value,
  onAttachContext,
  onChange,
  onRetryConnection,
  onSend,
  onSlashCommandSelect,
  onThreadSettings,
  onStop,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const hasDraft = Boolean(value.trim());
  const composerState = isRunning ? "running" : disabled ? "busy" : hasDraft ? "draft" : "idle";
  const statusText = isRunning ? busyStatusLabel : hasDraft ? draftUnsavedLabel : disabled ? busyStatusLabel : autoModeLabel;
  const slashQuery = disabled ? null : trailingSlashQuery(value);
  const slashOptions = useMemo(() => {
    if (slashQuery === null) {
      return [];
    }

    const normalizedQuery = slashQuery.trim().toLowerCase();
    const filteredCommands = normalizedQuery
      ? slashCommands.filter((command) =>
          [
            command.label,
            command.meta,
            command.description,
            command.token,
            command.mention?.path ?? "",
          ]
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery),
        )
      : slashCommands;

    return filteredCommands.slice(0, 8);
  }, [slashCommands, slashQuery]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashQuery, slashOptions.length]);

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

    if (isRunning) {
      onStop();
      return;
    }

    if (disabled || !trimmedValue) {
      return;
    }

    onChange("");
    onSend(trimmedValue);
  }

  function selectSlashCommand(command: ComposerSlashCommand) {
    onChange(replaceTrailingSlash(value, command.token));
    onSlashCommandSelect?.(command);
    setActiveSlashIndex(0);
    textareaRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOptions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSlashIndex((index) => (index + 1) % slashOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSlashIndex(
          (index) => (index - 1 + slashOptions.length) % slashOptions.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectSlashCommand(slashOptions[activeSlashIndex] ?? slashOptions[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setActiveSlashIndex(0);
        onChange(value.replace(/\/([^\s/]*)$/, ""));
        return;
      }
    }

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
        slashActiveIndex={activeSlashIndex}
        slashOptions={slashOptions}
        statusText={statusText}
        stopLabel={stopLabel}
        textareaRef={textareaRef}
        value={value}
        onAttachContext={onAttachContext}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        onSlashCommandSelect={selectSlashCommand}
        onStop={onStop}
      />
    </form>
  );
}
