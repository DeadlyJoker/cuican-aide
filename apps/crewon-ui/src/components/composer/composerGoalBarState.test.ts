import type { ThreadGoalView } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import {
  composerGoalBarState,
  formatGoalElapsed,
  goalPauseToggleStatus,
} from "./composerGoalBarState";

function goal(overrides: Partial<ThreadGoalView> = {}): ThreadGoalView {
  return {
    createdAt: "2026-08-09T00:00:00.000Z",
    goalId: "goal-1",
    objective: "看一下我们之前的设计",
    revision: 3,
    status: "active",
    threadId: "thread-1",
    timeUsedSeconds: 2913,
    tokenBudget: null,
    tokensUsed: 0,
    updatedAt: "2026-08-09T00:00:01.000Z",
    ...overrides,
  };
}

describe("formatGoalElapsed", () => {
  it("keeps the label short at every scale", () => {
    expect(formatGoalElapsed(0)).toBe("0s");
    expect(formatGoalElapsed(45)).toBe("45s");
    expect(formatGoalElapsed(2913)).toBe("48m 33s");
    expect(formatGoalElapsed(8040)).toBe("2h 14m");
    expect(formatGoalElapsed(-10)).toBe("0s");
  });
});

describe("composerGoalBarState", () => {
  it("describes an active Control API goal", () => {
    expect(composerGoalBarState(goal(), "zh")).toEqual({
      elapsedLabel: "48m 33s",
      objective: "看一下我们之前的设计",
      pauseToggleEnabled: true,
      running: true,
      statusLabel: "进行中的目标",
    });
  });

  it("marks a paused goal as resumable and not running", () => {
    expect(composerGoalBarState(goal({ status: "paused" }), "zh")).toEqual({
      elapsedLabel: "48m 33s",
      objective: "看一下我们之前的设计",
      pauseToggleEnabled: true,
      running: false,
      statusLabel: "已暂停的目标",
    });
  });

  it("disables the pause toggle for non-transitionable states", () => {
    expect(
      composerGoalBarState(goal({ status: "budgetLimited" }), "en"),
    ).toEqual({
      elapsedLabel: "48m 33s",
      objective: "看一下我们之前的设计",
      pauseToggleEnabled: false,
      running: false,
      statusLabel: "Goal at budget limit",
    });
  });

  it("renders nothing for absent or malformed goal state", () => {
    expect(composerGoalBarState(null, "zh")).toBeNull();
    expect(composerGoalBarState(goal({ objective: "   " }), "zh")).toBeNull();
    expect(
      composerGoalBarState(
        { ...goal(), status: "future-status" } as unknown as ThreadGoalView,
        "zh",
      ),
    ).toBeNull();
    expect(
      composerGoalBarState(
        { ...goal(), createdAt: "not-a-date" } as ThreadGoalView,
        "zh",
      ),
    ).toBeNull();
  });
});

describe("goalPauseToggleStatus", () => {
  it("only flips active and paused states", () => {
    expect(goalPauseToggleStatus("active")).toBe("paused");
    expect(goalPauseToggleStatus("paused")).toBe("active");
    expect(goalPauseToggleStatus("blocked")).toBe("blocked");
    expect(goalPauseToggleStatus("complete")).toBe("complete");
  });
});
