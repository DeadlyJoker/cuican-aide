import {
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { FormEvent } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandSidebarThreadRow } from "./CommandSidebarThreadRow";
import type {
  CommandControlWorkspaceNav,
  CommandLinkedThread,
  CommandWorkspaceAuthority,
} from "./CommandWorkspaceChrome";
import { classNames } from "./commandWorkspaceUtils";

type Copy = {
  addWorkspace: string;
  cancel: string;
  chooseFolder: string;
  controlWorkspaceEmpty: string;
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
  const renderThreadItems = (
    threads: CommandLinkedThread[],
    workspaceLabel: string,
  ) =>
    threads.map((thread) => (
      <CommandSidebarThreadRow
        key={thread.id}
        onOpen={onOpenLinkedThread}
        selected={selectedLinkedThreadId === thread.id}
        thread={thread}
        workspaceLabel={workspaceLabel}
      />
    ));
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
                  aria-label={
                    controlWorkspace.name
                      ? copy.replaceWorkspace
                      : copy.selectWorkspace
                  }
                  className="tree-head-action"
                  disabled={controlWorkspace.busy}
                  title={
                    controlWorkspace.name
                      ? copy.replaceWorkspace
                      : copy.selectWorkspace
                  }
                  type="button"
                  onClick={() => controlWorkspace.onSelect?.()}
                >
                  <Plus aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {controlWorkspace?.name ? (
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
                    onClick={() => toggleWorkspaceGroup("current")}
                  >
                    {currentWorkspaceCollapsed ? (
                      <Folder aria-hidden="true" />
                    ) : (
                      <FolderOpen aria-hidden="true" />
                    )}
                    <strong>{controlWorkspace.name}</strong>
                  </button>
                  <span className="workspace-row-actions">
                    <button
                      aria-label={copy.newThread}
                      title={copy.newThread}
                      type="button"
                      onClick={() => onNewThread(null)}
                    >
                      <SquarePen aria-hidden="true" />
                    </button>
                    {controlWorkspace.onClear ? (
                      <button
                        aria-label={copy.unbindWorkspace(controlWorkspace.name)}
                        className="workspace-remove-action"
                        disabled={controlWorkspace.busy}
                        title={copy.unbindWorkspace(controlWorkspace.name)}
                        type="button"
                        onClick={() => controlWorkspace.onClear?.()}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    ) : null}
                  </span>
                </div>
                <div
                  className="conversation-list recent-thread-list"
                  hidden={currentWorkspaceCollapsed}
                  id="current-workspace-thread-list"
                >
                  {linkedThreads.length > 0 ? (
                    renderThreadItems(linkedThreads, controlWorkspace.name)
                  ) : (
                    <p className="sidebar-empty-hint">
                      {copy.workspaceThreadsEmpty}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <>
                <p className="sidebar-empty-hint workspace-empty-hint">
                  {copy.controlWorkspaceEmpty}
                </p>
                {linkedThreads.length > 0 ? (
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
                      {renderThreadItems(linkedThreads, copy.noWorkspace)}
                    </div>
                  </div>
                ) : null}
              </>
            )}
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
                    renderThreadItems(
                      currentWorkspaceThreads,
                      currentWorkspaceName,
                    )
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
                    {renderThreadItems(group.threads, name)}
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
                  {renderThreadItems(standaloneThreads, copy.noWorkspace)}
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
