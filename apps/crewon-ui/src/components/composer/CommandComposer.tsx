import type { ReactNode, RefObject } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { ComposerCore } from "./ComposerCore";

export type CommandComposerSelectOption<TValue extends string = string> = {
  detail?: string;
  disabled?: boolean;
  tone?: "danger" | "normal" | "warning";
  value: TValue;
  label: string;
};

export function CommandComposerSelect<TValue extends string>({
  ariaLabel,
  className,
  disabled = false,
  icon,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  className: string;
  disabled?: boolean;
  icon?: ReactNode;
  options: CommandComposerSelectOption<TValue>[];
  value: TValue;
  onChange: (value: TValue) => void;
}) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) {
      return;
    }
    function closeOnPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`control-select ${className}`}
      data-open={open ? "true" : "false"}
    >
      <span className="visually-hidden">{ariaLabel}</span>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="select-trigger"
        disabled={disabled}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        {selectedOption?.label ?? value}
      </button>
      <div className="select-menu" hidden={!open} id={menuId} role="listbox">
        {options.map((option) => (
          <button
            key={option.value}
            aria-selected={option.value === value}
            className="select-option"
            data-tone={option.tone ?? "normal"}
            data-value={option.value}
            disabled={option.disabled}
            role="option"
            type="button"
            onClick={() => {
              if (option.disabled) {
                return;
              }
              onChange(option.value);
              setOpen(false);
            }}
          >
            <span>
              <strong>{option.label}</strong>
              {option.detail ? <em>{option.detail}</em> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function CommandComposer({
  actions,
  afterTextarea,
  ariaDescribedBy,
  ariaInvalid,
  ariaLabel,
  className,
  controls,
  dataOdId,
  disabled,
  id,
  maxHeight,
  palettes,
  paletteOpen,
  placeholder,
  readOnly,
  running,
  sendLabel,
  slashEnabled,
  state,
  stateDataOdId,
  stateId,
  stopLabel,
  submitBehavior,
  submitBlocked,
  submitting,
  textareaDataOdId,
  textareaRef,
  value,
  onChange,
  onClosePalette,
  onOpenPalette,
  onStop,
  onSubmit,
}: {
  actions: ReactNode;
  afterTextarea?: ReactNode;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  ariaLabel: string;
  className: string;
  controls: ReactNode;
  dataOdId?: string;
  disabled: boolean;
  id: string;
  maxHeight?: number;
  palettes?: ReactNode;
  paletteOpen?: boolean;
  placeholder: string;
  readOnly?: boolean;
  running?: boolean;
  sendLabel: string;
  slashEnabled?: boolean;
  state: ReactNode;
  stateDataOdId?: string;
  stateId?: string;
  stopLabel?: string;
  submitBehavior: "enter" | "modifierEnter";
  submitBlocked?: boolean;
  submitting?: boolean;
  textareaDataOdId?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  onClosePalette?: () => void;
  onOpenPalette?: (intent: "context" | "slash") => void;
  onStop?: () => void;
  onSubmit: (value: string) => void | Promise<void>;
}) {
  return (
    <ComposerCore.Form
      className={className}
      dataCommandComposer
      dataOdId={dataOdId}
      disabled={disabled}
      paletteOpen={paletteOpen}
      running={running}
      slashEnabled={slashEnabled}
      stopLabel={stopLabel}
      submitBehavior={submitBehavior}
      submitting={submitting}
      submitBlocked={submitBlocked}
      value={value}
      onChange={onChange}
      onClosePalette={onClosePalette}
      onOpenPalette={onOpenPalette}
      onStop={onStop}
      onSubmit={onSubmit}
    >
      <ComposerCore.Textarea
        ariaDescribedBy={ariaDescribedBy}
        ariaInvalid={ariaInvalid}
        ariaLabel={ariaLabel}
        dataOdId={textareaDataOdId}
        id={id}
        maxHeight={maxHeight}
        placeholder={placeholder}
        readOnly={readOnly}
        textareaRef={textareaRef}
      />
      {afterTextarea}
      <div className="input-tools" data-od-id="composer-tools">
        <div className="composer-controls" data-od-id="composer-control-row">
          {controls}
        </div>
        <div className="composer-actions" data-od-id="composer-action-row">
          {actions}
          <ComposerCore.SendButton sendLabel={sendLabel} />
        </div>
      </div>
      {palettes}
      <div
        className="composer-state-row"
        data-od-id={stateDataOdId}
        id={stateId}
      >
        {state}
      </div>
    </ComposerCore.Form>
  );
}
