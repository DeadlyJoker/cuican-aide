import { describe, expect, it } from "vitest";

import type { ExpertTeamRecordReference } from "../experts/expertTeamRecord";
import {
  officeMemberAgentProfileId,
  writeOfficeMemberAgentProfile,
  type OfficeMemberAgentProfile,
} from "./officeMemberAgentProfile";
import type { ControlOfficeDefinitionRecordReference } from "./officePanelFromRecord";
import {
  controlExecutionTargetMemberProfiles,
  controlOfficeRuntimeMemberProfiles,
} from "./controlOfficeRuntimeMemberProfiles";

describe("Control Office runtime member profiles", () => {
  it("uses the immutable Office responsibility in a fresh browser without local profile state", () => {
    const legacy = office(
      "office-version-durable",
      "member-release",
      "发布办公室",
    );
    const record = {
      ...legacy,
      definition: {
        ...legacy.definition,
        members: [
          {
            ...legacy.definition.members[0]!,
            responsibility:
              "独立负责发布规划，列出门槛、依赖、回退路径和待核验证据。",
          },
        ],
      },
    };

    expect(controlOfficeRuntimeMemberProfiles(record, memoryStorage())).toEqual(
      [
        {
          memberId: "member-release",
          systemPrompt: "",
          skills: [],
          mcp: [],
          knowledge: [],
          teamCoordination: {
            assignmentMode: "roleDirected",
            responsibility:
              "独立负责发布规划，列出门槛、依赖、回退路径和待核验证据。",
            source: "officeDefinition",
          },
        },
      ],
    );
  });

  it("selects the exact Office revision and preserves enabled member capabilities", () => {
    const storage = memoryStorage();
    const wrong = office("office-version-wrong", "member-wrong", "同名办公室");
    const expected = office(
      "office-version-expected",
      "member-expected",
      "同名办公室",
    );
    writeProfile(storage, wrong, "member-wrong", "wrong");
    writeProfile(storage, expected, "member-expected", "expected");

    expect(
      controlExecutionTargetMemberProfiles({
        executionTarget: "team:office-version-expected",
        expertTeams: [],
        offices: [wrong, expected],
        storage,
      }),
    ).toEqual([
      {
        memberId: "member-expected",
        systemPrompt: "expected system prompt",
        skills: [{ name: "expected skill", description: "enabled" }],
        mcp: [{ name: "expected mcp", description: "enabled" }],
        knowledge: [{ name: "expected knowledge", description: "enabled" }],
        teamCoordination: {
          assignmentMode: "roleDirected",
          responsibility: "expected 独立负责核验并报告证据与未知项",
          source: "officeDefinition",
        },
      },
    ]);
  });

  it("maps an Expert target only through its matching Experts record and backing Office", () => {
    const storage = memoryStorage();
    const expertOffice = office(
      "experts-version-1",
      "member-lead",
      "专家团 · 发布评审",
    );
    writeProfile(storage, expertOffice, "member-lead", "expert");
    const expertTeam = experts("experts-version-1", 0);
    const legacyConfig = { ...expertTeam.config };
    delete legacyConfig.officeId;
    const legacyExpertTeam: ExpertTeamRecordReference = {
      ...expertTeam,
      config: legacyConfig,
    };

    expect(
      controlExecutionTargetMemberProfiles({
        executionTarget: "experts:experts-version-1",
        expertTeams: [expertTeam],
        offices: [expertOffice],
        storage,
      })?.[0],
    ).toMatchObject({
      memberId: "member-lead",
      systemPrompt: "expert system prompt",
    });
    expect(
      controlExecutionTargetMemberProfiles({
        executionTarget: "experts:experts-version-1",
        expertTeams: [legacyExpertTeam],
        offices: [expertOffice],
        storage,
      })?.[0],
    ).toMatchObject({ systemPrompt: "expert system prompt" });

    expect(
      controlExecutionTargetMemberProfiles({
        executionTarget: "experts:experts-version-1",
        expertTeams: [],
        offices: [expertOffice],
        storage,
      }),
    ).toBeUndefined();
    expect(
      controlExecutionTargetMemberProfiles({
        executionTarget: "experts:ordinary-office",
        expertTeams: [experts("ordinary-office", 0)],
        offices: [office("ordinary-office", "member-1", "普通办公室")],
        storage,
      }),
    ).toBeUndefined();
  });

  it("projects the unique latest Expert Office revision from an initial Experts marker", () => {
    const storage = memoryStorage();
    const officeV2 = office(
      "experts-version-2",
      "member-lead",
      "专家团 · 发布评审",
      { officeId: "expert-office-stable", revision: 2 },
    );
    const officeV3 = office(
      "experts-version-3",
      "member-lead",
      "专家团 · 发布评审",
      { officeId: "expert-office-stable", revision: 3 },
    );
    writeProfile(storage, officeV2, "member-lead", "revision-2");
    writeProfile(storage, officeV3, "member-lead", "revision-3");

    expect(
      controlExecutionTargetMemberProfiles({
        executionTarget: "experts:experts-version-1",
        expertTeams: [experts("experts-version-1", 0, "expert-office-stable")],
        offices: [officeV2, officeV3],
        storage,
      }),
    ).toEqual([
      expect.objectContaining({
        memberId: "member-lead",
        systemPrompt: "revision-3 system prompt",
        skills: [{ name: "revision-3 skill", description: "enabled" }],
        mcp: [{ name: "revision-3 mcp", description: "enabled" }],
        knowledge: [{ name: "revision-3 knowledge", description: "enabled" }],
        teamCoordination: {
          assignmentMode: "roleDirected",
          responsibility: "revision-3 独立负责核验并报告证据与未知项",
          source: "officeDefinition",
        },
      }),
    ]);
  });

  it("fails closed for unrelated or ambiguous Expert Office revisions", () => {
    const expertTeam = experts("experts-version-1", 0, "expert-office-stable");
    const unrelated = office(
      "experts-version-3",
      "member-lead",
      "专家团 · 发布评审",
      { officeId: "another-office", revision: 3 },
    );
    const firstLatest = office(
      "experts-version-3a",
      "member-lead",
      "专家团 · 发布评审",
      { officeId: "expert-office-stable", revision: 3 },
    );
    const secondLatest = office(
      "experts-version-3b",
      "member-lead",
      "专家团 · 发布评审",
      { officeId: "expert-office-stable", revision: 3 },
    );

    expect(
      controlExecutionTargetMemberProfiles({
        executionTarget: "experts:experts-version-1",
        expertTeams: [expertTeam],
        offices: [unrelated],
      }),
    ).toBeUndefined();
    expect(
      controlExecutionTargetMemberProfiles({
        executionTarget: "experts:experts-version-1",
        expertTeams: [expertTeam],
        offices: [firstLatest, secondLatest],
      }),
    ).toBeUndefined();
    expect(
      controlExecutionTargetMemberProfiles({
        executionTarget: "experts:experts-version-1",
        expertTeams: [expertTeam],
        offices: [
          firstLatest,
          office("ordinary-version-4", "member-lead", "普通办公室", {
            officeId: "expert-office-stable",
            revision: 4,
          }),
        ],
      }),
    ).toBeUndefined();
  });

  it("fails closed for ambiguous revisions and corrupted cross-key profiles", () => {
    const storage = memoryStorage();
    const first = office("duplicate-version", "member-1", "办公室一");
    const second = office("duplicate-version", "member-2", "办公室二");
    writeProfile(storage, first, "member-1", "first");

    expect(
      controlExecutionTargetMemberProfiles({
        executionTarget: "team:duplicate-version",
        expertTeams: [],
        offices: [first, second],
        storage,
      }),
    ).toBeUndefined();

    const mismatchedId = officeMemberAgentProfileId(
      "another-version",
      "member-1",
    );
    const mismatched = profile(mismatchedId, "mismatched");
    writeOfficeMemberAgentProfile(mismatched, storage);
    const values = JSON.parse(
      storage.getItem("crewon:office-member-agent-profiles:v1") ?? "{}",
    ) as Record<string, unknown>;
    values[officeMemberAgentProfileId("duplicate-version", "member-1")] =
      values[mismatchedId];
    storage.setItem(
      "crewon:office-member-agent-profiles:v1",
      JSON.stringify(values),
    );

    expect(controlOfficeRuntimeMemberProfiles(first, storage)).toEqual([]);
  });
});

function office(
  officeVersionId: string,
  memberId: string,
  title: string,
  identity: { officeId: string; revision: number } = {
    officeId: officeVersionId,
    revision: 1,
  },
): ControlOfficeDefinitionRecordReference {
  return {
    authority: "controlDefinition",
    filePath: `control:office:${officeVersionId}`,
    config: { title, subtitle: "Control · r1" },
    definition: {
      officeId: identity.officeId,
      officeVersionId,
      revision: identity.revision,
      members: [
        {
          agentVersionId: `agent-version:${memberId}`,
          displayName: memberId,
          memberId,
        },
      ],
      executionTargets: [
        {
          agentVersionId: `agent-version:${memberId}`,
          targetId: `target:${memberId}`,
        },
      ],
    },
  };
}

function experts(
  expertsId: string,
  expertCount: number,
  officeId = expertsId,
): ExpertTeamRecordReference {
  return {
    filePath: `control:experts:${expertsId}`,
    config: {
      expertsId,
      officeId,
      title: "发布评审",
      goal: "作出发布裁决",
      leader: { name: "组长", role: "裁决", agentType: "worker" },
      experts: Array.from({ length: expertCount }, (_, index) => ({
        name: `专家 ${index + 1}`,
        role: "核验",
        agentType: "explorer" as const,
      })),
      ownerSubject: "control-session",
      recordRevision: "2026-09-03T00:00:00.000Z",
      workspaceKey: "control",
    },
  };
}

function writeProfile(
  storage: ReturnType<typeof memoryStorage>,
  record: ControlOfficeDefinitionRecordReference,
  memberId: string,
  label: string,
): void {
  const profileId = officeMemberAgentProfileId(
    record.definition.officeVersionId,
    memberId,
  );
  writeOfficeMemberAgentProfile(profile(profileId, label), storage, {
    assignmentMode: "roleDirected",
    responsibility: `${label} 独立负责核验并报告证据与未知项`,
    source: "officeDefinition",
  });
}

function profile(agentId: string, label: string): OfficeMemberAgentProfile {
  const capability = (kind: string, enabled: boolean) => ({
    id: `${label}-${kind}`,
    name: `${label} ${kind}`,
    glyph: kind.slice(0, 1).toUpperCase(),
    accent: "cyan" as const,
    description: enabled ? "enabled" : "disabled",
    enabled,
  });
  return {
    agentId,
    name: label,
    role: `${label} role`,
    glyph: "A",
    accent: "cyan",
    model: "gpt-test",
    models: ["gpt-test"],
    permission: "Control policy",
    permissions: ["Control policy"],
    systemPrompt: `${label} system prompt`,
    skills: [capability("skill", true), capability("disabled skill", false)],
    mcp: [capability("mcp", true)],
    knowledge: [capability("knowledge", true)],
  };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
