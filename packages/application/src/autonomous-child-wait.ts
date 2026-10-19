import type { AutonomousTaskChildRecord } from "./team-task-journal.ts";
import { teamJournalFail, teamJournalId } from "./team-task-journal.ts";

const MAX_CHILD_WAIT_IDS = 32;
const DEFAULT_POLL_INTERVAL_MS = 100;

export type AutonomousChildSnapshotReader = (input?: {
  limit?: number;
}) => Promise<readonly AutonomousTaskChildRecord[]>;

/**
 * Waits for a bounded set of already-admitted children to settle. A durable
 * cancel request is terminal for observation; model/tool side effects remain
 * owned by the child scheduler and are never rolled back here.
 */
export async function waitForAutonomousChildren(input: {
  read: AutonomousChildSnapshotReader;
  childTaskIds: readonly string[];
  deadlineMs: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<readonly AutonomousTaskChildRecord[]> {
  const ids = [...input.childTaskIds];
  if (
    ids.length < 1 ||
    ids.length > MAX_CHILD_WAIT_IDS ||
    new Set(ids).size !== ids.length
  )
    teamJournalFail("autonomous_child_wait_ids_invalid");
  ids.forEach(teamJournalId);
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1)
    teamJournalFail("autonomous_child_wait_deadline_invalid");
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1)
    teamJournalFail("autonomous_child_wait_poll_invalid");
  const deadline = Date.now() + input.deadlineMs;
  while (true) {
    input.signal?.throwIfAborted();
    const snapshots = await input.read({ limit: MAX_CHILD_WAIT_IDS });
    input.signal?.throwIfAborted();
    const byId = new Map(
      snapshots.map((snapshot) => [snapshot.task.intent.taskId, snapshot]),
    );
    const selected = ids.map((id) => byId.get(id));
    if (
      selected.every(
        (snapshot) =>
          snapshot !== undefined &&
          (snapshot.task.status === "finalAccepted" ||
            snapshot.task.cancelRequested),
      )
    ) {
      return selected as AutonomousTaskChildRecord[];
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0)
      teamJournalFail("autonomous_child_wait_deadline_exceeded");
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const onAbort = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        reject(
          input.signal?.reason ?? new Error("autonomous_child_wait_cancelled"),
        );
      };
      timer = setTimeout(
        () => {
          input.signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.min(remainingMs, pollIntervalMs),
      );
      input.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
