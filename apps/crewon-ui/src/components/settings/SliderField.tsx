import { useEffect, useState } from "react";

import { Slider } from "@/components/ui/slider";

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
 * A slider that previews while dragging and persists on release, built on the
 * shared Radix `Slider` primitive: `onValueChange` drives the readout preview
 * and `onValueCommit` (pointer release / key interaction end) writes config.
 * Committing per step would write config on every pixel of a drag.
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
  const numericShown = Number(shown);

  // Drop the local preview once the committed value catches up, so external
  // changes (a reset elsewhere) are not masked by a stale drag value.
  useEffect(() => {
    setDragValue(null);
  }, [value]);

  return (
    <span className="settings-slider-field">
      <Slider
        aria-label={label}
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        value={[Number.isFinite(numericShown) ? numericShown : min]}
        onValueChange={([next]) => setDragValue(String(next))}
        onValueCommit={([next]) => {
          setDragValue(null);
          const committed = String(next);
          if (committed !== value) {
            onCommit(committed);
          }
        }}
      />
      <output>{shown}</output>
    </span>
  );
}
