import { Plus } from "lucide-react";

import type { CommandLinkedThread } from "./CommandWorkspaceChrome";
import { classNames } from "./commandWorkspaceUtils";

export function CommandSidebarWorkspaceTree({
  copy,
  linkedThreads,
  selectedLinkedThreadId,
  onNewThread,
  onOpenLinkedThread,
}: {
  copy: {
    newThread: string;
    tasks: string;
    tasksEmpty: string;
    tasksTree: string;
  };
  linkedThreads: CommandLinkedThread[];
  selectedLinkedThreadId: string | null;
  onNewThread: () => void;
  onOpenLinkedThread: (id: string) => void;
}) {
  return (
    <section
      aria-label={copy.tasksTree}
      className="space-tree"
      data-od-id="desktop-workspace-tree"
    >
      <div className="tree-head">
        <strong className="tree-head-label">{copy.tasks}</strong>
        <button
          aria-label={copy.newThread}
          className="tree-head-action"
          title={copy.newThread}
          type="button"
          onClick={onNewThread}
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
      <div className="space-node current control-task-node">
        <div className="conversation-list recent-thread-list">
          {linkedThreads.length > 0 ? (
            linkedThreads.slice(0, 10).map((thread) => (
              <button
                className={classNames(
                  "conversation-item linked-conversation-item recent-thread-item",
                  selectedLinkedThreadId === thread.id && "active",
                )}
                data-linked-thread-id={thread.id}
                key={thread.id}
                title={thread.preview}
                type="button"
                onClick={() => onOpenLinkedThread(thread.id)}
              >
                <span>{thread.title}</span>
                <em>{thread.updatedLabel}</em>
              </button>
            ))
          ) : (
            <p className="sidebar-empty-hint">{copy.tasksEmpty}</p>
          )}
        </div>
      </div>
    </section>
  );
}
