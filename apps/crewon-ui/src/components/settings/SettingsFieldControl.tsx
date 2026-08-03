import { ColorField } from "./ColorField";
import { SegmentedField } from "./SegmentedField";
import { SliderField } from "./SliderField";
import type { CapabilityPanelField } from "../../lib/capability/capabilityPanelTypes";

type SettingsFieldControlProps = {
  disabled: boolean;
  field: CapabilityPanelField;
  onChange: (value: string, commitOnChange: boolean) => void;
};

/**
 * Renders one settings field. Appearance settings need real color, number,
 * segmented, toggle, and slider controls; routing them through one component
 * keeps SettingsContent free of per-control branching.
 */
export function SettingsFieldControl({
  disabled,
  field,
  onChange,
}: SettingsFieldControlProps) {
  const commit = field.commitOnChange === true;
  const emit = (value: string) => onChange(value, commit);

  if (field.control === "toggle") {
    const checked = field.value === "true";
    return (
      <button
        aria-checked={checked}
        className="settings-toggle"
        disabled={disabled}
        role="switch"
        type="button"
        onClick={() => onChange(String(!checked), true)}
      >
        <span aria-hidden="true" />
      </button>
    );
  }

  if (field.control === "segmented" && field.options) {
    return (
      <SegmentedField
        disabled={disabled}
        label={field.label}
        options={field.options}
        value={field.value}
        onChange={(value) => onChange(value, true)}
      />
    );
  }

  if (field.control === "color") {
    return (
      <ColorField
        disabled={disabled}
        label={field.label}
        value={field.value}
        onCommit={(next) => onChange(next, true)}
      />
    );
  }

  if (field.control === "slider") {
    return (
      <SliderField
        disabled={disabled}
        label={field.label}
        max={field.max ?? 100}
        min={field.min ?? 0}
        step={field.step ?? 1}
        value={field.value}
        onCommit={(next) => onChange(next, true)}
      />
    );
  }

  if (field.control === "number") {
    return (
      <span className="settings-number-field">
        <input
          disabled={disabled}
          max={field.max}
          min={field.min}
          step={field.step ?? 1}
          type="number"
          value={field.value}
          onChange={(event) => emit(event.target.value)}
        />
        {field.unit ? <small>{field.unit}</small> : null}
      </span>
    );
  }

  if (field.options) {
    return (
      <select
        disabled={disabled}
        value={field.value}
        onChange={(event) => emit(event.target.value)}
      >
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.multiline) {
    return (
      <textarea
        disabled={disabled}
        placeholder={field.placeholder}
        rows={field.rows ?? 5}
        value={field.value}
        onChange={(event) => emit(event.target.value)}
      />
    );
  }

  return (
    <input
      disabled={disabled}
      placeholder={field.placeholder}
      type={field.secret ? "password" : "text"}
      value={field.value}
      onChange={(event) => emit(event.target.value)}
    />
  );
}
