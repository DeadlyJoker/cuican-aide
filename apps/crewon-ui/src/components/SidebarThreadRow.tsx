import { Archive, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import { cn } from "@/lib/cn";
import type { Locale } from "../lib/i18n";
import { formatRelativeTime, formatThreadTimestamp } from "../lib/shared/text";
import { sidebarThreadTitle } from "./SidebarPresentation";
import {
  sidebarThreadActionClass,
  sidebarThreadRowClass,
  sidebarThreadRowSelectedClass,
} from "./sidebarStyles";

export function SidebarThreadRow({
  activeThreadsLabel,
  archiveThreadLabel,
  deleteThreadLabel,
  locale,
  renameThreadLabel,
  selectedThreadId,
  showArchived,
  thread,
  untitledThreadLabel,
  onArchiveThread,
  onDeleteThread,
  onRenameThread,
  onSelectThread,
}: {
  activeThreadsLabel: string;
  archiveThreadLabel: string;
  deleteThreadLabel: string;
  locale: Locale;
  renameThreadLabel: string;
  selectedThreadId: string | null;
  showArchived: boolean;
  thread: Thread;
  untitledThreadLabel: string;
  onArchiveThread: (thread: Thread) => void;
  onDeleteThread: (thread: Thread) => void;
  onRenameThread: (thread: Thread) => void;
  onSelectThread: (threadId: string) => void;
}) {
  const title = sidebarThreadTitle(thread, untitledThreadLabel);
  const actionLabel = showArchived ? activeThreadsLabel : archiveThreadLabel;
  const selected = selectedThreadId === thread.id;

  return (
    <div
      className={cn(sidebarThreadRowClass, selected && sidebarThreadRowSelectedClass)}
      data-selected={selected}
      aria-current={selected ? "page" : undefined}
    >
      <button
        className="grid min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left text-inherit"
        type="button"
        onClick={() => onSelectThread(thread.id)}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[calc(13px_+_var(--user-ui-font-delta))] font-medium leading-7">
            {title}
          </span>
          <span
            className="ml-auto shrink-0 text-[calc(11px_+_var(--user-ui-font-delta))] text-[var(--n-alpha-30)]"
            title={formatThreadTimestamp(thread.updatedAt, locale)}
          >
            {formatRelativeTime(thread.updatedAt, locale)}
          </span>
        </span>
      </button>
      <span className="inline-grid grid-flow-col gap-px">
        <button
          className={sidebarThreadActionClass}
          type="button"
          aria-label={renameThreadLabel}
          title={renameThreadLabel}
          onClick={() => onRenameThread(thread)}
        >
          <Pencil size={12} />
        </button>
        <button
          className={sidebarThreadActionClass}
          type="button"
          aria-label={actionLabel}
          title={actionLabel}
          onClick={() => onArchiveThread(thread)}
        >
          {showArchived ? <RotateCcw size={13} /> : <Archive size={13} />}
        </button>
        {showArchived ? (
          <button
            className={cn(
              sidebarThreadActionClass,
              "hover:bg-[var(--n-alpha-10)] hover:text-red-400",
            )}
            type="button"
            aria-label={deleteThreadLabel}
            title={deleteThreadLabel}
            onClick={() => onDeleteThread(thread)}
          >
            <Trash2 size={13} />
          </button>
        ) : null}
      </span>
    </div>
  );
}
