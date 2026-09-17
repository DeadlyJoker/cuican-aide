import { describe, expect, it } from "vitest";

import {
  controlTeamExecutionBudget,
  controlTeamManagerPlanningPrompt,
  controlTeamMemberAssignment,
  controlTeamMemberGuidance,
  controlTeamPlanningStrategy,
} from "./controlTeamPlanning";

const responsibilities = {
  manager: "Own the final release decision and preserve unresolved conflicts.",
  qa: "Verify every acceptance claim against reproducible test evidence.",
  security: "Identify security blockers and missing threat-model evidence.",
} as const;

describe("Control Team planning policy", () => {
  it("removes one nominal Run and one logical phase only for complete distinct roles", () => {
    const plan = roleDirectedPlan();

    expect(controlTeamPlanningStrategy(plan)).toBe("roleDirected");
    expect(controlTeamExecutionBudget(plan, "manager")).toEqual({
      logicalPhases: 2,
      nominalRuns: 3,
      planningStrategy: "roleDirected",
    });
    expect(controlTeamExecutionBudget(plan, "member")).toEqual({
      logicalPhases: 3,
      nominalRuns: 4,
      planningStrategy: "roleDirected",
    });
  });

  it.each([
    ["missing", { qa: null }],
    ["duplicate", { security: responsibilities.qa }],
    [
      "normalized duplicate",
      { security: "ＶＥＲＩＦＹ evidence", qa: "verify   evidence" },
    ],
    ["too short", { security: "review" }],
  ])("keeps manager planning for %s role metadata", (_name, overrides) => {
    const plan = roleDirectedPlan(overrides);

    expect(controlTeamPlanningStrategy(plan)).toBe("managerGenerated");
    expect(controlTeamExecutionBudget(plan, "manager")).toEqual({
      logicalPhases: 3,
      nominalRuns: 4,
      planningStrategy: "managerGenerated",
    });
  });

  it("uses an explicit assignment basis without pretending a manager plan exists", () => {
    const plan = roleDirectedPlan();
    const prompt = controlTeamMemberAssignment(plan, plan.workers[0]!, {
      kind: "explicitResponsibilities",
    });

    expect(prompt).toContain(responsibilities.qa);
    expect(prompt).toContain("完整读取上一条原始用户任务");
    expect(prompt).not.toContain("组长拆解");
  });

  it("does not repeat the generated Office responsibility in a role-directed worker prompt", () => {
    const plan = roleDirectedPlan();
    const worker = plan.workers[0]!;
    const responsibility = responsibilities.qa;
    const prompt = controlTeamMemberAssignment(
      plan,
      {
        ...worker,
        profile: {
          ...worker.profile!,
          systemPrompt: `[办公室职责]\n${responsibility}\n\n保留独立验证与证据要求。`,
        },
      },
      { kind: "explicitResponsibilities" },
    );

    expect(prompt.split(responsibility)).toHaveLength(2);
    expect(prompt).toContain("保留独立验证与证据要求。");
    expect(prompt).not.toContain("[办公室职责]");
  });

  it("keeps the authoritative manager responsibility when browser-local profile text is absent", () => {
    const plan = roleDirectedPlan();
    const manager = {
      ...plan.manager,
      profile: { ...plan.manager.profile!, systemPrompt: "" },
    };

    expect(controlTeamMemberGuidance(manager)).toContain(
      `办公室职责：${responsibilities.manager}`,
    );
  });

  it("counts bounded responsibilities by Unicode code point", () => {
    const plan = roleDirectedPlan({ security: "🚀".repeat(240) });

    expect(controlTeamPlanningStrategy(plan)).toBe("roleDirected");
    expect(
      controlTeamPlanningStrategy(
        roleDirectedPlan({ security: "🚀".repeat(241) }),
      ),
    ).toBe("managerGenerated");
  });

  it("keeps generated planning as the fail-safe prompt", () => {
    const plan = roleDirectedPlan({ qa: null });
    const prompt = controlTeamManagerPlanningPrompt(plan);

    expect(prompt).toContain("完整读取上一条原始用户任务");
    expect(prompt).toContain("互补的分析重点、证据要求和交付边界");
  });
});

function roleDirectedPlan(
  overrides: Partial<Record<keyof typeof responsibilities, string | null>> = {},
) {
  const member = (
    memberId: keyof typeof responsibilities,
    displayName: string,
  ) => {
    const responsibility = Object.hasOwn(overrides, memberId)
      ? (overrides[memberId] ?? null)
      : responsibilities[memberId];
    return {
      memberId,
      displayName,
      ...(responsibility === null
        ? {}
        : {
            profile: {
              memberId,
              systemPrompt: `Work within this role: ${responsibility}`,
              skills: [],
              mcp: [],
              knowledge: [],
              teamCoordination: {
                assignmentMode: "roleDirected" as const,
                responsibility,
                source: "officeDefinition" as const,
              },
            },
          }),
    };
  };
  return {
    officeTitle: "Release office",
    manager: member("manager", "Release lead"),
    workers: [member("qa", "QA"), member("security", "Security")],
  };
}
