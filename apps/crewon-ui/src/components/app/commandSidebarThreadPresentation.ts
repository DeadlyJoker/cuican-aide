import { useEffect, useState } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { Locale } from "../../lib/i18n";

const sidebarSeenUpdatesStorageKey = "crewon:sidebar-thread-seen-updates:v1";
const maxStoredThreadCount = 256;

export type CommandSidebarThreadState =
  | "running"
  | "pendingUnread"
  | "pendingViewed"
  | "completedUnread"
  | "completedViewed"
  | "failed"
  | "neutral";

export type CommandSidebarThreadScope = "personal" | "team";

type SeenThreadUpdates = Record<string, number>;

function isSeenThreadUpdates(value: unknown): value is SeenThreadUpdates {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.entries(value).every(
      ([threadId, updatedAt]) =>
        threadId.length > 0 &&
        threadId.length <= 512 &&
        typeof updatedAt === "number" &&
        Number.isFinite(updatedAt) &&
        updatedAt >= 0,
    )
  );
}

function readSeenThreadUpdates(): SeenThreadUpdates | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    const saved = window.localStorage.getItem(sidebarSeenUpdatesStorageKey);
    if (!saved) {
      return null;
    }
    const parsed: unknown = JSON.parse(saved);
    return isSeenThreadUpdates(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedSeenThreadUpdates(
  updates: SeenThreadUpdates,
): SeenThreadUpdates {
  return Object.fromEntries(
    Object.entries(updates)
      .sort(([, left], [, right]) => right - left)
      .slice(0, maxStoredThreadCount),
  );
}

function writeSeenThreadUpdates(updates: SeenThreadUpdates): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        sidebarSeenUpdatesStorageKey,
        JSON.stringify(boundedSeenThreadUpdates(updates)),
      );
    }
  } catch {
    // Sidebar read state is optional; runtime state remains authoritative.
  }
}

function initialSeenThreadUpdates(
  threads: readonly Thread[],
): SeenThreadUpdates {
  return (
    readSeenThreadUpdates() ??
    Object.fromEntries(threads.map((thread) => [thread.id, thread.updatedAt]))
  );
}

export function useCommandSidebarSeenThreadUpdates(
  threads: readonly Thread[],
  selectedThreadId: string | null,
): SeenThreadUpdates {
  const [seenUpdates, setSeenUpdates] = useState<SeenThreadUpdates>(() =>
    initialSeenThreadUpdates(threads),
  );
  const selectedUpdatedAt =
    threads.find((thread) => thread.id === selectedThreadId)?.updatedAt ?? null;

  useEffect(() => {
    writeSeenThreadUpdates(seenUpdates);
  }, [seenUpdates]);

  useEffect(() => {
    if (selectedThreadId === null || selectedUpdatedAt === null) {
      return;
    }
    setSeenUpdates((current) => {
      if ((current[selectedThreadId] ?? 0) >= selectedUpdatedAt) {
        return current;
      }
      return boundedSeenThreadUpdates({
        ...current,
        [selectedThreadId]: selectedUpdatedAt,
      });
    });
  }, [selectedThreadId, selectedUpdatedAt]);

  return seenUpdates;
}

export function commandSidebarThreadState(
  thread: Thread,
  seenUpdatedAt: number,
): CommandSidebarThreadState {
  const status = thread.status ?? { type: "idle" as const };

  if (status.type === "systemError") {
    return "failed";
  }

  if (status.type === "active") {
    const waiting = status.activeFlags.some(
      (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
    );
    if (!waiting) {
      return "running";
    }
    return seenUpdatedAt >= thread.updatedAt
      ? "pendingViewed"
      : "pendingUnread";
  }

  const hasTaskContent = Boolean(
    thread.name?.trim() ||
      thread.preview?.trim() ||
      (thread.turns?.length ?? 0) > 0,
  );
  if (!hasTaskContent) {
    return "neutral";
  }

  return seenUpdatedAt >= thread.updatedAt
    ? "completedViewed"
    : "completedUnread";
}

export function commandSidebarThreadStateLabel(
  state: CommandSidebarThreadState,
  locale: Locale,
): string {
  const zh = locale === "zh";
  switch (state) {
    case "running":
      return zh ? "进行中" : "Running";
    case "pendingUnread":
      return zh ? "新的待确认" : "New confirmation needed";
    case "pendingViewed":
      return zh ? "已查看，仍待确认" : "Viewed, still needs confirmation";
    case "completedUnread":
      return zh ? "新完成，结果未查看" : "Completed, result not viewed";
    case "completedViewed":
      return zh ? "已完成" : "Completed";
    case "failed":
      return zh ? "执行遇到问题" : "Needs attention";
    case "neutral":
      return zh ? "最近更新" : "Recently updated";
  }
}

export function commandSidebarThreadScope(
  thread: Thread,
): CommandSidebarThreadScope {
  const sourceTitle = thread.name || thread.preview;
  return /^(?:CrewON Office Chat ·|💬\s)/u.test(sourceTitle)
    ? "team"
    : "personal";
}

export function commandSidebarThreadScopeLabel(
  scope: CommandSidebarThreadScope,
  locale: Locale,
): string {
  if (scope === "team") {
    return locale === "zh" ? "团队任务" : "Team task";
  }
  return locale === "zh" ? "个人任务" : "Personal task";
}

export function commandSidebarThreadNeedsAttention(
  state: CommandSidebarThreadState,
): boolean {
  return (
    state === "pendingUnread" ||
    state === "pendingViewed" ||
    state === "completedUnread" ||
    state === "failed"
  );
}
