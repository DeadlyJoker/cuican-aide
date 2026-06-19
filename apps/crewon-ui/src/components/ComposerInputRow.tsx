import { ArrowUp, Paperclip, Square } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";

export function ComposerInputRow({
  attachContextLabel,
  composerState,
  disabled,
  hasDraft,
  isRunning,
  placeholder,
  sendLabel,
  sendShortcutLabel,
  statusText,
  stopLabel,
  textareaRef,
  value,
  onAttachContext,
  onChange,
  onKeyDown,
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
  statusText: string;
  stopLabel: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onAttachContext: () => void;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onStop: () => void;
}) {
  const trimmedValue = value.trim();
  const shouldShowStop = isRunning && !trimmedValue;

  return (
    <div className="composer-input-row" data-state={composerState}>
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
        aria-label={shouldShowStop ? stopLabel : sendLabel}
        title={shouldShowStop ? stopLabel : `${sendLabel} (${sendShortcutLabel})`}
        disabled={!isRunning && (disabled || !trimmedValue)}
        onClick={shouldShowStop ? onStop : undefined}
      >
        {shouldShowStop ? (
          <Square size={13} fill="currentColor" />
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
