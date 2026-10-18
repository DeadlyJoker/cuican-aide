import type { ControlApiClient } from "@crewon/control-client";
import {
  formatThreadMessageWindowCursor,
  parseThreadMessageWindowQuery,
} from "@crewon/contracts";

/** The selected page is independent of the authoritative active Run. */
export async function readControlTranscript(input: {
  client: ControlApiClient;
  threadId: string;
  threadRevision?: number;
  cursor: string | null;
  signal: AbortSignal | undefined;
}) {
  const { client, threadId, signal } = input;
  const cursor =
    input.cursor === null
      ? null
      : (() => {
          if (input.threadRevision === undefined)
            throw new Error("control_thread_cursor_revision_required");
          return formatThreadMessageWindowCursor(threadId, {
            ...parseThreadMessageWindowQuery({ cursor: input.cursor }, threadId)
              .position!,
            threadRevision: input.threadRevision,
          });
        })();
  const snapshot = await client.getThreadTranscriptSnapshot(
    threadId,
    { ...(cursor ? { cursor } : {}), limit: 50 },
    signal ? { signal } : {},
  );
  signal?.throwIfAborted();
  const window = snapshot.transcriptWindow;
  if (
    input.threadRevision !== undefined &&
    window.messageWindow.threadRevision !== input.threadRevision
  )
    throw new Error("control_thread_projection_snapshot_changed");
  const activeRun =
    snapshot.activeRunId === null
      ? null
      : (snapshot.runs.find((run) => run.runId === snapshot.activeRunId) ??
        null);
  // Message sequence defines chronology even when timestamps collide or an
  // older Run receives a late update. Async response order must not pick Plan.
  const messageOrder = new Map(
    window.runBindings.flatMap((binding, index) =>
      binding.runId === null ? [] : [[binding.runId, index] as const],
    ),
  );
  return {
    window,
    cursor,
    activeRun,
    runs: [...snapshot.runs].sort(
      (a, b) =>
        (messageOrder.get(b.runId) ?? -1) - (messageOrder.get(a.runId) ?? -1),
    ),
  };
}
