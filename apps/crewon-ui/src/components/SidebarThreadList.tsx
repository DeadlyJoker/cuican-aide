import { FolderClosed } from "lucide-react";
import type { Thread } from "@crewon-protocol/v2/Thread";

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
    <div className={subtle ? "thread-section-label is-subtle" : "thread-section-label"}>
      <span>{label}</span>
      {actionLabel && onAction ? (
        <button className="thread-section-action" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
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

      <nav className="thread-list" aria-label={threadsSectionLabel}>
        {projectGroups.map((group) => (
          <section
            className="project-session-group"
            aria-label={`${group.name} ${navLabels.session}`}
            key={group.cwd}
          >
            <div className="project-row" title={group.cwd}>
              <FolderClosed size={14} />
              <strong>{group.name}</strong>
            </div>
            <div className="project-session-list">
              {group.threads.map(renderSessionRow)}
            </div>
          </section>
        ))}

        <SidebarThreadSectionLabel label={standaloneSectionLabel} subtle />
        <div className="project-session-list standalone-session-list">
          {standaloneThreads.length > 0
            ? standaloneThreads.map(renderSessionRow)
            : null}
        </div>

        {!hasVisibleThreads && isLoading && !normalizedSearchTerm ? (
          <div className="thread-loading-state" aria-label={loadingLabel} aria-live="polite">
            <span>{loadingLabel}</span>
            <div aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </div>
        ) : null}
        {!hasVisibleThreads && (!isLoading || normalizedSearchTerm) ? (
          <div className="thread-empty-state" aria-live="polite">
            {emptyLabel}
          </div>
        ) : null}
      </nav>
    </>
  );
}
