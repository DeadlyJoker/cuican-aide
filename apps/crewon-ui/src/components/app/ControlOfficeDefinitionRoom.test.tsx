import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ControlOfficeDefinitionRecordReference } from "../../lib/office/officePanelFromRecord";
import {
  ControlOfficeDefinitionRoom,
  controlOfficeSettingsRequest,
  officeMemberDraftsHaveChanges,
  officeMembersWithLead,
  type OfficeMemberDraft,
} from "./ControlOfficeDefinitionRoom";

const office = {
  schemaVersion: "crewon.office-definition.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  revision: 2,
  title: "产品交付办公室",
  members: [
    {
      agentVersionId: "agent-version-lead",
      displayName: "交付组长",
      memberId: "member-lead",
    },
    {
      agentVersionId: "agent-version-review",
      displayName: "审阅成员",
      memberId: "member-review",
    },
  ],
  executionTargets: [
    { agentVersionId: "agent-version-lead", targetId: "target-lead" },
    { agentVersionId: "agent-version-review", targetId: "target-review" },
  ],
  createdByActorId: "actor-1",
  createdAt: "2026-08-30T00:00:00.000Z",
};

const record: ControlOfficeDefinitionRecordReference = {
  authority: "controlDefinition",
  filePath: "control:office:office-version-1",
  config: {
    title: "产品交付办公室",
    subtitle: "交付组长 · 审阅成员",
  },
  definition: {
    officeVersionId: "office-version-1",
    revision: 2,
    members: office.members,
    executionTargets: office.executionTargets,
  },
};

const drafts: OfficeMemberDraft[] = office.members.map((member, index) => ({
  member,
  target: office.executionTargets[index]!,
}));

describe("ControlOfficeDefinitionRoom", () => {
  it("presents member settings in product language", () => {
    const markup = renderToStaticMarkup(
      <ControlOfficeDefinitionRoom
        client={{
          createOffice: vi.fn(async () => ({
            disposition: "created" as const,
            office,
          })),
          getOffice: vi.fn(async () => ({ office })),
        }}
        locale="zh"
        record={record}
        onBack={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(markup).toContain("成员设置");
    expect(markup).toContain("办公室成员");
    expect(markup).toContain("成员名称");
    expect(markup).toContain("移出办公室");
    expect(markup).toContain("负责协调和回复");
    expect(markup).toContain("参与任务协作");
    expect(markup).toContain('class="control-office-member-name-line"');
    expect(markup).not.toContain("选择成员进行设置");
    expect(markup).not.toContain("lucide-chevron-right");
    expect(markup).not.toContain('class="control-office-section-icon"');
    expect(markup).not.toContain("office-version-1");
    expect(markup).not.toContain("agent-version-lead");
    expect(markup).not.toContain("Runtime");
    expect(markup).toMatchSnapshot();
  });

  it("keeps each member paired with its execution target when the lead changes", () => {
    const reordered = officeMembersWithLead(drafts, "member-review");

    expect(reordered).toEqual([drafts[1], drafts[0]]);
    expect(reordered.map((draft) => draft.member.agentVersionId)).toEqual(
      reordered.map((draft) => draft.target.agentVersionId),
    );
    expect(officeMemberDraftsHaveChanges(office, reordered)).toBe(true);
    expect(officeMemberDraftsHaveChanges(office, drafts)).toBe(false);
    expect(controlOfficeSettingsRequest(office, reordered)).toEqual({
      officeId: "office-1",
      expectedRevision: 2,
      title: "产品交付办公室",
      members: [office.members[1], office.members[0]],
      executionTargets: [
        office.executionTargets[1],
        office.executionTargets[0],
      ],
    });
  });
});
