import { ChevronDown, ChevronUp } from "lucide-react";
import { useId, type ComponentProps } from "react";
import { CommandSidebarThreadRow } from "./CommandSidebarThreadRow";
import type { CommandLinkedThread } from "./CommandWorkspaceChrome";
import "./CommandSidebarThreadList.css";

const RECENT_THREAD_LIMIT = 5;

/** Keep the complete list upstream for search; folding is only a presentation choice. */
export function CommandSidebarThreadList({
  threads,
  expanded,
  onToggleExpanded,
  selectedThreadId,
  showMoreLabel,
  showFewerLabel,
  ...rowProps
}: Pick<
  ComponentProps<typeof CommandSidebarThreadRow>,
  "archiveLabel" | "onArchive" | "onOpen" | "workspaceLabel"
> & {
  threads: CommandLinkedThread[];
  expanded: boolean;
  onToggleExpanded: () => void;
  selectedThreadId: string | null;
  showMoreLabel: (count: number) => string;
  showFewerLabel: string;
}) {
  const olderThreadsId = useId();
  const remaining = Math.max(0, threads.length - RECENT_THREAD_LIMIT);
  const toggleLabel = expanded ? showFewerLabel : showMoreLabel(remaining);
  const renderRow = (thread: CommandLinkedThread) => (
    <CommandSidebarThreadRow
      {...rowProps}
      key={thread.id}
      selected={selectedThreadId === thread.id}
      thread={thread}
    />
  );

  return (
    <>
      {threads.slice(0, RECENT_THREAD_LIMIT).map(renderRow)}
      {remaining > 0 ? (
        <>
          <div
            className="sidebar-older-threads"
            id={olderThreadsId}
            hidden={!expanded}
          >
            {expanded
              ? threads.slice(RECENT_THREAD_LIMIT).map(renderRow)
              : null}
          </div>
          <button
            className="sidebar-threads-disclosure"
            type="button"
            aria-controls={olderThreadsId}
            aria-expanded={expanded}
            aria-label={`${rowProps.workspaceLabel}：${toggleLabel}`}
            onClick={onToggleExpanded}
          >
            {expanded ? (
              <ChevronUp aria-hidden="true" />
            ) : (
              <ChevronDown aria-hidden="true" />
            )}
            <span>{toggleLabel}</span>
          </button>
        </>
      ) : null}
    </>
  );
}
