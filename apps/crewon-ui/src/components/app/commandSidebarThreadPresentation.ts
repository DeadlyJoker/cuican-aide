import { useEffect, useState } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { threadListEventSummary } from "../../lib/thread/threadListEventSummary";

import type { Locale } from "../../lib/i18n";
import type { CommandShellView } from "./commandWorkspaceState";

const sidebarSeenEventsStorageKey = "crewon:sidebar-thread-seen-events:v2";
const legacySidebarSeenUpdatesStorageKey =
  "crewon:sidebar-thread-seen-updates:v1";
const maxStoredThreadCount = 256;

export type CommandSidebarThreadState =
  | "running"
  | "pendingUnread"
  | "pendingViewed"
  | "completedUnread"
  | "completedViewed"
  | "failedUnread"
  | "failedViewed"
  | "neutral";

export type CommandSidebarThreadScope = "personal" | "team";

export type CommandSidebarSeenThreadEvents = Record<string, string>;

type LegacySeenThreadUpdates = Record<string, number>;

function isSeenThreadEvents(
  value: unknown,
): value is CommandSidebarSeenThreadEvents {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.entries(value).every(
      ([threadId, fingerprint]) =>
        threadId.length > 0 &&
        threadId.length <= 512 &&
        typeof fingerprint === "string" &&
        fingerprint.length > 0 &&
        fingerprint.length <= 4096,
    )
  );
}

function isLegacySeenThreadUpdates(
  value: unknown,
): value is LegacySeenThreadUpdates {
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

function readSeenThreadEvents(): CommandSidebarSeenThreadEvents | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    const saved = window.localStorage.getItem(sidebarSeenEventsStorageKey);
    if (!saved) {
      return null;
    }
    const parsed: unknown = JSON.parse(saved);
    return isSeenThreadEvents(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readLegacySeenThreadUpdates(): LegacySeenThreadUpdates | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    const saved = window.localStorage.getItem(
      legacySidebarSeenUpdatesStorageKey,
    );
    if (!saved) {
      return null;
    }
    const parsed: unknown = JSON.parse(saved);
    return isLegacySeenThreadUpdates(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedSeenThreadEvents(
  events: CommandSidebarSeenThreadEvents,
  threads: readonly Thread[],
): CommandSidebarSeenThreadEvents {
  const prioritizedThreadIds = [
    ...threads.map((thread) => thread.id),
    ...Object.keys(events),
  ];
  const uniqueThreadIds = [...new Set(prioritizedThreadIds)];
  return Object.fromEntries(
    uniqueThreadIds
      .filter((threadId) => events[threadId] !== undefined)
      .slice(0, maxStoredThreadCount)
      .map((threadId) => [threadId, events[threadId]!]),
  );
}

function writeSeenThreadEvents(events: CommandSidebarSeenThreadEvents): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        sidebarSeenEventsStorageKey,
        JSON.stringify(events),
      );
    }
  } catch {
    // Sidebar read state is optional; runtime state remains authoritative.
  }
}

function initialSeenThreadEvents(
  threads: readonly Thread[],
): CommandSidebarSeenThreadEvents {
  const currentEvents = Object.fromEntries(
    threads.map((thread) => [
      thread.id,
      commandSidebarThreadEventFingerprint(thread),
    ]),
  );
  const savedEvents = readSeenThreadEvents();
  if (savedEvents) {
    return boundedSeenThreadEvents(
      { ...currentEvents, ...savedEvents },
      threads,
    );
  }

  const legacyUpdates = readLegacySeenThreadUpdates();
  if (!legacyUpdates) {
    return boundedSeenThreadEvents(currentEvents, threads);
  }

  const migratedEvents = { ...currentEvents };
  for (const thread of threads) {
    const legacyUpdatedAt = legacyUpdates[thread.id];
    if (
      legacyUpdatedAt !== undefined &&
      legacyUpdatedAt < thread.updatedAt
    ) {
      migratedEvents[thread.id] = `legacy-unseen:${legacyUpdatedAt}`;
    }
  }
  return boundedSeenThreadEvents(migratedEvents, threads);
}

export function commandSidebarThreadEventFingerprint(thread: Thread): string {
  const { status, latestTurn } = threadListEventSummary(thread);
  const activeFlags =
    status.type === "active" ? [...status.activeFlags].sort() : [];
  return JSON.stringify([
    thread.updatedAt,
    status.type,
    activeFlags,
    latestTurn?.id ?? null,
    latestTurn?.status ?? null,
    latestTurn?.completedAt ?? null,
  ]);
}

export function commandSidebarViewedThreadId({
  activeView,
  hasNewTaskDraft,
  selectedThreadId,
}: {
  activeView: CommandShellView;
  hasNewTaskDraft: boolean;
  selectedThreadId: string | null;
}): string | null {
  return activeView === "command" && !hasNewTaskDraft
    ? selectedThreadId
    : null;
}

export function reconcileCommandSidebarSeenThreadEvents(
  current: CommandSidebarSeenThreadEvents,
  threads: readonly Thread[],
  viewedThreadId: string | null,
): CommandSidebarSeenThreadEvents {
  let next = current;

  for (const thread of threads) {
    const fingerprint = commandSidebarThreadEventFingerprint(thread);
    const previousFingerprint = current[thread.id];
    const state = commandSidebarThreadState(thread, previousFingerprint);
    const shouldAcknowledge =
      thread.id === viewedThreadId ||
      !commandSidebarThreadHasUnreadSignal(state);
    if (!shouldAcknowledge || previousFingerprint === fingerprint) {
      continue;
    }
    if (next === current) {
      next = { ...current };
    }
    next[thread.id] = fingerprint;
  }

  return next === current ? current : boundedSeenThreadEvents(next, threads);
}

export function useCommandSidebarSeenThreadEvents(
  threads: readonly Thread[],
  viewedThreadId: string | null,
): CommandSidebarSeenThreadEvents {
  const [seenEvents, setSeenEvents] =
    useState<CommandSidebarSeenThreadEvents>(() =>
      initialSeenThreadEvents(threads),
    );

  useEffect(() => {
    writeSeenThreadEvents(seenEvents);
  }, [seenEvents]);

  useEffect(() => {
    setSeenEvents((current) =>
      reconcileCommandSidebarSeenThreadEvents(
        current,
        threads,
        viewedThreadId,
      ),
    );
  }, [threads, viewedThreadId]);

  return seenEvents;
}

export function commandSidebarThreadState(
  thread: Thread,
  seenEventFingerprint: string | null | undefined,
): CommandSidebarThreadState {
  const { status, latestTurn } = threadListEventSummary(thread);
  const seen =
    seenEventFingerprint === commandSidebarThreadEventFingerprint(thread);

  if (status.type === "systemError") {
    return seen ? "failedViewed" : "failedUnread";
  }

  if (status.type === "active") {
    const waiting = status.activeFlags.some(
      (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
    );
    if (!waiting) {
      return "running";
    }
    return seen ? "pendingViewed" : "pendingUnread";
  }

  const hasTaskContent = Boolean(
    thread.name?.trim() ||
      thread.preview?.trim() ||
      (thread.turns?.length ?? 0) > 0,
  );
  if (!hasTaskContent) {
    return "neutral";
  }

  if (
    latestTurn?.status === "failed" ||
    latestTurn?.status === "interrupted"
  ) {
    return seen ? "failedViewed" : "failedUnread";
  }

  if (status.type === "notLoaded" && latestTurn === null) {
    return "neutral";
  }

  return seen ? "completedViewed" : "completedUnread";
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
    case "failedUnread":
      return zh ? "异常结束，结果未查看" : "Stopped, result not viewed";
    case "failedViewed":
      return zh ? "异常结束，已查看" : "Stopped, viewed";
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

export function commandSidebarThreadHasUnreadSignal(
  state: CommandSidebarThreadState,
): boolean {
  return (
    state === "pendingUnread" ||
    state === "completedUnread" ||
    state === "failedUnread"
  );
}
