import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";

import type { Locale } from "../i18n";
import { updateThreadInList } from "./threadModel";

export const MODEL_RESPONSE_TIMEOUT_MS = 120_000;

export function clientOwnsModelResponseTimeout(
  runtimeAuthority: "control" | "legacy",
): boolean {
  return runtimeAuthority === "legacy";
}

function itemHasModelProgress(item: ThreadItem): boolean {
  switch (item.type) {
    case "userMessage":
      return false;
    case "agentMessage":
      return item.text.trim().length > 0;
    case "reasoning":
      return item.summary.length > 0 || item.content.length > 0;
    case "plan":
      return item.text.trim().length > 0;
    default:
      return true;
  }
}

export function turnHasModelProgress(turn: Turn): boolean {
  return turn.items.some(itemHasModelProgress);
}

export function modelResponseTimeoutMessage(locale: Locale): string {
  return locale === "zh"
    ? "模型连接超时，当前任务已停止。请稍后重试，或检查模型与网络连接。"
    : "Model connection timed out, so this turn was stopped. Try again later or check the model and network connection.";
}

export function modelResponseTimeoutDelayMs({
  nowMs,
  streamingText,
  thread,
  timeoutMs = MODEL_RESPONSE_TIMEOUT_MS,
  turnId,
}: {
  nowMs: number;
  streamingText: string;
  thread: Thread | null;
  timeoutMs?: number;
  turnId: string | null;
}): number | null {
  if (!thread || !turnId || streamingText.trim()) {
    return null;
  }

  const turn = thread.turns.find((candidate) => candidate.id === turnId);
  if (!turn || turn.status !== "inProgress" || turnHasModelProgress(turn)) {
    return null;
  }

  const startedAtMs = turn.startedAt ? turn.startedAt * 1000 : nowMs;
  return Math.max(0, timeoutMs - (nowMs - startedAtMs));
}

export function markModelResponseTimedOut({
  completedAt,
  locale,
  threadId,
  threads,
  turnId,
}: {
  completedAt: number;
  locale: Locale;
  threadId: string;
  threads: Thread[];
  turnId: string;
}): Thread[] {
  const message = modelResponseTimeoutMessage(locale);
  return updateThreadInList(threads, threadId, (thread) => ({
    ...thread,
    turns: thread.turns.map((turn) =>
      turn.id === turnId && turn.status === "inProgress"
        ? {
            ...turn,
            status: "failed",
            error: {
              message,
              codexErrorInfo: null,
              additionalDetails: null,
            },
            completedAt,
          }
        : turn,
    ),
  }));
}
