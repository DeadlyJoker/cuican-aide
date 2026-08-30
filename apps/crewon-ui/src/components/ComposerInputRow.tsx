import { ArrowUp, Paperclip, Square } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import type { ComposerSlashCommand } from "../lib/composer/composerSlashCommands";

export function ComposerInputRow({
  attachContextLabel,
  composerState,
  disabled,
  hasDraft,
  isRunning,
  placeholder,
  sendLabel,
  sendShortcutLabel,
  slashActiveIndex,
  slashOptions,
  statusText,
  stopLabel,
  textareaRef,
  value,
  onAttachContext,
  onChange,
  onKeyDown,
  onSlashCommandSelect,
  onStop,
}: {
  attachContextLabel: string;
  composerState: "busy" | "draft" | "idle" | "running";
  disabled: boolean;
  hasDraft: boolean;
  isRunning: boolean;
  placeholder: string;
  sendLabel: string;
  sendShortcutLabel: string;
  slashActiveIndex: number;
  slashOptions: ComposerSlashCommand[];
  statusText: string;
  stopLabel: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onAttachContext: () => void;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSlashCommandSelect: (command: ComposerSlashCommand) => void;
  onStop: () => void;
}) {
  const trimmedValue = value.trim();
  const shouldShowStop = isRunning;
  const showSlashMenu = slashOptions.length > 0;

  return (
    <div className="composer-input-row" data-state={composerState}>
      {showSlashMenu ? (
        <div
          className="composer-slash-menu"
          role="listbox"
          aria-label="Tools"
        >
          {slashOptions.map((command, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === slashActiveIndex}
              data-active={index === slashActiveIndex}
              key={command.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSlashCommandSelect(command)}
            >
              <span className="composer-slash-kind" data-kind={command.kind}>
                {command.kind}
              </span>
              <span className="composer-slash-text">
                <strong>{command.label}</strong>
                <em>{command.description}</em>
              </span>
              <code>{command.token}</code>
            </button>
          ))}
        </div>
      ) : null}
      <button
        className="icon-button"
        type="button"
        aria-label={attachContextLabel}
        title={attachContextLabel}
        disabled={disabled}
        onClick={onAttachContext}
      >
        <Paperclip size={17} />
      </button>
      <textarea
        ref={textareaRef}
        value={value}
        rows={2}
        placeholder={placeholder}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        className="send-button"
        type={shouldShowStop ? "button" : "submit"}
        data-action={shouldShowStop ? "stop" : undefined}
        aria-label={shouldShowStop ? stopLabel : sendLabel}
        title={shouldShowStop ? stopLabel : `${sendLabel} (${sendShortcutLabel})`}
        disabled={!isRunning && (disabled || !trimmedValue)}
        onClick={shouldShowStop ? onStop : undefined}
      >
        {shouldShowStop ? (
          <>
            <Square size={10} fill="currentColor" />
            <span>{stopLabel}</span>
          </>
        ) : (
          <ArrowUp size={18} />
        )}
      </button>
      <div className="composer-tool-row">
        <span
          className={
            hasDraft
              ? "composer-draft-status"
              : disabled
                ? "composer-busy-status"
                : undefined
          }
        >
          <span
            className="composer-state-dot"
            data-state={composerState}
            aria-hidden="true"
          />
          <span className="composer-state-text">{statusText}</span>
        </span>
        <kbd
          className="composer-shortcut"
          title={`${sendLabel} (${sendShortcutLabel})`}
        >
          {sendShortcutLabel}
        </kbd>
      </div>
    </div>
  );
}
