import { describe, expect, it } from "vitest";

import {
  buildThreadGoalDraft,
  threadGoalActionFailureMessage,
  threadGoalActionFailurePanel,
  threadGoalActionProgressBody,
  threadGoalActionProgressPanel,
  threadGoalClearedPanel,
  threadGoalClearedDemoPanel,
  threadGoalClearedPanelPatch,
  threadGoalSavedBody,
  threadGoalSavedPanel,
  threadGoalSavedDemoPanel,
  threadGoalValidationMessage,
  threadGoalValidationPanel,
  validateThreadGoalDraft,
} from "./threadGoalPanel";

describe("thread goal panel helpers", () => {
  function panel() {
    return {
      title: "Session settings",
      subtitle: "Goal",
      body: "Existing",
      error: "old error",
      fields: [{ id: "thread-goal-objective", label: "Goal", value: "Old" }],
    };
  }

  it("builds thread goal drafts from field values", () => {
    const draft = buildThreadGoalDraft((fieldId) =>
      fieldId === "thread-goal-objective"
        ? "Ship frontend refactor"
        : "12000",
    );

    expect(draft).toEqual({
      objective: "Ship frontend refactor",
      tokenBudget: 12000,
      tokenBudgetText: "12000",
    });
    expect(validateThreadGoalDraft(draft)).toBeNull();
  });

  it("allows empty token budgets", () => {
    expect(
      buildThreadGoalDraft((fieldId) =>
        fieldId === "thread-goal-objective" ? "Keep working" : "",
      ),
    ).toEqual({
      objective: "Keep working",
      tokenBudget: null,
      tokenBudgetText: "",
    });
  });

  it("validates missing objectives and invalid budgets", () => {
    expect(
      validateThreadGoalDraft({
        objective: "",
        tokenBudget: null,
        tokenBudgetText: "",
      }),
    ).toBe("missingObjective");
    expect(
      validateThreadGoalDraft({
        objective: "Keep working",
        tokenBudget: 0,
        tokenBudgetText: "0",
      }),
    ).toBe("invalidBudget");
  });

  it("formats validation messages", () => {
    expect(threadGoalValidationMessage("missingObjective", "en")).toBe(
      "Goal cannot be empty",
    );
    expect(threadGoalValidationMessage("invalidBudget", "zh")).toBe(
      "Token 预算必须是正数",
    );
    expect(threadGoalValidationMessage(null, "en")).toBeNull();
  });

  it("builds goal demo panels", () => {
    expect(threadGoalClearedDemoPanel("en")).toEqual({
      title: "Session settings",
      subtitle: "Goal",
      body: "Goal cleared (demo)",
      actions: [
        {
          id: "save-thread-goal",
          label: "Set again",
          tone: "primary",
        },
      ],
    });
    expect(
      threadGoalSavedDemoPanel(
        {
          objective: "Ship refactor",
          tokenBudget: null,
          tokenBudgetText: "",
        },
        "zh",
      ),
    ).toEqual({
      title: "会话设置",
      subtitle: "目标",
      body: "已保存目标（演示）\nShip refactor",
      actions: [
        {
          id: "clear-thread-goal",
          label: "清除目标",
          tone: "danger",
        },
      ],
    });
  });

  it("builds goal action feedback", () => {
    expect(threadGoalActionProgressBody("save", "en")).toBe("Saving goal...");
    expect(threadGoalActionProgressBody("clear", "zh")).toBe("正在清除目标...");
    expect(threadGoalActionProgressPanel(panel(), "save", "en")).toEqual({
      ...panel(),
      body: "Saving goal...",
      error: undefined,
    });
    expect(threadGoalClearedPanelPatch("en")).toEqual({
      body: "Goal cleared",
      fields: [
        {
          id: "thread-goal-objective",
          label: "Goal",
          placeholder: "Describe the ongoing goal for this session",
          value: "",
        },
        {
          id: "thread-goal-token-budget",
          label: "Token budget",
          placeholder: "Optional, leave blank for no budget",
          value: "",
        },
      ],
      actions: [
        {
          id: "save-thread-goal",
          label: "Set again",
          tone: "primary",
        },
      ],
    });
    expect(threadGoalClearedPanel(panel(), "en")).toEqual({
      ...panel(),
      ...threadGoalClearedPanelPatch("en"),
    });
    expect(threadGoalSavedBody("zh")).toBe("目标已保存");
    expect(threadGoalSavedPanel(panel(), "zh")).toEqual({
      ...panel(),
      body: "目标已保存",
      error: undefined,
    });
    expect(threadGoalActionFailureMessage(null, "en")).toBe(
      "Goal action failed",
    );
    expect(threadGoalActionFailureMessage(new Error("denied"), "zh")).toBe(
      "denied",
    );
    expect(threadGoalActionFailurePanel(panel(), null, "en")).toEqual({
      ...panel(),
      error: "Goal action failed",
    });
    expect(threadGoalValidationPanel(panel(), "Goal cannot be empty")).toEqual({
      ...panel(),
      error: "Goal cannot be empty",
    });
    expect(threadGoalSavedPanel(null, "en")).toBeNull();
  });
});
