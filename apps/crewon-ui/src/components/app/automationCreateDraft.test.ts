import { describe, expect, it } from "vitest";

import {
  assistantAutomationDraft,
  assistantScheduleRequest,
} from "./automationCreateDraft";

describe("assistant automation draft", () => {
  it("carries the current assistant request into the real schedule form", () => {
    expect(assistantAutomationDraft("每天 9 点整理待办", 7, "zh")).toEqual({
      frequency: "daily",
      prompt: "每天 9 点整理待办",
      requestId: 7,
      time: "09:00",
      title: "每天 9 点整理待办",
    });
  });

  it("provides a useful bounded fallback for an empty composer", () => {
    const draft = assistantAutomationDraft("", 1, "en");
    expect(draft.title).toBe(
      "Review this conversation on schedule, summarize…",
    );
    expect(draft.prompt).toContain("Review this conversation on schedule");
  });

  it("prefills weekly cadence and rejects explanatory questions", () => {
    expect(
      assistantAutomationDraft("每周五下午 3 点复盘", 2, "zh"),
    ).toMatchObject({
      frequency: "weekly",
      time: "15:00",
      weekday: 5,
    });
    expect(assistantScheduleRequest("请帮我创建每天九点的日程")).not.toBeNull();
    expect(assistantScheduleRequest("为什么当前不能创建定时任务？")).toBeNull();
  });
});
