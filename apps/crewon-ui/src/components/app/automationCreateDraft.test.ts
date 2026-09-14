import { describe, expect, it } from "vitest";

import {
  assistantAutomationDraft,
  assistantScheduleRequest,
  skillAutomationDraft,
} from "./automationCreateDraft";
import { scheduleSkillInvocation } from "./automationSkill.test-support";

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

describe("Skill automation draft", () => {
  it("pins a validated version separately from the human-readable prompt", () => {
    const invocation = scheduleSkillInvocation();
    const draft = skillAutomationDraft({ title: " 每周报告 ", invocation }, 4);
    expect(draft).toMatchObject({
      frequency: "daily",
      time: "18:00",
      title: "每周报告",
      requestId: 4,
      skillInvocation: invocation,
    });
    expect(draft.prompt).not.toContain("sha256:");
    invocation.skill.versionId = "version-2";
    invocation.parameters.count = 9;
    expect(draft.skillInvocation?.skill.versionId).toBe("version-1");
    expect(draft.skillInvocation?.parameters.count).toBe(2);
  });

  it("rejects unpinned version aliases before opening a schedule draft", () => {
    const invocation = scheduleSkillInvocation();
    invocation.skill.versionId = "latest";
    expect(() =>
      skillAutomationDraft({ title: "Weekly", invocation }, 1),
    ).toThrow();
  });
});
