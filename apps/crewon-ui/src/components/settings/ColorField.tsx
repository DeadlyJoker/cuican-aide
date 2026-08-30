import { useEffect, useState } from "react";

type ColorFieldProps = {
  disabled: boolean;
  label: string;
  value: string;
  onCommit: (value: string) => void;
};

/**
 * A color swatch that previews live and persists when the picker settles.
 *
 * For `input[type=color]` the browser fires `input` continuously while the user
 * drags through shades and `change` when the selection settles, so the preview
 * follows `input` and the config write happens on `change`. Pointer events are
 * not usable here because the picker is an OS-level surface outside the page.
 */
export function ColorField({
  disabled,
  label,
  value,
  onCommit,
}: ColorFieldProps) {
  const [pickedValue, setPickedValue] = useState<string | null>(null);
  const shown = pickedValue ?? value;

  useEffect(() => {
    setPickedValue(null);
  }, [value]);

  const commit = () => {
    if (pickedValue !== null && pickedValue !== value) {
      onCommit(pickedValue);
    }
  };

  return (
    <span className="settings-color-field">
      <input
        aria-label={label}
        disabled={disabled}
        type="color"
        value={shown}
        onBlur={commit}
        onChange={(event) => onCommit(event.target.value)}
        onInput={(event) => setPickedValue(event.currentTarget.value)}
      />
    </span>
  );
}
