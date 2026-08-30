import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";

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
  files: number;
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

/**
 * Files are counted by unique path so repeated edits to the same file read as
 * one changed file. File update items describe editing operations rather than
 * a repository diff, so they cannot truthfully report net added/removed lines.
 */
function fileChangeProgress(thread: Thread): ThreadFileChangeProgress | null {
  const paths = new Set<string>();

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type !== "fileChange") {
        continue;
      }
      for (const change of item.changes) {
        paths.add(change.path);
      }
    }
  }

  return paths.size === 0 ? null : { files: paths.size };
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
