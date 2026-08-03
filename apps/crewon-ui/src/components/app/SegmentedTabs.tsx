import type { ReactNode } from "react";

import { classNames } from "./commandWorkspaceUtils";

export type SegmentedTabOption = {
  label: string;
  value: string;
  icon?: ReactNode;
};

/**
 * The one segmented control for the workspace.
 *
 * Every page that offers a small set of mutually exclusive views renders this,
 * so the height, radius, and selected treatment stay identical across the
 * catalog pages and the schedule. Pages that hand-rolled their own strip drifted
 * apart on all three.
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
          className={classNames(
            "filter-chip mode-tab",
            active === option.value && "active",
          )}
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
