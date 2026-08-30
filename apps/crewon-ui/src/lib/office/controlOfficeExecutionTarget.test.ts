import { describe, expect, it } from "vitest";

import { controlOfficeRuntimeStatus } from "./controlOfficeExecutionTarget";

const definition = {
  officeVersionId: "office-version-1",
  revision: 1,
  members: [
    {
      memberId: "manager",
      displayName: "Manager",
      agentVersionId: "agent-manager",
    },
    {
      memberId: "reviewer",
      displayName: "Reviewer",
      agentVersionId: "agent-reviewer",
    },
  ],
  executionTargets: [
    { targetId: "manager", agentVersionId: "agent-manager" },
    { targetId: "reviewer", agentVersionId: "agent-reviewer" },
  ],
};

describe("Control Office execution target", () => {
  it("enables a bounded multi-member office when every pinned version is active", () => {
    expect(
      controlOfficeRuntimeStatus(
        definition,
        new Set(["agent-manager", "agent-reviewer"]),
      ),
    ).toBe("ready");
  });

  it("supports one local AgentVersion in distinct roles and fails closed on drift", () => {
    expect(controlOfficeRuntimeStatus(definition, new Set(["agent-manager"]))).toBe(
      "agentInactive",
    );
    expect(
      controlOfficeRuntimeStatus(
        {
          ...definition,
          members: definition.members.map((member) => ({
            ...member,
            agentVersionId: "agent-manager",
          })),
          executionTargets: [
            { targetId: "manager", agentVersionId: "agent-manager" },
            { targetId: "duplicate", agentVersionId: "agent-manager" },
          ],
        },
        new Set(["agent-manager"]),
      ),
    ).toBe("ready");
    expect(
      controlOfficeRuntimeStatus(
        {
          ...definition,
          executionTargets: [
            { targetId: "manager", agentVersionId: "agent-reviewer" },
            { targetId: "reviewer", agentVersionId: "agent-manager" },
          ],
        },
        new Set(["agent-manager", "agent-reviewer"]),
      ),
    ).toBe("multiMember");
  });
});
