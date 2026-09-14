import { describe, expect, it } from "vitest";

import { controlOfficeRuntimeStatus } from "./controlOfficeExecutionTarget";

const definition = {
  officeId: "office-1",
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
    expect(
      controlOfficeRuntimeStatus(definition, new Set(["agent-manager"])),
    ).toBe("agentInactive");
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

  it("keeps stale web-development Office roles selectable for immutable rebind", () => {
    const stale = {
      ...definition,
      members: definition.members.map((member, index) => ({
        ...member,
        agentVersionId: index === 0 ? "local-web-old" : "local-web-old-planner",
      })),
      executionTargets: [
        { targetId: "manager", agentVersionId: "local-web-old" },
        { targetId: "reviewer", agentVersionId: "local-web-old-planner" },
      ],
    };

    expect(
      controlOfficeRuntimeStatus(
        stale,
        new Set(["local-web-current", "local-web-current-planner"]),
      ),
    ).toBe("ready");
    expect(
      controlOfficeRuntimeStatus(
        stale,
        new Set(["local-desktop-current", "local-web-current-verifier"]),
      ),
    ).toBe("agentInactive");
  });

  it("enables only an unambiguous active cloud Agent runtime for a historical platform identity", () => {
    const logicalId = "agent-platform:112";
    const currentId = `${logicalId}:${"a".repeat(32)}`;
    const otherCurrentId = `${logicalId}:${"b".repeat(32)}`;
    const cloudDefinition = {
      ...definition,
      members: [
        {
          ...definition.members[0]!,
          agentVersionId: logicalId,
        },
      ],
      executionTargets: [
        {
          ...definition.executionTargets[0]!,
          agentVersionId: logicalId,
        },
      ],
    };

    expect(
      controlOfficeRuntimeStatus(cloudDefinition, new Set([currentId]), [
        cloudVersion(currentId),
      ]),
    ).toBe("ready");
    expect(
      controlOfficeRuntimeStatus(cloudDefinition, new Set([currentId]), [
        cloudVersion(currentId, "responses"),
      ]),
    ).toBe("agentInactive");
    expect(
      controlOfficeRuntimeStatus(
        cloudDefinition,
        new Set([currentId, otherCurrentId]),
        [cloudVersion(currentId), cloudVersion(otherCurrentId)],
      ),
    ).toBe("agentInactive");
  });

  it("does not generalize cloud migration to lookalike AgentVersion IDs", () => {
    const lookalikeId = "agent-platform:agents:112";
    const lookalikeDefinition = {
      ...definition,
      members: [
        {
          ...definition.members[0]!,
          agentVersionId: lookalikeId,
        },
      ],
      executionTargets: [
        {
          ...definition.executionTargets[0]!,
          agentVersionId: lookalikeId,
        },
      ],
    };

    expect(
      controlOfficeRuntimeStatus(
        lookalikeDefinition,
        new Set([`agent-platform:112:${"a".repeat(32)}`]),
        [cloudVersion(`agent-platform:112:${"a".repeat(32)}`)],
      ),
    ).toBe("agentInactive");
  });
});

function cloudVersion(agentVersionId: string, adapterName = "cloud-agent") {
  return { agentVersionId, model: { adapterName } };
}
