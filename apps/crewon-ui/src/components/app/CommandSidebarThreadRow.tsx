import { Archive } from "lucide-react";

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
    case "pendingUnread":
      return (
        <span
          aria-label={label}
          className="command-thread-status is-pending-unread"
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
    case "failedUnread":
      return (
        <span
          aria-label={label}
          className="command-thread-status is-failed-unread"
          role="img"
        />
      );
    case "running":
    case "pendingViewed":
    case "completedViewed":
    case "failedViewed":
    case "neutral":
      return <em className="command-thread-status-time">{updatedLabel}</em>;
  }
}

export function CommandSidebarThreadRow({
  archiveLabel,
  onArchive,
  onOpen,
  selected,
  thread,
  workspaceLabel,
}: {
  archiveLabel: string;
  onArchive?: (threadId: string) => void;
  onOpen: (threadId: string) => void;
  selected: boolean;
  thread: CommandLinkedThread;
  workspaceLabel: string;
}) {
  const state = thread.state ?? "completedViewed";
  const stateLabel = thread.stateLabel ?? "";
  const scopeLabel = thread.scopeLabel ?? "";

  return (
    <div
      className="command-sidebar-thread-row"
      data-has-archive={onArchive ? "true" : undefined}
      data-selected={selected}
    >
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
      {onArchive ? (
        <button
          aria-label={archiveLabel}
          className="command-sidebar-thread-archive"
          data-archive-thread-id={thread.id}
          title={archiveLabel}
          type="button"
          onClick={() => onArchive(thread.id)}
        >
          <Archive aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
