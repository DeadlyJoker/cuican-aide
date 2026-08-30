/**
 * The explicit list of workspaces the sidebar offers.
 *
 * Workspaces used to exist only as a by-product of conversation grouping: a
 * folder appeared in the tree because some thread happened to carry it as its
 * `cwd`. That left no object to remove, which is why the sidebar had no delete
 * affordance -- there was nothing a delete could act on. This module owns the
 * roster instead, so adding and removing a workspace are ordinary operations on
 * a list.
 *
 * Removal is deliberately about the roster only. Threads are not touched: a
 * conversation's `cwd` is part of its own history, and rewriting it to make a
 * folder disappear would edit records the user never asked to change.
 */

export type WorkspaceRosterEntry = {
  /** Absolute folder path. Doubles as the identity of the entry. */
  path: string;
  /** Unix milliseconds, used to keep the most recently used folder first. */
  usedAt: number;
};

/** Ceiling on remembered folders, so the list cannot grow without bound. */
const MAX_ENTRIES = 64;

function storageKey(accountId: string | null): string {
  return `crewon:workspace-roster:${accountId ?? "anonymous"}`;
}

/**
 * Trailing separators and surrounding blanks are cosmetic, but they split one
 * folder into two entries that no longer compare equal, which is what made a
 * removed workspace reappear under a slightly different spelling.
 */
export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  return withoutTrailing || trimmed.slice(0, 1);
}

export function readWorkspaceRoster(
  accountId: string | null,
): WorkspaceRosterEntry[] {
  if (typeof localStorage === "undefined") {
    return [];
  }
  try {
    const raw = localStorage.getItem(storageKey(accountId));
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return sortRoster(parsed.flatMap(toEntry));
  } catch {
    // A corrupt or unreadable roster is not worth failing the sidebar over; an
    // empty list rebuilds itself as folders are opened.
    return [];
  }
}

export function writeWorkspaceRoster(
  accountId: string | null,
  entries: WorkspaceRosterEntry[],
): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(
      storageKey(accountId),
      JSON.stringify(entries.slice(0, MAX_ENTRIES)),
    );
  } catch {
    // Quota or private-mode failures must not break workspace switching.
  }
}

/**
 * Records a folder as used, moving an existing entry to the front rather than
 * duplicating it.
 */
export function rememberWorkspace(
  entries: WorkspaceRosterEntry[],
  path: string,
  usedAt: number,
): WorkspaceRosterEntry[] {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) {
    return entries;
  }
  const others = entries.filter((entry) => entry.path !== normalized);
  return sortRoster([{ path: normalized, usedAt }, ...others]).slice(
    0,
    MAX_ENTRIES,
  );
}

/** Drops a folder from the roster. Threads keep their own `cwd`. */
export function forgetWorkspace(
  entries: WorkspaceRosterEntry[],
  path: string,
): WorkspaceRosterEntry[] {
  const normalized = normalizeWorkspacePath(path);
  return entries.filter((entry) => entry.path !== normalized);
}

/**
 * The folder to fall back to after removing the active one, or null when the
 * roster is empty and the next conversation should be workspace-less.
 */
export function nextActiveWorkspace(
  entries: WorkspaceRosterEntry[],
  removedPath: string,
): string | null {
  const remaining = forgetWorkspace(entries, removedPath);
  return remaining[0]?.path ?? null;
}

/**
 * Merges the roster with folders that only conversations know about.
 *
 * Threads created before the roster existed, or on another machine, still carry
 * a `cwd`. Hiding those folders would make old conversations unreachable from
 * the tree, so they are adopted into the list rather than ignored.
 */
export function mergeWorkspaceRoster(
  entries: WorkspaceRosterEntry[],
  threadPaths: Array<string | null | undefined>,
  fallbackUsedAt: number,
): WorkspaceRosterEntry[] {
  let merged = entries;
  for (const threadPath of threadPaths) {
    const normalized = normalizeWorkspacePath(threadPath ?? "");
    if (!normalized || merged.some((entry) => entry.path === normalized)) {
      continue;
    }
    merged = [...merged, { path: normalized, usedAt: fallbackUsedAt }];
  }
  return sortRoster(merged).slice(0, MAX_ENTRIES);
}

function sortRoster(entries: WorkspaceRosterEntry[]): WorkspaceRosterEntry[] {
  return [...entries].sort((left, right) => right.usedAt - left.usedAt);
}

function toEntry(value: unknown): WorkspaceRosterEntry[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const candidate = value as Partial<WorkspaceRosterEntry>;
  const path = normalizeWorkspacePath(
    typeof candidate.path === "string" ? candidate.path : "",
  );
  if (!path) {
    return [];
  }
  return [
    {
      path,
      usedAt: typeof candidate.usedAt === "number" ? candidate.usedAt : 0,
    },
  ];
}
