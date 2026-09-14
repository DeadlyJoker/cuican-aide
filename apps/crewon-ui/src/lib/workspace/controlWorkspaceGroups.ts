export function groupControlWorkspaceThreads<
  T extends { id: string; workspaceId?: string | null },
>(
  workspaces: readonly { workspaceId: string; displayName: string }[],
  threads: readonly T[],
) {
  const groups = new Map<
    string,
    { workspaceId: string; displayName: string | null; threads: T[] }
  >();
  for (const workspace of workspaces) {
    if (!groups.has(workspace.workspaceId))
      groups.set(workspace.workspaceId, { ...workspace, threads: [] });
  }
  const unbound: T[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    if (!thread.workspaceId) {
      unbound.push(thread);
      continue;
    }
    let group = groups.get(thread.workspaceId);
    if (!group) {
      group = {
        workspaceId: thread.workspaceId,
        displayName: null,
        threads: [],
      };
      groups.set(thread.workspaceId, group);
    }
    group.threads.push(thread);
  }
  return { groups: [...groups.values()], unbound };
}
