import type { LucideIcon } from "lucide-react";
import { useId } from "react";

import { classNames } from "./commandWorkspaceUtils";

type CommandTeamEmptyStateAction = {
  label: string;
  onClick: () => void;
  primary?: boolean;
};

export function CommandTeamEmptyState({
  action,
  description,
  eyebrow,
  icon: Icon,
  state = "empty",
  statusLabel,
  title,
}: {
  action?: CommandTeamEmptyStateAction | null;
  description: string;
  eyebrow: string;
  icon: LucideIcon;
  state?: "empty" | "loading" | "unavailable";
  statusLabel?: string;
  title: string;
}) {
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className="command-team-empty-state"
      data-team-empty-state={state}
    >
      <span className="command-team-empty-icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="command-team-empty-copy">
        <span className="command-team-empty-eyebrow">{eyebrow}</span>
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
      </div>
      {statusLabel || action ? (
        <footer className="command-team-empty-footer">
          {statusLabel ? (
            <span className="command-team-empty-status" role="status">
              {statusLabel}
            </span>
          ) : null}
          {action ? (
            <button
              className={classNames("button", action.primary && "primary")}
              type="button"
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
