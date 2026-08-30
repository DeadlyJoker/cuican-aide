import { CircleAlert } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CommandLinkedThread } from "./CommandWorkspaceChrome";
import type { CommandSidebarThreadState } from "./commandSidebarThreadPresentation";
import { classNames } from "./commandWorkspaceUtils";

export function CommandTaskStatusIndicator({
  label,
  state,
  updatedLabel,
}: {
  label: string;
  state: CommandSidebarThreadState;
  updatedLabel: string;
}) {
  switch (state) {
    case "running":
      return (
        <span
          aria-label={label}
          className="command-thread-status is-running"
          role="img"
        >
          <i />
          <i />
          <i />
        </span>
      );
    case "pendingUnread":
      return (
        <span
          aria-label={label}
          className="command-thread-status is-pending-unread"
          role="img"
        />
      );
    case "pendingViewed":
      return (
        <span
          aria-label={label}
          className="command-thread-status is-pending-viewed"
          role="img"
        />
      );
    case "completedUnread":
      return (
        <span
          aria-label={label}
          className="command-thread-status is-completed-unread"
          role="img"
        />
      );
    case "failed":
      return (
        <span
          aria-label={label}
          className="command-thread-status is-failed"
          role="img"
        >
          <CircleAlert aria-hidden="true" />
        </span>
      );
    case "completedViewed":
    case "neutral":
      return <em className="command-thread-status-time">{updatedLabel}</em>;
  }
}

export function CommandSidebarThreadRow({
  onOpen,
  selected,
  thread,
  workspaceLabel,
}: {
  onOpen: (threadId: string) => void;
  selected: boolean;
  thread: CommandLinkedThread;
  workspaceLabel: string;
}) {
  const state = thread.state ?? "completedViewed";
  const stateLabel = thread.stateLabel ?? "";
  const scopeLabel = thread.scopeLabel ?? "";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={classNames(
            "conversation-item linked-conversation-item recent-thread-item",
            selected && "active",
          )}
          data-linked-thread-id={thread.id}
          data-thread-state={state}
          type="button"
          onClick={() => onOpen(thread.id)}
        >
          <span className="command-sidebar-thread-title">{thread.title}</span>
          <CommandTaskStatusIndicator
            label={stateLabel}
            state={state}
            updatedLabel={thread.updatedLabel}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent
        className="command-sidebar-thread-tooltip"
        side="right"
        sideOffset={10}
      >
        <strong>{thread.title}</strong>
        {thread.preview && thread.preview !== thread.title ? (
          <span>{thread.preview}</span>
        ) : null}
        <small>
          {[workspaceLabel, scopeLabel, stateLabel, thread.updatedLabel]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </TooltipContent>
    </Tooltip>
  );
}
