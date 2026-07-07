import { useEffect } from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import type { Locale } from "../../i18n";
import {
  markModelResponseTimedOut,
  modelResponseTimeoutDelayMs,
} from "../../thread/threadTurnTimeout";

type StateSetter<T> = (updater: (current: T) => T) => void;

export type AppModelResponseTimeoutEffectParams = {
  activeTurnId: string | null;
  client: AppServerClient | null;
  isConnected: boolean;
  locale: Locale;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setStreamingTextByThread: StateSetter<Record<string, string>>;
  setThreads: StateSetter<Thread[]>;
  streamingText: string;
};

export function useAppModelResponseTimeoutEffect({
  activeTurnId,
  client,
  isConnected,
  locale,
  selectedThread,
  selectedThreadId,
  setActiveTurnByThread,
  setStreamingTextByThread,
  setThreads,
  streamingText,
}: AppModelResponseTimeoutEffectParams) {
  useEffect(() => {
    if (!isConnected || !selectedThreadId || !activeTurnId) {
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
      void client?.interruptTurn(selectedThreadId, activeTurnId).catch(() => undefined);
    }, delayMs);

    return () => window.clearTimeout(timeoutId);
  }, [
    activeTurnId,
    client,
    isConnected,
    locale,
    selectedThread,
    selectedThreadId,
    setActiveTurnByThread,
    setStreamingTextByThread,
    setThreads,
    streamingText,
  ]);
}
