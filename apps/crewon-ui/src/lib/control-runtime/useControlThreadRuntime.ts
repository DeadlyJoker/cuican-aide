import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { ControlApiClient } from "@crewon/control-client";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import {
  appendItemInThread,
  removeThreadFromList,
  selectedThreadIdAfterThreadRemoval,
  upsertThread,
} from "../thread/threadModel";
import { ControlThreadRuntime } from "./controlThreadRuntime";
import { ControlAutomationRuntime } from "./controlAutomationRuntime";
import type { ConnectionState } from "../shared/connectionState";

type ThreadSetter = (updater: (current: Thread[]) => Thread[]) => void;

export function useControlThreadRuntime(params: {
  appendStreamingTextDelta: (threadId: string, delta: string) => void;
  client: ControlApiClient | null;
  manageThreads: boolean;
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
  automationRuntime: ControlAutomationRuntime | null;
  connected: boolean;
  connectionState: ConnectionState;
  rehydrateThreadAuthority: (threadId: string) => Promise<void>;
  runtime: ControlThreadRuntime | null;
  threadGoal: ThreadGoalView | null;
}> {
  const manageThreadsRef = useRef(params.manageThreads);
  manageThreadsRef.current = params.manageThreads;
  const [threadGoal, setThreadGoal] = useState<ThreadGoalView | null>(null);
  const runtime = useMemo(() => {
    if (params.client === null) {
      return null;
    }
    let control: ControlThreadRuntime;
    control = new ControlThreadRuntime(
      { client: params.client },
      {
        onThread: (thread) => {
          if (!manageThreadsRef.current) return;
          params.setThreads((current) => upsertThread(current, thread));
        },
        onThreadDeleted: (threadId) => {
          if (!manageThreadsRef.current) return;
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
        onTextDelta: (threadId, delta) => {
          if (!manageThreadsRef.current) return;
          params.appendStreamingTextDelta(threadId, delta);
        },
        onToolItem: (threadId, runId, item) => {
          if (!manageThreadsRef.current) return;
          params.setThreads((current) =>
            appendItemInThread(current, threadId, runId, item),
          );
        },
        onRunSettled: (threadId) => {
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
          if (!manageThreadsRef.current) return;
          void control
            .readThread(threadId)
            .then((thread) => {
              params.setThreads((current) => upsertThread(current, thread));
            })
            .catch(() => undefined);
        },
        onStreamError: (threadId) => {
          params.setStreamingTextByThread((current) => {
            const next = { ...current };
            delete next[threadId];
            return next;
          });
          if (!manageThreadsRef.current) return;
          void control
            .readThread(threadId)
            .then((thread) => {
              params.setThreads((current) => upsertThread(current, thread));
            })
            .catch(() => undefined);
        },
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
          if (!manageThreadsRef.current) return;
          if (params.selectedThreadIdRef.current === snapshot.threadId) {
            setThreadGoal(snapshot.goal);
            params.setThreadGoal(snapshot.goal);
          }
        },
        onGoalMutation: (signal) => {
          if (!manageThreadsRef.current) return;
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
  const automationRuntime = useMemo(
    () =>
      params.client === null || runtime === null
        ? null
        : new ControlAutomationRuntime({
            client: params.client,
            adopter: runtime,
          }),
    [params.client, runtime],
  );
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const connected = connectionState === "connected";
  const rehydrateThreadAuthority = useCallback(
    async (threadId: string) => {
      if (runtime === null) {
        throw new Error("control_thread_runtime_unavailable");
      }
      const thread = await runtime.readThread(threadId);
      params.setThreads((current) => upsertThread(current, thread));
      const goal = await runtime.selectThreadGoal(threadId);
      if (params.selectedThreadIdRef.current === threadId) {
        setThreadGoal(goal?.goal ?? null);
        params.setThreadGoal(goal?.goal ?? null);
      }
    },
    [runtime],
  );

  useEffect(() => {
    if (runtime === null) {
      setConnectionState("disconnected");
      return undefined;
    }
    setConnectionState("connecting");
    let current = true;
    void runtime.connect().then(
      () => {
        if (current) setConnectionState("connected");
      },
      () => {
        if (current) setConnectionState("disconnected");
      },
    );
    return () => {
      current = false;
      runtime.close();
    };
  }, [runtime]);

  useEffect(() => {
    if (!connected || runtime === null || !params.manageThreads) {
      return undefined;
    }
    let current = true;
    void runtime
      .listThreads(params.showArchivedThreadsRef.current)
      .then(async (threads) => {
        if (!current) return;
        const selected =
          threads.find(
            (thread) => thread.id === params.selectedThreadIdRef.current,
          ) ?? threads[0];
        const hydrated =
          selected === undefined
            ? null
            : await runtime.readThread(selected.id).catch(() => selected);
        if (!current) return;
        params.setThreads(() =>
          hydrated === null ? threads : upsertThread(threads, hydrated),
        );
        params.setSelectedThreadId(selected?.id ?? threads[0]?.id ?? null);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [connected, params.manageThreads, runtime]);

  useEffect(() => {
    if (!connected || runtime === null || !params.manageThreads) {
      setThreadGoal(null);
      params.setThreadGoal(null);
      return undefined;
    }
    let current = true;
    void runtime.selectThreadGoal(params.selectedThreadId).then(
      (snapshot) => {
        if (current) {
          setThreadGoal(snapshot?.goal ?? null);
          params.setThreadGoal(snapshot?.goal ?? null);
        }
      },
      () => {
        if (current) {
          setThreadGoal(null);
          params.setThreadGoal(null);
        }
      },
    );
    return () => {
      current = false;
      void runtime.selectThreadGoal(null);
    };
  }, [connected, params.manageThreads, params.selectedThreadId, runtime]);

  return {
    automationRuntime,
    connected,
    connectionState,
    rehydrateThreadAuthority,
    runtime,
    threadGoal,
  };
}
