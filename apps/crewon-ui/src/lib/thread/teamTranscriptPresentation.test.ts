import { describe, expect, it } from "vitest";
import { visibleTeamAssistantText } from "./teamTranscriptPresentation";
describe("team transcript presentation", () => {
  it("removes private dispatch markers while keeping actual mentions and member findings", () => {
    const raw =
      "苏算：合计684元。@姚客·客户服务 请更新通知。\n[[CrewON delegate:member-3]]";
    expect(visibleTeamAssistantText(raw)).toBe(
      "苏算：合计684元。@姚客·客户服务 请更新通知。",
    );
    expect(raw).toContain("[[CrewON delegate:");
  });
  it("keeps routing markers private during an unfinished stream", () => {
    expect(
      visibleTeamAssistantText("待核验。\n[[CrewON delegate:member-"),
    ).toBe("待核验。");
  });
  it("preserves ordinary prose and user-facing @ mentions", () => {
    expect(visibleTeamAssistantText("@用户 请决定预算上限。")).toBe(
      "@用户 请决定预算上限。",
    );
  });
});
