import type { OfficeMemberContract } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import {
  controlOfficeDirectMemberId,
  controlOfficeMemberMentionForMember,
  controlOfficeMemberMentionsForSubmission,
  controlOfficeMemberMentionsFromText,
} from "./controlOfficeMemberMentions";

function member(
  memberId: string,
  displayName: string,
): OfficeMemberContract {
  return {
    agentVersionId: `agent-${memberId}`,
    displayName,
    memberId,
  };
}

describe("Control Office member mentions", () => {
  it("resolves one unambiguous @mention to its member ID", () => {
    const members = [member("member-lead", "组长"), member("member-review", "审阅")];

    const mentions = controlOfficeMemberMentionsFromText(
      "请 @审阅 检查交付边界。",
      members,
      "zh",
    );

    expect(mentions).toEqual([
      { displayText: "@审阅", memberId: "member-review" },
    ]);
    expect(controlOfficeDirectMemberId(mentions)).toBe("member-review");
  });

  it("keeps a palette-selected duplicate name bound to the intended member", () => {
    const members = [member("member-review", "Alex"), member("member-build", "Alex")];
    const selected = controlOfficeMemberMentionForMember(
      members[1]!,
      1,
      members,
      "en",
    );

    expect(selected).toEqual({
      displayText: "@Alex（Member 2）",
      memberId: "member-build",
    });
    expect(
      controlOfficeMemberMentionsForSubmission(
        "Please @Alex（Member 2） implement this.",
        members,
        "en",
        [selected!],
      ),
    ).toEqual([selected]);
  });

  it("keeps multiple @mentions on the coordinated Team route", () => {
    const members = [member("member-lead", "Lead"), member("member-review", "Reviewer")];
    const mentions = controlOfficeMemberMentionsForSubmission(
      "@Lead and @Reviewer coordinate the release.",
      members,
      "en",
      [],
    );

    expect(mentions.map((mention) => mention.memberId)).toEqual([
      "member-lead",
      "member-review",
    ]);
    expect(controlOfficeDirectMemberId(mentions)).toBeNull();
  });

  it("ignores @mentions that do not match any member name", () => {
    const members = [member("member-lead", "组长")];
    const mentions = controlOfficeMemberMentionsFromText(
      "请 @未知的人 确认一下",
      members,
      "zh",
    );

    expect(mentions).toEqual([]);
    expect(controlOfficeDirectMemberId(mentions)).toBeNull();
  });

  it("does not match a member name embedded in a longer token", () => {
    const members = [member("member-qa", "QA")];
    const mentions = controlOfficeMemberMentionsFromText(
      "Please run @QATeam checks.",
      members,
      "en",
    );

    expect(mentions).toEqual([]);
  });

  it("deduplicates repeated @mentions of the same member", () => {
    const members = [member("member-qa", "QA")];
    const mentions = controlOfficeMemberMentionsFromText(
      "@QA please check. @QA again.",
      members,
      "en",
    );

    expect(mentions).toEqual([
      { displayText: "@QA", memberId: "member-qa" },
    ]);
    expect(controlOfficeDirectMemberId(mentions)).toBe("member-qa");
  });

  it("returns null for direct routing when no member is mentioned", () => {
    const members = [member("member-lead", "组长")];
    const mentions = controlOfficeMemberMentionsForSubmission(
      "请确认一下交付边界",
      members,
      "zh",
      [],
    );

    expect(mentions).toEqual([]);
    expect(controlOfficeDirectMemberId(mentions)).toBeNull();
  });

  it("respects the 16-mention upper bound", () => {
    const members = Array.from({ length: 20 }, (_, index) =>
      member(`member-${index}`, `Member${index}`),
    );
    const text = members
      .map((m) => `@${m.displayName}`)
      .join(" and ");
    const mentions = controlOfficeMemberMentionsFromText(text, members, "en");

    expect(mentions).toHaveLength(16);
  });
});
