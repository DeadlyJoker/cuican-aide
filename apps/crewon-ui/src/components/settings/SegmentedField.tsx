import { useRef } from "react";

import { segmentedKeyTarget } from "./segmentedKeyboard";

type SegmentedOption = { label: string; value: string };

type SegmentedFieldProps = {
  disabled: boolean;
  label: string;
  options: readonly SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
};

/**
 * A single-choice segmented control with native radio-group behavior: arrow
 * keys move between segments and the group occupies one tab stop, so a panel of
 * these does not flood the tab order with one stop per segment.
 */
export function SegmentedField({
  disabled,
  label,
  options,
  value,
  onChange,
}: SegmentedFieldProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = segmentedKeyTarget({
      count: options.length,
      key: event.key,
      selectedIndex,
    });
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    onChange(options[target].value);
    // Focus follows selection so the next arrow press continues from here.
    groupRef.current
      ?.querySelectorAll<HTMLButtonElement>("button")
      [target]?.focus();
  };

  return (
    <div
      aria-label={label}
      className="settings-segmented"
      ref={groupRef}
      role="radiogroup"
      onKeyDown={handleKeyDown}
    >
      {options.map((option, index) => (
        <button
          aria-checked={option.value === value}
          data-active={option.value === value}
          disabled={disabled}
          key={option.value}
          role="radio"
          // Roving tabindex: only the selected segment is a tab stop.
          tabIndex={index === selectedIndex ? 0 : -1}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
