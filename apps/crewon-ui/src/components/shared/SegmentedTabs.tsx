import type { ReactNode } from "react";

export type SegmentedTabOption = {
  label: string;
  value: string;
  icon?: ReactNode;
};

/**
 * The one segmented control for the workspace.
 *
 * Every surface that offers a small set of mutually exclusive views renders
 * this, so the height, radius, and selected treatment stay identical across the
 * catalog pages, the schedule, and the Team rooms. Surfaces that hand-rolled
 * their own strip drifted apart on all three.
 *
 * It lives outside `components/app` because the Office room renders it too, and
 * feature components may not depend on app coordination modules.
 */
export function SegmentedTabs({
  active,
  group,
  label,
  options,
  onChange,
}: {
  active: string;
  group?: string;
  label: string;
  options: SegmentedTabOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="catalog-mode-tabs" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          aria-pressed={active === option.value}
          className={
            active === option.value
              ? "filter-chip mode-tab active"
              : "filter-chip mode-tab"
          }
          data-filter={option.value}
          data-filter-group={group}
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
