import { useEffect, useState } from "react";

type SliderFieldProps = {
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  step: number;
  value: string;
  onCommit: (value: string) => void;
};

/**
 * A slider that previews while dragging and persists on release. Committing per
 * step would write config on every pixel of a drag; the readout still tracks the
 * thumb so the interaction stays live.
 */
export function SliderField({
  disabled,
  label,
  max,
  min,
  step,
  value,
  onCommit,
}: SliderFieldProps) {
  const [dragValue, setDragValue] = useState<string | null>(null);
  const shown = dragValue ?? value;

  // Drop the local preview once the committed value catches up, so external
  // changes (a reset elsewhere) are not masked by a stale drag value.
  useEffect(() => {
    setDragValue(null);
  }, [value]);

  const commit = () => {
    if (dragValue !== null && dragValue !== value) {
      onCommit(dragValue);
    }
  };

  return (
    <span className="settings-slider-field">
      <input
        aria-label={label}
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        type="range"
        value={shown}
        onBlur={commit}
        onChange={(event) => setDragValue(event.target.value)}
        onKeyUp={commit}
        onPointerUp={commit}
      />
      <output>{shown}</output>
    </span>
  );
}
