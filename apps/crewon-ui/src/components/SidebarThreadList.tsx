import { FolderClosed } from "lucide-react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import type { Locale } from "../lib/i18n";
import type { ProjectSessionGroup } from "./SidebarPresentation";
import { SidebarThreadRow } from "./SidebarThreadRow";

function SidebarThreadSectionLabel({
  actionLabel,
  label,
  onAction,
  subtle = false,
}: {
  actionLabel?: string;
  label: string;
  onAction?: () => void;
  subtle?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-5 items-center justify-between px-[10px]",
        "text-[calc(11px_+_var(--user-ui-font-delta))] font-medium text-[var(--n-alpha-45)]",
        subtle && "mt-[14px]",
      )}
    >
      <span>{label}</span>
      {actionLabel && onAction ? (
        <button
          className="h-[19px] cursor-pointer rounded-[var(--radius-sm)] border-0 bg-transparent px-1.5 text-inherit transition-colors hover:bg-[var(--n-alpha-08)] hover:text-[var(--n-alpha-45)]"
          type="button"
          onClick={onAction}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function SidebarThreadListSkeleton({ label }: { label: string }) {
  return (
    <div aria-label={label} aria-live="polite" className="grid gap-1 px-[7px] py-1">
      <span className="sr-only">{label}</span>
      {[0.92, 0.75, 0.6].map((width) => (
        <div key={width} className="flex h-6 items-center">
          <Skeleton
            className="h-3.5 bg-[var(--n-alpha-08)]"
            style={{ width: `${width * 100}%` }}
          />
        </div>
      ))}
    </div>
  );
}

export function SidebarThreadList({
  activeThreadsLabel,
  archiveThreadLabel,
  archivedThreadsLabel,
  deleteThreadLabel,
  emptyLabel,
  isLoading,
  loadingLabel,
  locale,
  navLabels,
  normalizedSearchTerm,
  projectGroups,
  renameThreadLabel,
  selectedThreadId,
  showArchived,
  standaloneThreads,
  threadsSectionLabel,
  untitledThreadLabel,
  onArchiveThread,
  onDeleteThread,
  onRenameThread,
  onSelectThread,
  onToggleArchived,
}: {
  activeThreadsLabel: string;
  archiveThreadLabel: string;
  archivedThreadsLabel: string;
  deleteThreadLabel: string;
  emptyLabel: string;
  isLoading: boolean;
  loadingLabel: string;
  locale: Locale;
  navLabels: {
    project: string;
    conversations: string;
    session: string;
  };
  normalizedSearchTerm: string;
  projectGroups: ProjectSessionGroup[];
  renameThreadLabel: string;
  selectedThreadId: string | null;
  showArchived: boolean;
  standaloneThreads: Thread[];
  threadsSectionLabel: string;
  untitledThreadLabel: string;
  onArchiveThread: (thread: Thread) => void;
  onDeleteThread: (thread: Thread) => void;
  onRenameThread: (thread: Thread) => void;
  onSelectThread: (threadId: string) => void;
  onToggleArchived: () => void;
}) {
  const hasVisibleThreads = projectGroups.length + standaloneThreads.length > 0;
  const currentSectionLabel = showArchived ? archivedThreadsLabel : navLabels.project;
  const currentSectionAction = showArchived ? activeThreadsLabel : archivedThreadsLabel;
  const standaloneSectionLabel = showArchived ? navLabels.session : navLabels.conversations;

  function renderSessionRow(thread: Thread) {
    return (
      <SidebarThreadRow
        activeThreadsLabel={activeThreadsLabel}
        archiveThreadLabel={archiveThreadLabel}
        deleteThreadLabel={deleteThreadLabel}
        key={thread.id}
        locale={locale}
        renameThreadLabel={renameThreadLabel}
        selectedThreadId={selectedThreadId}
        showArchived={showArchived}
        thread={thread}
        untitledThreadLabel={untitledThreadLabel}
        onArchiveThread={onArchiveThread}
        onDeleteThread={onDeleteThread}
        onRenameThread={onRenameThread}
        onSelectThread={onSelectThread}
      />
    );
  }

  return (
    <>
      <SidebarThreadSectionLabel
        actionLabel={currentSectionAction}
        label={currentSectionLabel}
        onAction={onToggleArchived}
      />

      <nav
        aria-label={threadsSectionLabel}
        className="grid min-h-0 flex-1 content-start gap-0 overflow-auto"
      >
        {projectGroups.map((group) => (
          <section
            className="grid min-w-0 gap-0 [&+&]:mt-3"
            aria-label={`${group.name} ${navLabels.session}`}
            key={group.cwd}
          >
            <div
              className="grid h-[30px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[9px] px-[10px] text-[calc(13px_+_var(--user-ui-font-delta))] text-[var(--n-alpha-60)] [&>svg]:opacity-80"
              title={group.cwd}
            >
              <FolderClosed size={15} />
              <strong className="truncate font-medium">{group.name}</strong>
            </div>
            <div className="grid min-w-0 gap-0 pl-3.5">
              {group.threads.map(renderSessionRow)}
            </div>
          </section>
        ))}

        <SidebarThreadSectionLabel label={standaloneSectionLabel} subtle />
        <div className="grid min-w-0 gap-0">
          {standaloneThreads.length > 0
            ? standaloneThreads.map(renderSessionRow)
            : null}
        </div>

        {!hasVisibleThreads && isLoading && !normalizedSearchTerm ? (
          <SidebarThreadListSkeleton label={loadingLabel} />
        ) : null}
        {!hasVisibleThreads && (!isLoading || normalizedSearchTerm) ? (
          <div
            aria-live="polite"
            className="px-2 py-3 text-center text-[calc(11px_+_var(--user-ui-font-delta))] text-[var(--n-alpha-30)]"
          >
            {emptyLabel}
          </div>
        ) : null}
      </nav>
    </>
  );
}
