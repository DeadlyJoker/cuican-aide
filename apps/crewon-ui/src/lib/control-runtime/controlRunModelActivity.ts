import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";

/** Renderer-only activity, derived from durable Run events; never an execution status. */
export type ControlRunModelActivity = "waiting" | "retrying";
type ActivityTurn = Turn & { controlModelActivity?: ControlRunModelActivity };

export function controlRunModelActivity(
  turn: Turn | null,
): ControlRunModelActivity | null {
  return turn?.status === "inProgress"
    ? ((turn as ActivityTurn).controlModelActivity ?? null)
    : null;
}

export function updateControlRunModelActivity(
  thread: Thread,
  runId: string,
  activity: ControlRunModelActivity | null,
): Thread {
  let changed = false;
  const turns = thread.turns.map((turn): Turn => {
    if (turn.id !== runId) return turn;
    const next = turn.status === "inProgress" ? activity : null;
    if (((turn as ActivityTurn).controlModelActivity ?? null) === next)
      return turn;
    changed = true;
    const { controlModelActivity: _prior, ...base } = turn as ActivityTurn;
    return next
      ? ({ ...base, controlModelActivity: next } as ActivityTurn)
      : base;
  });
  return changed ? { ...thread, turns } : thread;
}

/** An in-flight detail read cannot erase activity received through the live stream. */
export function preserveControlRunModelActivities(
  current: Thread | undefined,
  incoming: Thread,
): Thread {
  if (!current) return incoming;
  let result = incoming;
  for (const turn of current.turns) {
    const activity = controlRunModelActivity(turn);
    if (activity)
      result = updateControlRunModelActivity(result, turn.id, activity);
  }
  return result;
}
