import { describe, expect, it } from "vitest";

import type { AppServerNotification } from "../app-server/appServer";
import type { ThreadGoal } from "@crewon/app-server-protocol/v2/ThreadGoal";
import { handleThreadAppNotification } from "./appThreadNotificationHandler";

type CapturedThreadNotificationState = {
  openedSettings: number;
  refreshedGoals: string[];
  refreshedThreads: string[];
  reloadedThreads: number;
  threadGoal: ThreadGoal | null | undefined;
};

function handleNotification(
  notification: AppServerNotification,
  options: {
    hasThreadGoalField?: boolean;
    selectedThreadId?: string | null;
  } = {},
): { handled: boolean; state: CapturedThreadNotificationState } {
  const state: CapturedThreadNotificationState = {
    openedSettings: 0,
    refreshedGoals: [],
    refreshedThreads: [],
    reloadedThreads: 0,
    threadGoal: undefined,
  };

  const handled = handleThreadAppNotification({
    capabilityPanel: options.hasThreadGoalField
      ? {
          title: "Thread settings",
          fields: [
            {
              id: "thread-goal-objective",
              label: "Goal",
              value: "Ship it",
            },
          ],
        }
      : { title: "Other panel" },
    notification,
    openThreadSettingsPanel: () => {
      state.openedSettings += 1;
    },
    refreshSelectedThreadGoal: (threadId) => {
      state.refreshedGoals.push(threadId);
    },
    refreshThread: (threadId) => {
      state.refreshedThreads.push(threadId);
    },
    reloadThreads: () => {
      state.reloadedThreads += 1;
    },
    selectedThreadId: options.selectedThreadId ?? "thread-1",
    setThreadGoal: (goal) => {
      state.threadGoal = goal;
    },
  });

  return { handled, state };
}

describe("thread app notification handler", () => {
  it("refreshes compacted and token usage thread notifications", () => {
    expect(
      handleNotification({
        method: "thread/compacted",
        params: { threadId: "thread-1" },
      } as AppServerNotification).state.refreshedThreads,
    ).toEqual(["thread-1"]);

    expect(
      handleNotification({
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-2" },
      } as AppServerNotification).state.refreshedThreads,
    ).toEqual(["thread-2"]);
  });

  it("clears selected thread goal only for the selected thread", () => {
    expect(
      handleNotification({
        method: "thread/goal/cleared",
        params: { threadId: "thread-1" },
      } as AppServerNotification).state.threadGoal,
    ).toBeNull();

    expect(
      handleNotification(
        {
          method: "thread/goal/cleared",
          params: { threadId: "thread-2" },
        } as AppServerNotification,
        { selectedThreadId: "thread-1" },
      ).state.threadGoal,
    ).toBeUndefined();
  });

  it("refreshes selected thread goal on goal updates", () => {
    const { handled, state } = handleNotification({
      method: "thread/goal/updated",
      params: { threadId: "thread-1" },
    } as AppServerNotification);

    expect(handled).toBe(true);
    expect(state.refreshedThreads).toEqual(["thread-1"]);
    expect(state.refreshedGoals).toEqual(["thread-1"]);
  });

  it("reopens thread settings only when the selected settings panel is visible", () => {
    expect(
      handleNotification(
        {
          method: "thread/settings/updated",
          params: { threadId: "thread-1" },
        } as AppServerNotification,
        { hasThreadGoalField: true },
      ).state.openedSettings,
    ).toBe(1);

    expect(
      handleNotification({
        method: "thread/settings/updated",
        params: { threadId: "thread-1" },
      } as AppServerNotification).state.openedSettings,
    ).toBe(0);
  });

  it("reloads threads after unarchive notifications", () => {
    const { handled, state } = handleNotification({
      method: "thread/unarchived",
      params: { threadId: "thread-1" },
    } as AppServerNotification);

    expect(handled).toBe(true);
    expect(state.reloadedThreads).toBe(1);
  });

  it("refreshes the full thread after live turn diff and plan updates", () => {
    expect(
      handleNotification({
        method: "turn/diff/updated",
        params: { threadId: "thread-diff" },
      } as AppServerNotification).state.refreshedThreads,
    ).toEqual(["thread-diff"]);

    expect(
      handleNotification({
        method: "turn/plan/updated",
        params: { threadId: "thread-plan" },
      } as AppServerNotification).state.refreshedThreads,
    ).toEqual(["thread-plan"]);
  });

  it("leaves turn completed notifications for app-level sync handling", () => {
    const { handled } = handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    } as AppServerNotification);

    expect(handled).toBe(false);
  });
});
