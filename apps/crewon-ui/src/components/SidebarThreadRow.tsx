import { Archive, Pencil, RotateCcw, Trash2 } from "lucide-react";
import clsx from "clsx";
import type { Thread } from "@crewon-ui-model/v2/Thread";

import type { Locale } from "../lib/i18n";
import { formatRelativeTime, formatThreadTimestamp } from "../lib/shared/text";
import { sidebarThreadTitle } from "./SidebarPresentation";

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

  return (
    <div
      className={clsx("thread-row", selectedThreadId === thread.id && "selected")}
      aria-current={selectedThreadId === thread.id ? "page" : undefined}
    >
      <button
        className="thread-row-main"
        type="button"
        onClick={() => onSelectThread(thread.id)}
      >
        <span className="thread-row-top">
          <span className="thread-title">{title}</span>
          <span
            className="thread-time"
            title={formatThreadTimestamp(thread.updatedAt, locale)}
          >
            {formatRelativeTime(thread.updatedAt, locale)}
          </span>
        </span>
      </button>
      <span className="thread-row-actions">
        <button
          className="thread-row-action"
          type="button"
          aria-label={renameThreadLabel}
          title={renameThreadLabel}
          onClick={() => onRenameThread(thread)}
        >
          <Pencil size={12} />
        </button>
        <button
          className="thread-row-action"
          type="button"
          aria-label={actionLabel}
          title={actionLabel}
          onClick={() => onArchiveThread(thread)}
        >
          {showArchived ? <RotateCcw size={13} /> : <Archive size={13} />}
        </button>
        {showArchived ? (
          <button
            className="thread-row-action"
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
