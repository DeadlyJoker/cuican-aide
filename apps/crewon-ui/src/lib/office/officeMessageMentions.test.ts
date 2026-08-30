import { describe, expect, it } from "vitest";

import type { OfficeMember } from "../domain/crewonDomain";
import {
  officeMessageDraftMentionForMember,
  officeMessageMentionsForSubmission,
  officeMessageMentionsFromText,
} from "./officeMessageMentions";

function member(
  name: string,
  memberId?: string,
  overrides: Partial<OfficeMember> = {},
): OfficeMember {
  return {
    accent: "blue",
    glyph: name.slice(0, 1),
    memberId,
    name,
    role: "Specialist",
    status: "idle",
    ...overrides,
  };
}

describe("officeMessageMentionsFromText", () => {
  it("returns canonical member IDs in message order and deduplicates repeats", () => {
    expect(
      officeMessageMentionsFromText(
        "请 @Reviewer 先看，@Builder 执行；@Reviewer 最后复核。",
        [
          member("Builder", "member-builder"),
          member("Reviewer", "member-reviewer"),
        ],
      ),
    ).toEqual([
      { memberId: "member-reviewer" },
      { memberId: "member-builder" },
    ]);
  });

  it("ignores ambiguous names and members without canonical IDs", () => {
    expect(
      officeMessageMentionsFromText("@Alex @Observer", [
        member("Alex", "member-a"),
        member("Alex", "member-b"),
        member("Observer"),
      ]),
    ).toEqual([]);
  });

  it("keeps a palette-selected duplicate name bound to its canonical member ID", () => {
    const members = [
      member("Alex", "member-reviewer", { role: "Reviewer" }),
      member("Alex", "member-builder", { role: "Builder" }),
    ];
    const selected = officeMessageDraftMentionForMember(members[1], members);

    expect(selected).toEqual({
      displayText: "@Alex（Builder）",
      memberId: "member-builder",
    });
    expect(
      officeMessageMentionsForSubmission(
        "请 @Alex（Builder） 先实现。",
        members,
        [selected!],
      ),
    ).toEqual([{ memberId: "member-builder" }]);
  });

  it("drops a selected mention after its exact display token is removed", () => {
    const members = [
      member("Alex", "member-reviewer", { role: "Reviewer" }),
      member("Alex", "member-builder", { role: "Builder" }),
    ];
    const selected = officeMessageDraftMentionForMember(members[0], members);

    expect(
      officeMessageMentionsForSubmission("请 Alex 先复核。", members, [selected!]),
    ).toEqual([]);
  });

  it("uses the longest exact display name instead of matching a prefix", () => {
    expect(
      officeMessageMentionsFromText("@产品经理 请处理，@产品审阅 不应命中。", [
        member("产品", "member-product"),
        member("产品经理", "member-product-manager"),
      ]),
    ).toEqual([{ memberId: "member-product-manager" }]);
  });

  it("does not interpret email domains or unfinished names as mentions", () => {
    expect(
      officeMessageMentionsFromText(
        "发给 user@Reviewer.example，@Reviewer-draft 也还不是成员标签。",
        [member("Reviewer", "member-reviewer")],
      ),
    ).toEqual([]);
  });

  it("returns no mentions when the message uses the manager-default route", () => {
    expect(
      officeMessageMentionsFromText("请主控安排这项工作。", [
        member("Builder", "member-builder"),
      ]),
    ).toEqual([]);
  });

  it("caps structured mentions at the server contract limit", () => {
    const members = Array.from({ length: 20 }, (_, index) =>
      member(`Member ${index}`, `member-${index}`),
    );
    const text = members.map(({ name }) => `@${name}`).join(" ");

    expect(officeMessageMentionsFromText(text, members)).toEqual(
      members.slice(0, 16).map(({ memberId }) => ({ memberId: memberId! })),
    );
  });
});
