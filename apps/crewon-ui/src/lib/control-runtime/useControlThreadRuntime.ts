import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import type { ControlApiClient } from "@crewon/control-client";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import {
  removeThreadFromList,
  selectedThreadIdAfterThreadRemoval,
  upsertThread,
} from "../thread/threadModel";
import { ControlThreadRuntime } from "./controlThreadRuntime";

type ThreadSetter = (updater: (current: Thread[]) => Thread[]) => void;

export function useControlThreadRuntime(params: {
  appendStreamingTextDelta: (threadId: string, delta: string) => void;
  client: ControlApiClient | null;
  selectedThreadId: string | null;
  selectedThreadIdRef: MutableRefObject<string | null>;
  setActiveTurnByThread: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setStreamingTextByThread: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setThreadGoal: (goal: ThreadGoalView | null) => void;
  setThreads: ThreadSetter;
  showArchivedThreadsRef: MutableRefObject<boolean>;
}): Readonly<{
  connected: boolean;
  runtime: ControlThreadRuntime | null;
}> {
  const runtime = useMemo(() => {
    if (params.client === null) {
      return null;
    }
    let control: ControlThreadRuntime;
    control = new ControlThreadRuntime(
      { client: params.client },
      {
        onThread: (thread) => {
          params.setThreads((current) => upsertThread(current, thread));
        },
        onThreadDeleted: (threadId) => {
          params.setThreads((current) =>
            removeThreadFromList(current, threadId),
          );
          params.setSelectedThreadId(
            selectedThreadIdAfterThreadRemoval(
              params.selectedThreadIdRef.current,
              threadId,
            ),
          );
        },
        onTextDelta: params.appendStreamingTextDelta,
        onRunSettled: (threadId) => {
          params.setActiveTurnByThread((current) => {
            const next = { ...current };
            delete next[threadId];
            return next;
          });
        },
        onStreamError: () => undefined,
        onThreadRolledBack: (threadId) => {
          params.setActiveTurnByThread((current) => {
            const next = { ...current };
            delete next[threadId];
            return next;
          });
          params.setStreamingTextByThread((current) => {
            const next = { ...current };
            delete next[threadId];
            return next;
          });
        },
        onThreadGoal: (snapshot) => {
          if (params.selectedThreadIdRef.current === snapshot.threadId) {
            params.setThreadGoal(snapshot.goal);
          }
        },
        onGoalStreamError: (threadId) => {
          if (params.selectedThreadIdRef.current === threadId) {
            params.setThreadGoal(null);
          }
        },
        onGoalMutation: (signal) => {
          void control
            .readThread(signal.threadId)
            .then((thread) => {
              params.setThreads((current) => upsertThread(current, thread));
            })
            .catch(() => undefined);
        },
      },
    );
    return control;
  }, [params.client]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (runtime === null) {
      setConnected(false);
      return undefined;
    }
    let current = true;
    void runtime
      .connect()
      .then(() => runtime.listThreads(params.showArchivedThreadsRef.current))
      .then(
        (threads) => {
          if (!current) {
            return;
          }
          const selected = threads.find(
            (thread) => thread.id === params.selectedThreadIdRef.current,
          );
          params.setThreads(() => threads);
          params.setSelectedThreadId(selected?.id ?? threads[0]?.id ?? null);
          setConnected(true);
        },
        () => {
          if (current) {
            setConnected(false);
          }
        },
      );
    return () => {
      current = false;
      runtime.close();
    };
  }, [runtime]);

  useEffect(() => {
    if (!connected || runtime === null) {
      params.setThreadGoal(null);
      return undefined;
    }
    let current = true;
    void runtime.selectThreadGoal(params.selectedThreadId).then(
      (snapshot) => {
        if (current) {
          params.setThreadGoal(snapshot?.goal ?? null);
        }
      },
      () => {
        if (current) {
          params.setThreadGoal(null);
        }
      },
    );
    return () => {
      current = false;
      void runtime.selectThreadGoal(null);
    };
  }, [connected, params.selectedThreadId, runtime]);

  return { connected, runtime };
}
