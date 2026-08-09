import type {
  SetThreadGoalRequest,
  ThreadGoalMutationResponse,
  ThreadGoalView,
} from "@crewon/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  clearThreadGoalCommand,
  createThreadGoalComposerHandlers,
  editThreadGoalCommand,
  pauseThreadGoalCommand,
  resumeThreadGoalCommand,
} from "./threadGoalComposerActions";

function goal(overrides: Partial<ThreadGoalView> = {}): ThreadGoalView {
  return {
    createdAt: "2026-08-09T00:00:00.000Z",
    goalId: "goal-1",
    objective: "旧目标",
    revision: 3,
    status: "active",
    threadId: "thread-1",
    timeUsedSeconds: 10,
    tokenBudget: 4000,
    tokensUsed: 0,
    updatedAt: "2026-08-09T00:00:01.000Z",
    ...overrides,
  };
}

function mutation(nextGoal: ThreadGoalView | null): ThreadGoalMutationResponse {
  return {
    canceledRun: null,
    continuationRun: null,
    disposition: "committed",
    goal: nextGoal,
    retainedRun: null,
  };
}

function updatedGoal(
  current: ThreadGoalView,
  command: SetThreadGoalRequest,
): ThreadGoalView {
  return goal({
    ...current,
    objective: command.objective ?? current.objective,
    revision: current.revision + 1,
    status: command.status ?? current.status,
    updatedAt: "2026-08-09T00:00:02.000Z",
  });
}

function harness({
  isConnected = true,
  setThreadGoal = vi.fn(),
  threadGoal = goal(),
}: {
  isConnected?: boolean;
  setThreadGoal?: (next: ThreadGoalView | null) => void;
  threadGoal?: ThreadGoalView | null;
} = {}) {
  const current = threadGoal ?? goal();
  const client = {
    clearThreadGoal: vi.fn(async () => mutation(null)),
    setThreadGoal: vi.fn(
      async (_threadId: string, command: SetThreadGoalRequest) =>
        mutation(updatedGoal(current, command)),
    ),
  };
  const setBusy = vi.fn();
  const setNotice = vi.fn();
  return {
    client,
    handlers: createThreadGoalComposerHandlers({
      client,
      isConnected,
      locale: "zh",
      setBusy,
      setNotice,
      setThreadGoal,
      threadGoal,
    }),
    setBusy,
    setNotice,
    setThreadGoal,
  };
}

describe("Control API goal commands", () => {
  it("uses the visible revision and an explicit keep budget for every update", () => {
    const current = goal({ tokenBudget: null });

    expect(editThreadGoalCommand(current, "  新目标  ")).toEqual({
      expectedRevision: 3,
      objective: "新目标",
      status: null,
      tokenBudget: { kind: "keep" },
    });
    expect(pauseThreadGoalCommand(current)).toEqual({
      expectedRevision: 3,
      objective: null,
      status: "paused",
      tokenBudget: { kind: "keep" },
    });
    expect(resumeThreadGoalCommand(goal({ status: "paused" }))).toEqual({
      expectedRevision: 3,
      objective: null,
      status: "active",
      tokenBudget: { kind: "keep" },
    });
    expect(clearThreadGoalCommand(current)).toEqual({ expectedRevision: 3 });
  });

  it("rejects invalid pause and resume transitions", () => {
    expect(() => pauseThreadGoalCommand(goal({ status: "blocked" }))).toThrow(
      "thread_goal_transition_invalid",
    );
    expect(() => resumeThreadGoalCommand(goal({ status: "active" }))).toThrow(
      "thread_goal_transition_invalid",
    );
  });
});

describe("createThreadGoalComposerHandlers", () => {
  it("edits through the Control API command without drifting an unbounded budget", async () => {
    const current = goal({ tokenBudget: null });
    const setThreadGoal = vi.fn();
    const { client, handlers } = harness({
      setThreadGoal,
      threadGoal: current,
    });

    await handlers.setThreadGoalObjective("thread-1", "新目标");

    expect(client.setThreadGoal).toHaveBeenCalledWith("thread-1", {
      expectedRevision: 3,
      objective: "新目标",
      status: null,
      tokenBudget: { kind: "keep" },
    });
    expect(setThreadGoal).toHaveBeenCalledWith(
      goal({
        objective: "新目标",
        revision: 4,
        tokenBudget: null,
        updatedAt: "2026-08-09T00:00:02.000Z",
      }),
    );
  });

  it("pauses and resumes through status-only Control API commands", async () => {
    const pausedSetGoal = vi.fn();
    const paused = harness({ setThreadGoal: pausedSetGoal });

    await paused.handlers.setThreadGoalStatus("thread-1", "paused");

    expect(paused.client.setThreadGoal).toHaveBeenCalledWith("thread-1", {
      expectedRevision: 3,
      objective: null,
      status: "paused",
      tokenBudget: { kind: "keep" },
    });
    expect(pausedSetGoal).toHaveBeenCalledWith(
      goal({
        revision: 4,
        status: "paused",
        updatedAt: "2026-08-09T00:00:02.000Z",
      }),
    );

    const resumeSetGoal = vi.fn();
    const resumed = harness({
      setThreadGoal: resumeSetGoal,
      threadGoal: goal({ status: "paused" }),
    });
    await resumed.handlers.setThreadGoalStatus("thread-1", "active");

    expect(resumed.client.setThreadGoal).toHaveBeenCalledWith("thread-1", {
      expectedRevision: 3,
      objective: null,
      status: "active",
      tokenBudget: { kind: "keep" },
    });
    expect(resumeSetGoal).toHaveBeenCalledWith(
      goal({
        revision: 4,
        updatedAt: "2026-08-09T00:00:02.000Z",
      }),
    );
  });

  it("clears with the visible revision after a null-goal response", async () => {
    const setThreadGoal = vi.fn();
    const { client, handlers } = harness({ setThreadGoal });

    await handlers.clearThreadGoal("thread-1");

    expect(client.clearThreadGoal).toHaveBeenCalledWith("thread-1", {
      expectedRevision: 3,
    });
    expect(setThreadGoal).toHaveBeenCalledWith(null);
  });

  it("surfaces a backend failure and keeps the visible goal", async () => {
    const setThreadGoal = vi.fn();
    const { handlers, client, setNotice } = harness({ setThreadGoal });
    client.clearThreadGoal.mockRejectedValueOnce(new Error("goal locked"));

    await handlers.clearThreadGoal("thread-1");

    expect(setNotice).toHaveBeenCalledWith({
      text: "goal locked",
      tone: "warning",
    });
    expect(setThreadGoal).not.toHaveBeenCalled();
  });

  it("fails closed when the mutation response does not match the command", async () => {
    const setThreadGoal = vi.fn();
    const { handlers, client, setNotice } = harness({ setThreadGoal });
    client.setThreadGoal.mockResolvedValueOnce(
      mutation(goal({ goalId: "different-goal", revision: 4 })),
    );

    await handlers.setThreadGoalObjective("thread-1", "新目标");

    expect(setNotice).toHaveBeenCalledWith({
      text: "目标操作失败",
      tone: "warning",
    });
    expect(setThreadGoal).not.toHaveBeenCalled();
  });

  it("does not resume a limited goal", async () => {
    const setThreadGoal = vi.fn();
    const { handlers, client, setNotice } = harness({
      setThreadGoal,
      threadGoal: goal({ status: "budgetLimited" }),
    });

    await handlers.setThreadGoalStatus("thread-1", "active");

    expect(client.setThreadGoal).not.toHaveBeenCalled();
    expect(setThreadGoal).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenCalledWith({
      text: "目标操作失败",
      tone: "warning",
    });
  });

  it("does nothing while disconnected", async () => {
    const { client, handlers, setBusy } = harness({ isConnected: false });

    await handlers.clearThreadGoal("thread-1");

    expect(client.clearThreadGoal).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
  });
});
