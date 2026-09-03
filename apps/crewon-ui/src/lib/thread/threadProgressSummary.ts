import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { RunPlanView } from "@crewon/contracts";

/** `current` is a one-based item position, while `completed` is a count. */
export type ThreadPlanProgress = {
  completed: number;
  current: number;
  total: number;
};

export type ThreadFileChangeProgress = {
  files: number;
};

export type ThreadProgressSummary = {
  fileChanges: ThreadFileChangeProgress | null;
  hasProposedPlan: boolean;
  plan: ThreadPlanProgress | null;
  runPlan: RunPlanView | null;
  runId: string | null;
};

export type ThreadProgressScope = Readonly<{
  runId?: string | null;
  runPlan?: RunPlanView | null;
}>;

function proposedPlanItem(
  turn: Turn,
): Extract<ThreadItem, { type: "plan" }> | null {
  for (const item of [...turn.items].reverse()) {
    if (item.type === "plan") return item;
  }
  return null;
}

/**
 * Files are counted by unique path inside exactly one Run/Turn. Operation diffs
 * do not provide a trustworthy net added/removed line count.
 */
function fileChangeProgress(turn: Turn): ThreadFileChangeProgress | null {
  const paths = new Set<string>();
  for (const item of turn.items) {
    if (item.type !== "fileChange") continue;
    const status = item.status as unknown;
    const statusValue =
      typeof status === "string"
        ? status
        : typeof status === "object" &&
            status !== null &&
            "type" in status &&
            typeof status.type === "string"
          ? status.type
          : null;
    if (statusValue === "failed" || statusValue === "declined") continue;
    for (const change of item.changes) paths.add(change.path);
  }
  return paths.size === 0 ? null : { files: paths.size };
}

export function runPlanProgress(plan: RunPlanView): ThreadPlanProgress {
  const inProgressIndex = plan.items.findIndex(
    (item) => item.status === "inProgress",
  );
  const nextActionableIndex = plan.items.findIndex(
    (item) => item.status !== "completed" && item.status !== "canceled",
  );
  const currentIndex =
    inProgressIndex >= 0
      ? inProgressIndex
      : nextActionableIndex >= 0
        ? nextActionableIndex
        : plan.items.length - 1;
  return {
    completed: plan.items.filter((item) => item.status === "completed").length,
    current: Math.max(1, currentIndex + 1),
    total: plan.items.length,
  };
}

export function threadProgressSummary(
  thread: Thread | null,
  scope: ThreadProgressScope = {},
): ThreadProgressSummary {
  const empty = {
    fileChanges: null,
    hasProposedPlan: false,
    plan: null,
    runPlan: null,
    runId: null,
  } satisfies ThreadProgressSummary;
  if (!thread) return empty;

  const runId =
    "runId" in scope
      ? (scope.runId ?? null)
      : (thread.turns.at(-1)?.id ?? null);
  if (runId === null) return empty;
  const turn = thread.turns.find((candidate) => candidate.id === runId);
  if (!turn) {
    // An active Run may not be present in the durable Thread projection yet.
    // Never fall back to the preceding Turn or its ProposedPlan/file changes.
    return { ...empty, runId };
  }

  const runPlan = scope.runPlan ?? null;
  const proposedPlan = proposedPlanItem(turn);
  return {
    fileChanges: fileChangeProgress(turn),
    hasProposedPlan: proposedPlan !== null,
    plan: runPlan ? runPlanProgress(runPlan) : null,
    runPlan,
    runId,
  };
}

export function hasThreadProgress(summary: ThreadProgressSummary): boolean {
  return Boolean(
    summary.runPlan ||
      summary.hasProposedPlan ||
      summary.plan ||
      summary.fileChanges,
  );
}
