import type { ClipboardEvent, ReactNode, RefObject } from "react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";

import { cn } from "@/lib/cn";
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

export function commandComposerSelectValue<TValue extends string>(
  options: CommandComposerSelectOption<TValue>[],
  nextValue: string,
): TValue | null {
  return options.some((option) => option.value === nextValue)
    ? (nextValue as TValue)
    : null;
}

const selectTriggerClass = cn(
  "inline-flex min-h-[var(--control-h-md)] max-w-full cursor-pointer items-center gap-1.5",
  "rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-[9px] py-1.5",
  "text-[calc(12px_+_var(--user-ui-font-delta))] font-medium text-[var(--text)]",
  "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
  "hover:border-[var(--n-alpha-20)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent,#2563eb)]",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "[&_svg]:shrink-0 [&_svg]:opacity-60",
);

const selectContentClass = cn(
  "z-50 max-h-[min(320px,var(--radix-select-content-available-height))] overflow-hidden",
  "rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-raised,var(--surface))] shadow-lg",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
);

const selectItemClass = cn(
  "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 outline-none",
  "text-[calc(12px_+_var(--user-ui-font-delta))] text-[var(--text)]",
  "data-[highlighted]:bg-[var(--n-alpha-08)]",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
  "data-[tone=warning]:text-amber-500 data-[tone=danger]:text-red-500",
);

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
  /** Extra classes land on the trigger (for example a max-width utility). */
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
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0];
  const selectedValues = activeValues ?? [value];
  // One unlabelled section when the caller declares no groups, so the flat menu
  // and the grouped menu render through the same path.
  const sections = composerSelectSections(options, groups ?? []);

  return (
    <SelectPrimitive.Root
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const selectedValue = commandComposerSelectValue(options, next);
        if (selectedValue !== null) {
          onChange(selectedValue);
        }
      }}
    >
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(selectTriggerClass, className)}
        data-selected-tone={selectedOption?.tone ?? "normal"}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left">
          {triggerLabel ?? selectedOption?.label ?? value}
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronsUpDownIcon className="size-3" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      {/* No portal: this shell is also rendered to static markup in tests, and
          popper positioning already keeps the menu inside the window. */}
      <SelectPrimitive.Content
        className={selectContentClass}
        position="popper"
        side="top"
        sideOffset={6}
      >
        <SelectPrimitive.Viewport className="grid gap-0.5 p-1">
          {sections.map((section) => (
            <SelectPrimitive.Group key={section.id} className="grid gap-0.5">
              {section.label ? (
                <SelectPrimitive.Label className="px-2 pb-0.5 pt-1.5 text-[calc(11px_+_var(--user-ui-font-delta))] font-medium text-[var(--text-faint)]">
                  {section.label}
                </SelectPrimitive.Label>
              ) : null}
              {section.options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  className={selectItemClass}
                  data-tone={option.tone ?? "normal"}
                  data-value={option.value}
                  disabled={option.disabled}
                  value={option.value}
                >
                  <SelectPrimitive.ItemText>
                    <span className="grid min-w-0">
                      <strong className="truncate font-medium">{option.label}</strong>
                      {option.detail ? (
                        <em className="truncate text-[calc(11px_+_var(--user-ui-font-delta))] not-italic text-[var(--text-faint)]">
                          {option.detail}
                        </em>
                      ) : null}
                    </span>
                  </SelectPrimitive.ItemText>
                  {selectedValues.includes(option.value) ? (
                    <CheckIcon aria-hidden="true" className="ml-auto size-3.5 opacity-80" />
                  ) : null}
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Group>
          ))}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Root>
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
