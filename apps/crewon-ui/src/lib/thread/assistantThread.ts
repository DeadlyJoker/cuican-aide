import type { Thread } from "@crewon-protocol/v2/Thread";

import type { ThreadRuntimeSettings } from "./threadRuntimeSettings";

export const ASSISTANT_THREAD_SOURCE = "assistant";
export const ASSISTANT_AUTO_COMPACT_TOKEN_LIMIT = 120_000;

export function isAssistantThread(thread: Pick<Thread, "threadSource">): boolean {
  return thread.threadSource === ASSISTANT_THREAD_SOURCE;
}

export function latestAssistantThread(threads: Thread[]): Thread | null {
  return (
    threads
      .filter(isAssistantThread)
      .sort(
        (left, right) =>
          (right.updatedAt ?? right.createdAt) -
          (left.updatedAt ?? left.createdAt),
      )[0] ?? null
  );
}

export function assistantThreadRuntimeSettings(
  settings: ThreadRuntimeSettings = {},
): ThreadRuntimeSettings {
  return {
    ...settings,
    threadSource: ASSISTANT_THREAD_SOURCE,
    config: {
      ...settings.config,
      model_auto_compact_token_limit: ASSISTANT_AUTO_COMPACT_TOKEN_LIMIT,
      model_auto_compact_token_limit_scope: "total",
    },
  };
}
