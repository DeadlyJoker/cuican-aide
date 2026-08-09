import type { ClipboardEvent, ReactNode, RefObject } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { composerSelectSections } from "./composerSelectSections";
import { ComposerCore } from "./ComposerCore";

export type CommandComposerSelectOption<TValue extends string = string> = {
  detail?: string;
  disabled?: boolean;
  /**
   * Optional section this option belongs to. Options that share a group render
   * under one label, in the order the groups are declared on the select. An
   * option without a group sits above every labelled section.
   */
  group?: string;
  tone?: "danger" | "normal" | "warning";
  value: TValue;
  label: string;
};

export function CommandComposerSelect<TValue extends string>({
  activeValues,
  ariaLabel,
  className,
  disabled = false,
  groups,
  icon,
  options,
  triggerLabel,
  value,
  onChange,
}: {
  /**
   * Values to mark as selected when one menu drives more than one setting, for
   * example a model paired with its reasoning effort. Defaults to `value`.
   */
  activeValues?: TValue[];
  ariaLabel: string;
  className: string;
  disabled?: boolean;
  /**
   * Section order and labels. A group with no matching options is skipped, so
   * callers can declare the full set without checking what is available.
   */
  groups?: Array<{ id: string; label: string }>;
  icon?: ReactNode;
  options: CommandComposerSelectOption<TValue>[];
  /** Overrides the trigger text when it summarizes several selections. */
  triggerLabel?: string;
  value: TValue;
  onChange: (value: TValue) => void;
}) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0];
  const selectedValues = activeValues ?? [value];
  // One unlabelled section when the caller declares no groups, so the flat menu
  // and the grouped menu render through the same path.
  const sections = composerSelectSections(options, groups ?? []);

  function renderOption(option: CommandComposerSelectOption<TValue>) {
    return (
      <button
        key={option.value}
        aria-selected={selectedValues.includes(option.value)}
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
    );
  }

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
      data-selected-tone={selectedOption?.tone ?? "normal"}
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
        {triggerLabel ?? selectedOption?.label ?? value}
      </button>
      <div className="select-menu" hidden={!open} id={menuId} role="listbox">
        {sections.map((section) => (
          <div className="select-group" key={section.id} role="presentation">
            {section.label ? (
              <div className="select-group-label">{section.label}</div>
            ) : null}
            {section.options.map(renderOption)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CommandComposer({
  actions,
  beforeTextarea,
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
  onPaste,
  onStop,
  onSubmit,
}: {
  actions: ReactNode;
  beforeTextarea?: ReactNode;
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
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
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
      {beforeTextarea}
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
        onPaste={onPaste}
      />
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
