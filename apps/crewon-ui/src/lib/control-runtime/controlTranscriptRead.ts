import type { ControlApiClient } from "@crewon/control-client";
import {
  formatThreadMessageWindowCursor,
  parseThreadMessageWindowQuery,
  type RunView,
} from "@crewon/contracts";

/** The selected page is independent of the authoritative active Run. */
export async function readControlTranscript(input: {
  client: ControlApiClient;
  threadId: string;
  threadRevision: number;
  cursor: string | null;
  signal: AbortSignal | undefined;
}) {
  const { client, threadId, signal } = input;
  const cursor =
    input.cursor === null
      ? null
      : formatThreadMessageWindowCursor(threadId, {
          ...parseThreadMessageWindowQuery({ cursor: input.cursor }, threadId)
            .position!,
          threadRevision: input.threadRevision,
        });
  const [window, active] = await Promise.all([
    client.getThreadTranscriptWindow(
      threadId,
      { ...(cursor ? { cursor } : {}), limit: 50 },
      signal ? { signal } : {},
    ),
    client.getThreadActiveRun(threadId, signal ? { signal } : {}),
  ]);
  signal?.throwIfAborted();
  if (window.messageWindow.threadRevision !== input.threadRevision)
    throw new Error("control_thread_projection_snapshot_changed");
  const activeRun = active.run;
  const runs = new Map<string, RunView>();
  if (activeRun) runs.set(activeRun.runId, activeRun);
  const ids = [
    ...new Set(
      window.runBindings.flatMap((binding) =>
        binding.runId === null ? [] : [binding.runId],
      ),
    ),
  ].filter((id) => id !== activeRun?.runId);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (next < ids.length) {
        signal?.throwIfAborted();
        const runId = ids[next++]!;
        const { run } = await client.getRunInThread(
          threadId,
          runId,
          signal ? { signal } : {},
        );
        signal?.throwIfAborted();
        if (run.runId !== runId || run.threadId !== threadId)
          throw new Error("control_transcript_run_identity_invalid");
        runs.set(runId, run);
      }
    }),
  );
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
    runs: [...runs.values()].sort(
      (a, b) =>
        (messageOrder.get(b.runId) ?? -1) - (messageOrder.get(a.runId) ?? -1),
    ),
  };
}
