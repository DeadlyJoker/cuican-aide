import { useEffect } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import type { Locale } from "../../i18n";
import type { StreamingTextActivity } from "../../thread/threadStreamingTextBuffer";
import {
  clientOwnsModelResponseTimeout,
  markModelResponseTimedOut,
  modelResponseTimeoutDelayMs,
} from "../../thread/threadTurnTimeout";

type StateSetter<T> = (updater: (current: T) => T) => void;

export type AppModelResponseTimeoutEffectParams = {
  activeTurnId: string | null;
  client: Pick<AppServerClient, "interruptTurn"> | null;
  isConnected: boolean;
  locale: Locale;
  runtimeAuthority: "control" | "legacy";
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setStreamingTextByThread: StateSetter<Record<string, string>>;
  setThreads: StateSetter<Thread[]>;
  streamingText: string;
  streamingTextActivity: (threadId: string) => StreamingTextActivity;
};

export function useAppModelResponseTimeoutEffect({
  activeTurnId,
  client,
  isConnected,
  locale,
  runtimeAuthority,
  selectedThread,
  selectedThreadId,
  setActiveTurnByThread,
  setStreamingTextByThread,
  setThreads,
  streamingText,
  streamingTextActivity,
}: AppModelResponseTimeoutEffectParams) {
  useEffect(() => {
    if (
      !clientOwnsModelResponseTimeout(runtimeAuthority) ||
      !isConnected ||
      !selectedThreadId ||
      !activeTurnId ||
      streamingTextActivity(selectedThreadId) !== "none"
    ) {
      return undefined;
    }

    const delayMs = modelResponseTimeoutDelayMs({
      nowMs: Date.now(),
      streamingText,
      thread: selectedThread,
      turnId: activeTurnId,
    });
    if (delayMs === null) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      // Hidden previews intentionally do not trigger React updates. Recheck
      // received output before inferring a timeout from the old visible text.
      if (streamingTextActivity(selectedThreadId) !== "none") return;
      const completedAt = Math.floor(Date.now() / 1000);
      setActiveTurnByThread((current) => {
        const { [selectedThreadId]: _removed, ...rest } = current;
        return rest;
      });
      setStreamingTextByThread((current) => {
        const { [selectedThreadId]: _removed, ...rest } = current;
        return rest;
      });
      setThreads((current) =>
        markModelResponseTimedOut({
          completedAt,
          locale,
          threadId: selectedThreadId,
          threads: current,
          turnId: activeTurnId,
        }),
      );
      void client
        ?.interruptTurn(selectedThreadId, activeTurnId)
        .catch(() => undefined);
    }, delayMs);

    return () => window.clearTimeout(timeoutId);
  }, [
    activeTurnId,
    client,
    isConnected,
    locale,
    runtimeAuthority,
    selectedThread,
    selectedThreadId,
    setActiveTurnByThread,
    setStreamingTextByThread,
    setThreads,
    streamingText,
    streamingTextActivity,
  ]);
}
