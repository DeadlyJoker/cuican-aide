import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
} from "react";
import type { ControlApiClient } from "@crewon/control-client";
import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import {
  removeThreadFromList,
  selectedThreadIdAfterThreadRemoval,
  upsertThread,
} from "../thread/threadModel";
import { ControlThreadRuntime } from "./controlThreadRuntime";

type ThreadSetter = (updater: (current: Thread[]) => Thread[]) => void;

export type ControlThreadConnectionStatus =
  | "connecting"
  | "connected"
  | "unavailable";

type ControlThreadConnectionPort = Pick<
  ControlThreadRuntime,
  "connect" | "listThreads"
>;

export async function establishControlThreadConnection(params: {
  runtime: ControlThreadConnectionPort;
  showArchived: boolean;
  onStatus: (status: ControlThreadConnectionStatus) => void;
}): Promise<Thread[] | null> {
  params.onStatus("connecting");
  try {
    await params.runtime.connect();
    const threads = await params.runtime.listThreads(params.showArchived);
    params.onStatus("connected");
    return threads;
  } catch {
    params.onStatus("unavailable");
    return null;
  }
}

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
  connectionStatus: ControlThreadConnectionStatus;
  rehydrateThreadAuthority: (threadId: string) => Promise<void>;
  retryConnection: () => void;
  runtime: ControlThreadRuntime | null;
}> {
  const [connectionAttempt, setConnectionAttempt] = useState(0);
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
  }, [connectionAttempt, params.client]);
  const [connectionStatus, setConnectionStatus] =
    useState<ControlThreadConnectionStatus>(
      params.client === null ? "unavailable" : "connecting",
    );
  const rehydrateThreadAuthority = useCallback(
    async (threadId: string) => {
      if (runtime === null) {
        throw new Error("control_thread_runtime_unavailable");
      }
      const thread = await runtime.readThread(threadId);
      params.setThreads((current) => upsertThread(current, thread));
      const goal = await runtime.selectThreadGoal(threadId);
      if (params.selectedThreadIdRef.current === threadId) {
        params.setThreadGoal(goal?.goal ?? null);
      }
    },
    [runtime],
  );

  useEffect(() => {
    if (runtime === null) {
      setConnectionStatus("unavailable");
      return undefined;
    }
    let current = true;
    void establishControlThreadConnection({
      runtime,
      showArchived: params.showArchivedThreadsRef.current,
      onStatus: (status) => current && setConnectionStatus(status),
    }).then((threads) => {
      if (!current || threads === null) return;
      const selected = threads.find(
        (thread) => thread.id === params.selectedThreadIdRef.current,
      );
      params.setThreads(() => threads);
      params.setSelectedThreadId(selected?.id ?? threads[0]?.id ?? null);
    });
    return () => {
      current = false;
      runtime.close();
    };
  }, [runtime]);

  useEffect(() => {
    if (connectionStatus !== "connected" || runtime === null) {
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
  }, [connectionStatus, params.selectedThreadId, runtime]);

  return {
    connectionStatus,
    rehydrateThreadAuthority,
    retryConnection: () => setConnectionAttempt((current) => current + 1),
    runtime,
  };
}
