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
import type { NoticeState } from "../shared/noticeState";

import {
  appendItemInThread,
  removeThreadFromList,
  selectedThreadIdAfterThreadRemoval,
  upsertThread,
  upsertTurnInThread,
} from "../thread/threadModel";
import { ControlThreadRuntime } from "./controlThreadRuntime";
import { ControlAutomationRuntime } from "./controlAutomationRuntime";
import type { ConnectionState } from "../shared/connectionState";
import {
  applyControlRunPlanProjection,
  removeThreadRunPlanProjections,
  type ControlRunPlanProjectionState,
} from "./controlRunPlanProjection";
import type { ControlToolApprovalRequest } from "./controlToolApprovalPresentation";

type ThreadSetter = (updater: (current: Thread[]) => Thread[]) => void;

export function useControlThreadRuntime(params: {
  appendStreamingTextDelta: (threadId: string, delta: string) => void;
  client: ControlApiClient | null;
  manageThreads: boolean;
  onExecutionIntentMismatch?: (threadId: string, runId: string) => void;
  onToolApprovalRequired?: (request: ControlToolApprovalRequest) => void;
  onToolApprovalResolved?: (threadId: string, runId: string) => void;
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
  setNotice: (notice: NoticeState | null) => void;
  setThreads: ThreadSetter;
  showArchivedThreadsRef: MutableRefObject<boolean>;
  waitForStreamingTextDrain: (threadId: string) => Promise<void>;
}): Readonly<{
  automationRuntime: ControlAutomationRuntime | null;
  connected: boolean;
  connectionState: ConnectionState;
  rehydrateThreadAuthority: (threadId: string) => Promise<void>;
  runPlanByRunId: ControlRunPlanProjectionState;
  runtime: ControlThreadRuntime | null;
  threadGoal: ThreadGoalView | null;
}> {
  const manageThreadsRef = useRef(params.manageThreads);
  manageThreadsRef.current = params.manageThreads;
  const onToolApprovalRequiredRef = useRef(params.onToolApprovalRequired);
  onToolApprovalRequiredRef.current = params.onToolApprovalRequired;
  const onToolApprovalResolvedRef = useRef(params.onToolApprovalResolved);
  onToolApprovalResolvedRef.current = params.onToolApprovalResolved;
  const onExecutionIntentMismatchRef = useRef(params.onExecutionIntentMismatch);
  onExecutionIntentMismatchRef.current = params.onExecutionIntentMismatch;
  const [threadGoal, setThreadGoal] = useState<ThreadGoalView | null>(null);
  const [runPlanByRunId, setRunPlanByRunId] =
    useState<ControlRunPlanProjectionState>({});
  const runPlanByRunIdRef = useRef<ControlRunPlanProjectionState>({});
  const [runtime, setRuntime] = useState<ControlThreadRuntime | null>(null);
  useEffect(() => {
    runPlanByRunIdRef.current = {};
    setRunPlanByRunId({});
    if (params.client === null) {
      setRuntime(null);
      return undefined;
    }
    // React StrictMode replays effect setup and cleanup in development. Construct the runtime
    // inside the effect so the replay gets a fresh instance instead of reconnecting one that the
    // preceding cleanup permanently closed.
    let control: ControlThreadRuntime;
    control = new ControlThreadRuntime(
      { client: params.client },
      {
        onThread: (thread) => {
          if (!manageThreadsRef.current) return;
          params.setThreads((current) => upsertThread(current, thread));
        },
        onTurnStarted: (threadId, turn) => {
          if (!manageThreadsRef.current) return;
          params.setThreads((current) =>
            upsertTurnInThread(current, threadId, turn),
          );
        },
        onThreadDeleted: (threadId) => {
          if (!manageThreadsRef.current) return;
          const nextPlans = removeThreadRunPlanProjections(
            runPlanByRunIdRef.current,
            threadId,
          );
          runPlanByRunIdRef.current = nextPlans;
          setRunPlanByRunId(nextPlans);
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
        onBeforeRunSettled: async (threadId) => {
          if (!manageThreadsRef.current) return;
          await params.waitForStreamingTextDrain(threadId);
        },
        onToolItem: (threadId, runId, item) => {
          if (!manageThreadsRef.current) return;
          params.setThreads((current) =>
            appendItemInThread(current, threadId, runId, item),
          );
        },
        onToolApprovalRequired: (request) => {
          onToolApprovalRequiredRef.current?.(request);
        },
        onToolApprovalResolved: (threadId, runId) => {
          onToolApprovalResolvedRef.current?.(threadId, runId);
        },
        onToolHistoryCoverage: (threadId, runId, coverage) => {
          if (!manageThreadsRef.current) return;
          params.setThreads((current) =>
            current.map((thread) =>
              thread.id !== threadId
                ? thread
                : {
                    ...thread,
                    turns: thread.turns.map((turn) =>
                      turn.id === runId
                        ? {
                            ...turn,
                            itemsView: coverage.complete ? "full" : "summary",
                          }
                        : turn,
                    ),
                  },
            ),
          );
        },
        onTaskChangeHistoryCoverage: (threadId, runId, coverage) => {
          if (!manageThreadsRef.current) return;
          params.setThreads((current) =>
            current.map((thread) =>
              thread.id !== threadId
                ? thread
                : {
                    ...thread,
                    turns: thread.turns.map((turn) =>
                      turn.id === runId
                        ? {
                            ...turn,
                            taskChangesView: coverage.complete
                              ? "full"
                              : "summary",
                          }
                        : turn,
                    ),
                  },
            ),
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
        onRunPlan: (projection) => {
          if (!manageThreadsRef.current) return;
          try {
            const nextPlans = applyControlRunPlanProjection(
              runPlanByRunIdRef.current,
              projection,
            );
            if (nextPlans !== runPlanByRunIdRef.current) {
              runPlanByRunIdRef.current = nextPlans;
              setRunPlanByRunId(nextPlans);
            }
          } catch {
            params.setNotice({
              text: "任务计划状态异常，已保留最后一次可信进度。",
              tone: "warning",
            });
          }
        },
        onRunPlanReset: (threadId) => {
          if (!manageThreadsRef.current) return;
          const nextPlans = removeThreadRunPlanProjections(
            runPlanByRunIdRef.current,
            threadId,
          );
          if (nextPlans !== runPlanByRunIdRef.current) {
            runPlanByRunIdRef.current = nextPlans;
            setRunPlanByRunId(nextPlans);
          }
        },
        onStreamError: (threadId, _runId, _error) => {
          params.setStreamingTextByThread((current) => {
            const next = { ...current };
            delete next[threadId];
            return next;
          });
          params.setNotice({
            text: "任务流中断，正在尝试恢复…",
            tone: "warning",
          });
          if (!manageThreadsRef.current) return;
          void control
            .readThread(threadId)
            .then((thread) => {
              params.setThreads((current) => upsertThread(current, thread));
            })
            .catch(() => undefined);
        },
        onThreadStreamError: (_threadId, _error) => {
          params.setNotice({
            text: "会话连接异常，正在重连…",
            tone: "warning",
          });
        },
        onGoalStreamError: (_threadId, _error) => {
          params.setNotice({
            text: "目标状态同步失败，请重试。",
            tone: "warning",
          });
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
        onExecutionIntentMismatch: (threadId, runId) => {
          onExecutionIntentMismatchRef.current?.(threadId, runId);
        },
      },
    );
    setRuntime(control);
    return () => control.close();
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
    runPlanByRunId,
    runtime,
    threadGoal,
  };
}
