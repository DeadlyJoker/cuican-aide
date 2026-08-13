import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { ThreadItem } from "@crewon-ui-model/v2/ThreadItem";

/**
 * Step progress derived from the latest plan item of a thread. `current` is the
 * step the agent is working on, so a finished plan reports `current === total`.
 */
export type ThreadPlanProgress = {
  completed: number;
  current: number;
  total: number;
};

export type ThreadFileChangeProgress = {
  added: number;
  files: number;
  removed: number;
};

export type ThreadProgressSummary = {
  fileChanges: ThreadFileChangeProgress | null;
  hasProposedPlan: boolean;
  plan: ThreadPlanProgress | null;
};

const PLAN_STEP_PATTERN = /^\s*-\s*\[([A-Za-z]+)\]\s*(.+)$/;

/**
 * Step counts are read only from the authoritative durable Plan item projected
 * by Control. Ordinary assistant text is never considered Plan progress.
 */
export function parsePlanProgress(text: string): ThreadPlanProgress | null {
  const statuses = text
    .split("\n")
    .map((line) => PLAN_STEP_PATTERN.exec(line)?.[1]?.toLowerCase())
    .filter((status): status is string => Boolean(status));

  if (statuses.length === 0) {
    return null;
  }

  const completed = statuses.filter((status) => status === "completed").length;
  const inProgress = statuses.some((status) => status === "inprogress");
  return {
    completed,
    current: Math.min(completed + (inProgress ? 1 : 0), statuses.length),
    total: statuses.length,
  };
}

function latestPlanItem(
  thread: Thread,
): Extract<ThreadItem, { type: "plan" }> | null {
  for (const turn of [...thread.turns].reverse()) {
    for (const item of [...turn.items].reverse()) {
      if (item.type === "plan") {
        return item;
      }
    }
  }
  return null;
}

function diffStats(diff: string): { added: number; removed: number } {
  return diff.split("\n").reduce(
    (stats, line) => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return stats;
      }
      if (line.startsWith("+")) {
        return { added: stats.added + 1, removed: stats.removed };
      }
      if (line.startsWith("-")) {
        return { added: stats.added, removed: stats.removed + 1 };
      }
      return stats;
    },
    { added: 0, removed: 0 },
  );
}

/**
 * Files are counted by unique path so repeated edits to the same file read as
 * one changed file, matching how the diff review surface counts them.
 */
function fileChangeProgress(thread: Thread): ThreadFileChangeProgress | null {
  const paths = new Set<string>();
  let added = 0;
  let removed = 0;

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type !== "fileChange") {
        continue;
      }
      for (const change of item.changes) {
        paths.add(change.path);
        const stats = diffStats(change.diff);
        added += stats.added;
        removed += stats.removed;
      }
    }
  }

  return paths.size === 0 ? null : { added, files: paths.size, removed };
}

export function threadProgressSummary(
  thread: Thread | null,
): ThreadProgressSummary {
  if (!thread) {
    return { fileChanges: null, hasProposedPlan: false, plan: null };
  }
  const planItem = latestPlanItem(thread);
  return {
    fileChanges: fileChangeProgress(thread),
    hasProposedPlan: planItem !== null,
    plan: planItem ? parsePlanProgress(planItem.text) : null,
  };
}

export function hasThreadProgress(summary: ThreadProgressSummary): boolean {
  return Boolean(
    summary.hasProposedPlan || summary.plan || summary.fileChanges,
  );
}
