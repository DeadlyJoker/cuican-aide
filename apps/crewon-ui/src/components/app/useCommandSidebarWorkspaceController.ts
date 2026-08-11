import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { CommandLinkedThread, CommandWorkspaceAuthority } from "./CommandWorkspaceChrome";
import { commandSidebarHasFolderPicker, pickCommandSidebarWorkspaceFolder, readCommandSidebarWorkspaceRoster, writeCommandSidebarWorkspaceRoster } from "./CommandWorkspaceChrome";
import { forgetWorkspace, mergeWorkspaceRoster, nextActiveWorkspace, normalizeWorkspacePath, rememberWorkspace, type WorkspaceRosterEntry } from "../../lib/workspace/workspaceRoster";

function workspaceName(path: string, emptyLabel = "工作空间"): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() || normalized || emptyLabel;
}

export function useCommandSidebarWorkspaceController({ accountId, addWorkspaceLabel, cwd, linkedThreads, noWorkspaceLabel, onCreateWorkspace, workspaceAuthority }: { accountId: string | null; addWorkspaceLabel: string; cwd: string; linkedThreads: CommandLinkedThread[]; noWorkspaceLabel: string; onCreateWorkspace?: (cwd: string) => void; workspaceAuthority: CommandWorkspaceAuthority }) {
  const [workspaceFormOpen, setWorkspaceFormOpen] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState(
    workspaceAuthority === "legacy" ? cwd : "",
  );
  /*
   * A native dialog is the only way to learn an absolute folder path, so where
   * one exists the `+` button is the picker and the typed-path form never
   * appears. The form stays for web, where no such dialog exists.
   */
  const nativeFolderPicker = commandSidebarHasFolderPicker(workspaceAuthority);
  const [pickerBusy, setPickerBusy] = useState(false);
  const workspaceFormRef = useRef<HTMLDivElement>(null);
  const [collapsedWorkspaceGroups, setCollapsedWorkspaceGroups] = useState<
    Set<string>
  >(() => new Set());
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [storedWorkspaces, setStoredWorkspaces] = useState<
    WorkspaceRosterEntry[]
  >(() => readCommandSidebarWorkspaceRoster(workspaceAuthority, accountId));
  const [removedWorkspaces, setRemovedWorkspaces] = useState<Set<string>>(
    () => new Set(),
  );
  /*
   * The roster is per account, so switching users must not inherit the previous
   * one's folders or their removals.
   */
  useEffect(() => {
    setStoredWorkspaces(
      readCommandSidebarWorkspaceRoster(workspaceAuthority, accountId),
    );
    setRemovedWorkspaces(new Set());
  }, [accountId, workspaceAuthority]);
  /*
   * Derived during render rather than in an effect: a folder that only its
   * conversations know about has to be in the very first frame, or the tree
   * renders without it and pops it in afterwards. The effect below only
   * persists the result.
   *
   * `removedWorkspaces` is applied last so a folder the user just removed does
   * not come straight back via one of its own conversations.
   */
  const workspaces =
    workspaceAuthority === "legacy"
      ? mergeWorkspaceRoster(
          cwd
            ? rememberWorkspace(storedWorkspaces, cwd, Date.now())
            : storedWorkspaces,
          linkedThreads.map((thread) => thread.cwd),
          0,
        ).filter((entry) => !removedWorkspaces.has(entry.path))
      : [];
  const workspacePathsKey = workspaces
    .map((entry) => entry.path)
    .join("\u0000");
  useEffect(() => {
    writeCommandSidebarWorkspaceRoster(
      workspaceAuthority,
      accountId,
      workspaces,
    );
    // Keyed on the paths rather than the array so a re-render with the same
    // folders does not rewrite storage on every pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, workspaceAuthority, workspacePathsKey]);

  function removeWorkspace(path: string) {
    if (workspaceAuthority !== "legacy") {
      return;
    }
    const normalized = normalizeWorkspacePath(path);
    setRemovedWorkspaces((current) => new Set(current).add(normalized));
    const remaining = forgetWorkspace(workspaces, path);
    setStoredWorkspaces(remaining);
    writeCommandSidebarWorkspaceRoster(
      workspaceAuthority,
      accountId,
      remaining,
    );
    // Removing the folder the shell is currently pointed at has to move it
    // somewhere, or the tree would keep showing it as the active workspace.
    if (normalizeWorkspacePath(path) === normalizeWorkspacePath(cwd)) {
      onCreateWorkspace?.(nextActiveWorkspace(workspaces, path) ?? "");
    }
  }

  const currentWorkspaceName =
    workspaceAuthority === "legacy"
      ? workspaceName(cwd, noWorkspaceLabel)
      : noWorkspaceLabel;
  const currentWorkspaceThreads =
    workspaceAuthority === "legacy"
      ? linkedThreads
          .filter((thread) => Boolean(cwd) && thread.cwd === cwd)
          .slice(0, 5)
      : [];
  const standaloneThreads =
    workspaceAuthority === "legacy"
      ? linkedThreads.filter((thread) => !thread.cwd).slice(0, 5)
      : [];
  /*
   * Driven by the roster rather than by conversation grouping: a folder the user
   * opened but has not used yet still belongs in the tree, and a folder they
   * removed must stay out of it even while its old conversations exist.
   */
  const threadsByWorkspace =
    workspaceAuthority === "legacy"
      ? linkedThreads.reduce((groups, thread) => {
          const threadCwd = normalizeWorkspacePath(thread.cwd ?? "");
          if (!threadCwd) {
            return groups;
          }
          groups.set(threadCwd, [...(groups.get(threadCwd) ?? []), thread]);
          return groups;
        }, new Map<string, CommandLinkedThread[]>())
      : new Map<string, CommandLinkedThread[]>();
  const otherWorkspaceGroups = workspaces
    .map((entry) => entry.path)
    .filter((path) => path !== normalizeWorkspacePath(cwd))
    .slice(0, 8)
    .map((path) => ({
      path,
      threads: (threadsByWorkspace.get(path) ?? []).slice(0, 5),
    }));

  useEffect(() => {
    setWorkspaceDraft(workspaceAuthority === "legacy" ? cwd : "");
  }, [cwd, workspaceAuthority]);

  function submitWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (workspaceAuthority !== "legacy") {
      return;
    }
    const trimmed = workspaceDraft.trim();
    if (!trimmed) {
      return;
    }
    onCreateWorkspace?.(trimmed);
    setWorkspaceFormOpen(false);
  }

  async function chooseWorkspaceFolder() {
    // Guards a second dialog while one is already open: the OS keeps the first
    // modal and the extra request resolves as a cancellation.
    if (pickerBusy) {
      return;
    }
    setPickerBusy(true);
    try {
      const picked = await pickCommandSidebarWorkspaceFolder(
        workspaceAuthority,
        addWorkspaceLabel,
      );
      if (!picked) {
        return;
      }
      onCreateWorkspace?.(normalizeWorkspacePath(picked));
    } finally {
      setPickerBusy(false);
    }
  }

  function toggleWorkspaceGroup(groupId: string) {
    setCollapsedWorkspaceGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  const currentWorkspaceCollapsed =
    workspaceAuthority === "legacy" &&
    Boolean(cwd) &&
    collapsedWorkspaceGroups.has(cwd);
  const standaloneWorkspaceCollapsed =
    collapsedWorkspaceGroups.has("standalone");
  return { workspaceFormOpen, setWorkspaceFormOpen, workspaceDraft, setWorkspaceDraft, nativeFolderPicker, pickerBusy, workspaceFormRef, pendingRemoval, setPendingRemoval, workspaces, removeWorkspace, currentWorkspaceName, currentWorkspaceThreads, standaloneThreads, otherWorkspaceGroups, submitWorkspace, chooseWorkspaceFolder, toggleWorkspaceGroup, currentWorkspaceCollapsed, standaloneWorkspaceCollapsed };
}
