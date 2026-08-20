import {
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { CommandLinkedThread } from "./CommandWorkspaceChrome";
import { classNames } from "./commandWorkspaceUtils";

export function CommandSidebarWorkspaceTree({
  copy,
  linkedThreads,
  selectedWorkspaceName,
  selectedLinkedThreadId,
  onClearWorkspace,
  onNewThread,
  onSelectWorkspace,
  onOpenLinkedThread,
}: {
  copy: {
    addWorkspace: string;
    chooseFolder: string;
    newThread: string;
    noWorkspace: string;
    removeWorkspace: (name: string) => string;
    tasks: string;
    tasksEmpty: string;
    tasksTree: string;
    threadInWorkspace: (name: string) => string;
    workspace: string;
    workspaceThreadsEmpty: string;
  };
  linkedThreads: CommandLinkedThread[];
  selectedWorkspaceName?: string | null;
  selectedLinkedThreadId: string | null;
  onClearWorkspace?: () => void;
  onNewThread: () => void;
  onSelectWorkspace?: () => void;
  onOpenLinkedThread: (id: string) => void;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, CommandLinkedThread[]>();
    for (const thread of linkedThreads) {
      const key = thread.cwd?.trim() || "";
      const group = grouped.get(key) ?? [];
      group.push(thread);
      grouped.set(key, group);
    }
    return [...grouped.entries()]
      .map(([cwd, threads]) => ({ cwd, threads }))
      .sort((left, right) => {
        if (!left.cwd) return 1;
        if (!right.cwd) return -1;
        return left.cwd.localeCompare(right.cwd);
      });
  }, [linkedThreads]);
  const hasSelectedWorkspaceGroup = Boolean(
    selectedWorkspaceName &&
      groups.some((group) => {
        if (!group.cwd) return false;
        const name =
          group.cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
          group.cwd;
        return name === selectedWorkspaceName;
      }),
  );

  function toggleGroup(key: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <section
      aria-label={copy.tasksTree}
      className="space-tree"
      data-od-id="desktop-workspace-tree"
    >
      <div className="tree-head">
        <strong className="tree-head-label">{copy.workspace}</strong>
        <button
          aria-label={onSelectWorkspace ? copy.chooseFolder : copy.newThread}
          className="tree-head-action"
          title={onSelectWorkspace ? copy.chooseFolder : copy.newThread}
          type="button"
          onClick={onSelectWorkspace ?? onNewThread}
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
      {selectedWorkspaceName && !hasSelectedWorkspaceGroup ? (
        <div className="space-node current real-workspace-node selected-workspace-node">
          <div className="space-title real-workspace-title">
            <button
              aria-expanded="true"
              className="workspace-title-toggle"
              title={selectedWorkspaceName}
              type="button"
            >
              <FolderOpen aria-hidden="true" />
              <strong>{selectedWorkspaceName}</strong>
            </button>
            <span className="workspace-row-actions">
              <button
                aria-label={copy.threadInWorkspace(selectedWorkspaceName)}
                title={copy.threadInWorkspace(selectedWorkspaceName)}
                type="button"
                onClick={onNewThread}
              >
                <SquarePen aria-hidden="true" />
              </button>
              {onClearWorkspace ? (
                <button
                  aria-label={copy.removeWorkspace(selectedWorkspaceName)}
                  className="workspace-remove-action"
                  title={copy.removeWorkspace(selectedWorkspaceName)}
                  type="button"
                  onClick={onClearWorkspace}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              ) : null}
            </span>
          </div>
          <p className="sidebar-empty-hint">{copy.workspaceThreadsEmpty}</p>
        </div>
      ) : null}
      {groups.length > 0 ? (
        groups.map((group, index) => {
          const groupKey = group.cwd || "standalone";
          const collapsed = collapsedGroups.has(groupKey);
          const name = group.cwd
            ? (group.cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
              group.cwd)
            : copy.noWorkspace;
          const listId = `command-workspace-thread-list-${index}`;
          return (
            <div
              className={classNames(
                "space-node real-workspace-node",
                !group.cwd && "standalone-workspace-node",
                collapsed && "collapsed",
              )}
              key={groupKey}
            >
              <div className="space-title real-workspace-title">
                <button
                  aria-controls={listId}
                  aria-expanded={!collapsed}
                  className="workspace-title-toggle"
                  title={name}
                  type="button"
                  onClick={() => toggleGroup(groupKey)}
                >
                  {group.cwd ? (
                    collapsed ? (
                      <Folder aria-hidden="true" />
                    ) : (
                      <FolderOpen aria-hidden="true" />
                    )
                  ) : (
                    <ChevronRight aria-hidden="true" />
                  )}
                  <strong>{name}</strong>
                </button>
                <span className="workspace-row-actions">
                  <button
                    aria-label={copy.threadInWorkspace(name)}
                    title={copy.threadInWorkspace(name)}
                    type="button"
                    onClick={onNewThread}
                  >
                    <SquarePen aria-hidden="true" />
                  </button>
                </span>
              </div>
              <div
                className="conversation-list recent-thread-list"
                hidden={collapsed}
                id={listId}
              >
                {group.threads.slice(0, 20).map((thread) => (
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
                ))}
              </div>
            </div>
          );
        })
      ) : selectedWorkspaceName ? null : (
        <p className="sidebar-empty-hint">{copy.tasksEmpty}</p>
      )}
    </section>
  );
}
