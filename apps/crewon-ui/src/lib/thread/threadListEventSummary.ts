import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";

export type ThreadListEventSummary = Readonly<{
  status: Thread["status"];
  latestTurn: Pick<Turn, "id" | "status" | "completedAt"> | null;
}>;

export type ThreadListSummary = Thread &
  Readonly<{
    workspaceId?: string | null;
    uiListEventSummary: ThreadListEventSummary;
  }>;

/** Keep known sidebar state while the transcript itself is explicitly unloaded. */
export function threadListEventSummary(thread: Thread): ThreadListEventSummary {
  const cached = (thread as Partial<ThreadListSummary>).uiListEventSummary;
  if (
    thread.status?.type === "notLoaded" &&
    (thread.turns?.length ?? 0) === 0 &&
    cached !== undefined
  )
    return cached;
  const latest = thread.turns?.at(-1);
  return {
    status: thread.status ?? { type: "idle" },
    latestTurn:
      latest === undefined
        ? null
        : {
            id: latest.id,
            status: latest.status,
            completedAt: latest.completedAt,
          },
  };
}
