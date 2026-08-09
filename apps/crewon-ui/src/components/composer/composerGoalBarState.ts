import type { ThreadGoalView } from "@crewon/contracts";

import type { Locale } from "../../lib/i18n";
import { isThreadGoalView } from "../../lib/thread/threadGoalComposerActions";

type ThreadGoalStatus = ThreadGoalView["status"];

export type ComposerGoalBarState = {
  elapsedLabel: string;
  objective: string;
  /** Only active and paused goals expose the pause/resume transition. */
  pauseToggleEnabled: boolean;
  /** True while the goal is actively steering turns, false otherwise. */
  running: boolean;
  statusLabel: string;
};

const STATUS_LABELS: Record<ThreadGoalStatus, { en: string; zh: string }> = {
  active: { en: "Active goal", zh: "进行中的目标" },
  blocked: { en: "Blocked goal", zh: "已阻塞的目标" },
  budgetLimited: { en: "Goal at budget limit", zh: "已达预算上限的目标" },
  complete: { en: "Completed goal", zh: "已完成的目标" },
  paused: { en: "Paused goal", zh: "已暂停的目标" },
  usageLimited: { en: "Goal at usage limit", zh: "已达用量上限的目标" },
};

/**
 * Elapsed time reads as `48m 33s` up to an hour and `2h 14m` beyond it, so the
 * bar never grows wide enough to push the goal text out of the row.
 */
export function formatGoalElapsed(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function composerGoalBarState(
  goal: ThreadGoalView | null,
  locale: Locale,
): ComposerGoalBarState | null {
  if (!isThreadGoalView(goal)) {
    return null;
  }
  const status = STATUS_LABELS[goal.status];
  return {
    elapsedLabel: formatGoalElapsed(goal.timeUsedSeconds),
    objective: goal.objective.trim(),
    pauseToggleEnabled: goal.status === "active" || goal.status === "paused",
    running: goal.status === "active",
    statusLabel: locale === "zh" ? status.zh : status.en,
  };
}

/**
 * Terminal or limited states are returned unchanged. This keeps legacy
 * callsites type-safe while ensuring they cannot turn those states active.
 */
export function goalPauseToggleStatus(
  status: ThreadGoalStatus,
): ThreadGoalStatus {
  if (status === "active") {
    return "paused";
  }
  if (status === "paused") {
    return "active";
  }
  return status;
}
