import {
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandSidebarThreadList } from "./CommandSidebarThreadList";
import type {
  CommandControlWorkspaceNav,
  CommandLinkedThread,
  CommandWorkspaceAuthority,
} from "./CommandWorkspaceChrome";
import { classNames } from "./commandWorkspaceUtils";
import { groupControlWorkspaceThreads } from "../../lib/workspace/controlWorkspaceGroups";

type Copy = {
  addWorkspace: string;
  archiveThread: string;
  cancel: string;
  chooseFolder: string;
  controlWorkspaceEmpty: string;
  controlWorkspaceReadOnly: string;
  controlWorkspaceUnavailable: string;
  folderPath: string;
  folderPathHint: string;
  newStandaloneThread: string;
  newThread: string;
  noWorkspace: string;
  open: string;
  remove: string;
  removeWorkspace: (name: string) => string;
  removeWorkspaceHint: string;
  removeWorkspaceTitle: (name: string) => string;
  replaceWorkspace: string;
  selectWorkspace: string;
  switchWorkspace: (name: string) => string;
  threadInWorkspace: (name: string) => string;
  unbindWorkspace: (name: string) => string;
  workspace: string;
  workspaceEmpty: string;
  workspaceSelectFailed: (detail: string) => string;
  workspaceThreadsEmpty: string;
  workspaceTree: string;
  showMoreThreads: (count: number) => string;
  showFewerThreads: string;
};

function workspaceName(path: string, emptyLabel = "工作空间"): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return (
    normalized.split("/").filter(Boolean).pop() || normalized || emptyLabel
  );
}
export function CommandSidebarWorkspaceTree(props: {
  workspaceAuthority: CommandWorkspaceAuthority;
  copy: Copy;
  onNewThread: (cwd: string | null) => void;
  linkedThreads: CommandLinkedThread[];
  selectedLinkedThreadId: string | null;
  onArchiveThread?: (id: string) => void;
  onOpenLinkedThread: (id: string) => void;
  nativeFolderPicker: boolean;
  workspaceFormOpen: boolean;
  pickerBusy: boolean;
  onCreateWorkspace?: (cwd: string) => void;
  chooseWorkspaceFolder: () => Promise<void>;
  setWorkspaceFormOpen: (
    value: boolean | ((current: boolean) => boolean),
  ) => void;
  submitWorkspace: (event: FormEvent<HTMLFormElement>) => void;
  workspaceDraft: string;
  setWorkspaceDraft: (value: string) => void;
  cwd: string;
  currentWorkspaceCollapsed: boolean;
  toggleWorkspaceGroup: (id: string) => void;
  currentWorkspaceName: string;
  setPendingRemoval: (path: string | null) => void;
  currentWorkspaceThreads: CommandLinkedThread[];
  standaloneThreads: CommandLinkedThread[];
  otherWorkspaceGroups: Array<{ path: string; threads: CommandLinkedThread[] }>;
  standaloneWorkspaceCollapsed: boolean;
  pendingRemoval: string | null;
  removeWorkspace: (path: string) => void;
  controlWorkspace?: CommandControlWorkspaceNav;
}) {
  const {
    workspaceAuthority,
    copy,
    onNewThread,
    linkedThreads,
    selectedLinkedThreadId,
    onArchiveThread,
    onOpenLinkedThread,
    nativeFolderPicker,
    workspaceFormOpen,
    pickerBusy,
    onCreateWorkspace,
    chooseWorkspaceFolder,
    setWorkspaceFormOpen,
    submitWorkspace,
    workspaceDraft,
    setWorkspaceDraft,
    cwd,
    currentWorkspaceCollapsed,
    toggleWorkspaceGroup,
    currentWorkspaceName,
    setPendingRemoval,
    currentWorkspaceThreads,
    standaloneThreads,
    otherWorkspaceGroups,
    standaloneWorkspaceCollapsed,
    pendingRemoval,
    removeWorkspace,
    controlWorkspace,
  } = props;
  const [expandedThreadGroups, setExpandedThreadGroups] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const controlGroups = groupControlWorkspaceThreads(
    controlWorkspace?.workspaces ?? [],
    linkedThreads,
  );
  const renderThreadItems = ({
    threads,
    workspaceLabel,
    workspaceKey,
  }: {
    threads: CommandLinkedThread[];
    workspaceLabel: string;
    workspaceKey: string;
  }) => (
    <CommandSidebarThreadList
      archiveLabel={copy.archiveThread}
      onArchive={onArchiveThread}
      onOpen={onOpenLinkedThread}
      selectedThreadId={selectedLinkedThreadId}
      threads={threads}
      workspaceLabel={workspaceLabel}
      expanded={expandedThreadGroups.has(workspaceKey)}
      onToggleExpanded={() =>
        setExpandedThreadGroups((current) => {
          const next = new Set(current);
          if (next.has(workspaceKey)) next.delete(workspaceKey);
          else next.add(workspaceKey);
          return next;
        })
      }
      showMoreLabel={copy.showMoreThreads}
      showFewerLabel={copy.showFewerThreads}
    />
  );
  return (
    <TooltipProvider delayDuration={350}>
      <section
        className="space-tree"
        data-od-id="desktop-workspace-tree"
        aria-label={copy.workspaceTree}
      >
        {workspaceAuthority === "control" ? (
          <>
            <div className="tree-head">
              <strong className="tree-head-label">{copy.workspace}</strong>
              {controlWorkspace?.onSelect ? (
                <button
                  aria-label={copy.addWorkspace}
                  className="tree-head-action"
                  disabled={controlWorkspace.busy}
                  title={copy.addWorkspace}
                  type="button"
                  onClick={() => controlWorkspace.onSelect?.()}
                >
                  <Plus aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {controlGroups.groups.map((group) => {
              const name =
                group.displayName ??
                (copy.workspace === "工作空间"
                  ? "未连接的工作空间"
                  : "Disconnected workspace");
              const current =
                group.workspaceId === controlWorkspace?.workspaceId;
              return (
                <div
                  className={classNames(
                    "space-node real-workspace-node",
                    current && "current",
                  )}
                  key={group.workspaceId}
                  data-workspace-id={group.workspaceId}
                >
                  <div className="space-title real-workspace-title">
                    <button
                      aria-label={copy.switchWorkspace(name)}
                      className="workspace-title-toggle"
                      type="button"
                      disabled={
                        controlWorkspace?.busy ||
                        group.displayName === null ||
                        !controlWorkspace?.onActivate
                      }
                      onClick={() =>
                        controlWorkspace?.onActivate?.(group.workspaceId)
                      }
                    >
                      {current ? (
                        <FolderOpen aria-hidden="true" />
                      ) : (
                        <Folder aria-hidden="true" />
                      )}
                      <strong>{name}</strong>
                    </button>
                    <span className="workspace-row-actions">
                      <button
                        aria-label={copy.threadInWorkspace(name)}
                        title={copy.threadInWorkspace(name)}
                        type="button"
                        disabled={
                          controlWorkspace?.busy ||
                          !controlWorkspace?.onActivate ||
                          group.displayName === null
                        }
                        onClick={() =>
                          controlWorkspace?.onActivate?.(group.workspaceId)
                        }
                      >
                        <SquarePen aria-hidden="true" />
                      </button>
                      {current && controlWorkspace?.onClear ? (
                        <button
                          aria-label={
                            copy.workspace === "工作空间"
                              ? "取消选择工作空间"
                              : "Clear workspace selection"
                          }
                          title={
                            copy.workspace === "工作空间"
                              ? "取消选择工作空间"
                              : "Clear workspace selection"
                          }
                          type="button"
                          disabled={controlWorkspace.busy}
                          onClick={() => controlWorkspace.onClear?.()}
                        >
                          <X aria-hidden="true" />
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <div className="conversation-list recent-thread-list">
                    {group.threads.length ? (
                      renderThreadItems({
                        threads: group.threads,
                        workspaceLabel: name,
                        workspaceKey: group.workspaceId,
                      })
                    ) : (
                      <p className="sidebar-empty-hint">
                        {copy.workspaceThreadsEmpty}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
            {!controlGroups.groups.length ? (
              <p className="sidebar-empty-hint workspace-empty-hint">
                {controlWorkspace?.mutationAuthority === "readOnly"
                  ? copy.controlWorkspaceReadOnly
                  : controlWorkspace?.mutationAuthority === "unavailable"
                    ? copy.controlWorkspaceUnavailable
                    : copy.controlWorkspaceEmpty}
              </p>
            ) : null}
            {controlGroups.unbound.length > 0 ? (
              <div
                className={classNames(
                  "space-node standalone-workspace-node",
                  standaloneWorkspaceCollapsed && "collapsed",
                )}
              >
                <div className="space-title standalone-workspace-title">
                  <button
                    aria-controls="standalone-workspace-thread-list"
                    aria-expanded={!standaloneWorkspaceCollapsed}
                    className="workspace-title-toggle standalone-workspace-toggle"
                    type="button"
                    onClick={() => toggleWorkspaceGroup("standalone")}
                  >
                    <ChevronRight aria-hidden="true" />
                    <strong>{copy.noWorkspace}</strong>
                  </button>
                  <span className="workspace-row-actions">
                    <button
                      aria-label={copy.newStandaloneThread}
                      title={copy.newStandaloneThread}
                      type="button"
                      disabled={controlWorkspace?.busy}
                      onClick={() =>
                        controlWorkspace?.onClear
                          ? controlWorkspace.onClear()
                          : onNewThread(null)
                      }
                    >
                      <SquarePen aria-hidden="true" />
                    </button>
                  </span>
                </div>
                <div
                  className="conversation-list recent-thread-list standalone-thread-list"
                  hidden={standaloneWorkspaceCollapsed}
                  id="standalone-workspace-thread-list"
                >
                  {renderThreadItems({
                    threads: controlGroups.unbound,
                    workspaceLabel: copy.noWorkspace,
                    workspaceKey: "control:unbound",
                  })}
                </div>
              </div>
            ) : null}
            {controlWorkspace?.error ? (
              <p className="sidebar-error-hint" role="alert">
                {copy.workspaceSelectFailed(controlWorkspace.error)}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="tree-head">
              <strong className="tree-head-label">{copy.workspace}</strong>
              <button
                aria-expanded={
                  nativeFolderPicker ? undefined : workspaceFormOpen
                }
                aria-label={
                  nativeFolderPicker ? copy.chooseFolder : copy.addWorkspace
                }
                className="tree-head-action"
                /*
                 * Only the picker path disables: a dialog already on screen must not
                 * be asked for a second one. The form path keeps its old behaviour of
                 * opening regardless, with the submit button carrying the guard.
                 */
                disabled={
                  nativeFolderPicker && (pickerBusy || !onCreateWorkspace)
                }
                title={
                  nativeFolderPicker ? copy.chooseFolder : copy.addWorkspace
                }
                type="button"
                onClick={() => {
                  if (nativeFolderPicker) {
                    void chooseWorkspaceFolder();
                    return;
                  }
                  setWorkspaceFormOpen((open) => !open);
                }}
              >
                <Plus aria-hidden="true" />
              </button>
              <form
                className="sidebar-workspace-form"
                hidden={nativeFolderPicker || !workspaceFormOpen}
                onSubmit={submitWorkspace}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setWorkspaceFormOpen(false);
                  }
                }}
              >
                <strong className="sidebar-workspace-form-title">
                  {copy.addWorkspace}
                </strong>
                <label htmlFor="command-workspace-path">
                  {copy.folderPath}
                </label>
                <input
                  id="command-workspace-path"
                  placeholder="/Users/me/project"
                  value={workspaceDraft}
                  onChange={(event) => setWorkspaceDraft(event.target.value)}
                />
                <p className="sidebar-workspace-form-hint">
                  {copy.folderPathHint}
                </p>
                <div className="sidebar-workspace-form-actions">
                  <button
                    type="button"
                    onClick={() => setWorkspaceFormOpen(false)}
                  >
                    {copy.cancel}
                  </button>
                  <button
                    className="primary"
                    type="submit"
                    disabled={!workspaceDraft.trim() || !onCreateWorkspace}
                  >
                    {copy.open}
                  </button>
                </div>
              </form>
            </div>
            {cwd ? (
              <div
                className={classNames(
                  "space-node current real-workspace-node",
                  currentWorkspaceCollapsed && "collapsed",
                )}
              >
                <div className="space-title real-workspace-title">
                  <button
                    aria-controls="current-workspace-thread-list"
                    aria-expanded={!currentWorkspaceCollapsed}
                    className="workspace-title-toggle"
                    type="button"
                    onClick={() => toggleWorkspaceGroup(cwd)}
                  >
                    {currentWorkspaceCollapsed ? (
                      <Folder aria-hidden="true" />
                    ) : (
                      <FolderOpen aria-hidden="true" />
                    )}
                    <strong>{currentWorkspaceName}</strong>
                  </button>
                  <span className="workspace-row-actions">
                    <button
                      aria-label={copy.newThread}
                      title={copy.newThread}
                      type="button"
                      onClick={() => onNewThread(cwd)}
                    >
                      <SquarePen aria-hidden="true" />
                    </button>
                    <button
                      aria-label={copy.removeWorkspace(currentWorkspaceName)}
                      className="workspace-remove-action"
                      title={copy.removeWorkspace(currentWorkspaceName)}
                      type="button"
                      onClick={() => setPendingRemoval(cwd)}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </span>
                </div>
                <div
                  className="conversation-list recent-thread-list"
                  hidden={currentWorkspaceCollapsed}
                  id="current-workspace-thread-list"
                >
                  {currentWorkspaceThreads.length > 0 ? (
                    renderThreadItems({
                      threads: currentWorkspaceThreads,
                      workspaceLabel: currentWorkspaceName,
                      workspaceKey: `legacy:${cwd}`,
                    })
                  ) : (
                    <p className="sidebar-empty-hint">
                      {copy.workspaceThreadsEmpty}
                    </p>
                  )}
                </div>
              </div>
            ) : standaloneThreads.length === 0 &&
              otherWorkspaceGroups.length === 0 ? (
              <p className="sidebar-empty-hint workspace-empty-hint">
                {copy.workspaceEmpty}
              </p>
            ) : null}
            {otherWorkspaceGroups.map((group, index) => {
              const name = workspaceName(group.path);
              return (
                <div
                  className="space-node real-workspace-node"
                  key={group.path}
                >
                  <div className="space-title real-workspace-title">
                    <button
                      aria-controls={`other-workspace-thread-list-${index}`}
                      aria-label={copy.switchWorkspace(name)}
                      className="workspace-title-toggle"
                      type="button"
                      onClick={() => onCreateWorkspace?.(group.path)}
                    >
                      <Folder aria-hidden="true" />
                      <strong>{name}</strong>
                    </button>
                    <span className="workspace-row-actions">
                      <button
                        aria-label={copy.threadInWorkspace(name)}
                        title={copy.threadInWorkspace(name)}
                        type="button"
                        onClick={() => onNewThread(group.path)}
                      >
                        <SquarePen aria-hidden="true" />
                      </button>
                      <button
                        aria-label={copy.removeWorkspace(name)}
                        className="workspace-remove-action"
                        title={copy.removeWorkspace(name)}
                        type="button"
                        onClick={() => setPendingRemoval(group.path)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                  <div
                    className="conversation-list recent-thread-list"
                    id={`other-workspace-thread-list-${index}`}
                  >
                    {renderThreadItems({
                      threads: group.threads,
                      workspaceLabel: name,
                      workspaceKey: `legacy:${group.path}`,
                    })}
                  </div>
                </div>
              );
            })}
            {standaloneThreads.length > 0 ? (
              <div
                className={classNames(
                  "space-node standalone-workspace-node",
                  standaloneWorkspaceCollapsed && "collapsed",
                )}
              >
                <div className="space-title standalone-workspace-title">
                  <button
                    aria-controls="standalone-workspace-thread-list"
                    aria-expanded={!standaloneWorkspaceCollapsed}
                    className="workspace-title-toggle standalone-workspace-toggle"
                    type="button"
                    onClick={() => toggleWorkspaceGroup("standalone")}
                  >
                    <ChevronRight aria-hidden="true" />
                    <strong>{copy.noWorkspace}</strong>
                  </button>
                  <span className="workspace-row-actions">
                    <button
                      aria-label={copy.newStandaloneThread}
                      type="button"
                      onClick={() => onNewThread(null)}
                    >
                      <SquarePen aria-hidden="true" />
                    </button>
                  </span>
                </div>
                <div
                  className="conversation-list recent-thread-list standalone-thread-list"
                  hidden={standaloneWorkspaceCollapsed}
                  id="standalone-workspace-thread-list"
                >
                  {renderThreadItems({
                    threads: standaloneThreads,
                    workspaceLabel: copy.noWorkspace,
                    workspaceKey: "legacy:standalone",
                  })}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      {workspaceAuthority === "legacy" && pendingRemoval ? (
        <WorkspaceRemoveDialog
          cancelLabel={copy.cancel}
          confirmLabel={copy.remove}
          hint={copy.removeWorkspaceHint}
          path={pendingRemoval}
          title={copy.removeWorkspaceTitle(workspaceName(pendingRemoval))}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => {
            removeWorkspace(pendingRemoval);
            setPendingRemoval(null);
          }}
        />
      ) : null}
    </TooltipProvider>
  );
}

/**
 * Removal is not undoable, so it asks first and states what is *not* affected.
 * Users read "remove workspace" as "delete my folder", and the sidebar has no
 * way to walk that back.
 */
function WorkspaceRemoveDialog({
  cancelLabel,
  confirmLabel,
  hint,
  path,
  title,
  onCancel,
  onConfirm,
}: {
  cancelLabel: string;
  confirmLabel: string;
  hint: string;
  path: string;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="workspace-remove-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        aria-labelledby="workspace-remove-title"
        aria-modal="true"
        className="workspace-remove-dialog"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onCancel();
          }
        }}
      >
        <strong id="workspace-remove-title">{title}</strong>
        <code title={path}>{path}</code>
        <p>{hint}</p>
        <footer>
          <button autoFocus type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="danger" type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
