import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

/** Server-owned association. The active native folder never supplies a fallback. */
export type ControlWorkspaceThread = Thread & { workspaceId: string | null };

export function controlThreadWorkspaceId(
  thread: Thread | null | undefined,
): string | null {
  if (!thread || !("workspaceId" in thread)) return null;
  return typeof thread.workspaceId === "string" && thread.workspaceId.length > 0
    ? thread.workspaceId
    : null;
}
