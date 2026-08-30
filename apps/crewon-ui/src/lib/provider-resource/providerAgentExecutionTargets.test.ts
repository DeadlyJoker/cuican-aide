import { describe, expect, it } from "vitest";

import type { ResourceRef } from "@crewon/app-server-protocol/platform/v2/ResourceRef";

import {
  providerAgentExecutionTargetOptions,
  providerAgentResourceForTarget,
} from "./providerAgentExecutionTargets";

describe("Provider Agent execution targets", () => {
  it("maps exact Agent resource refs to local UI targets without legacy authority ids", () => {
    const agent = resource("agent", "agent-7");
    const options = providerAgentExecutionTargetOptions([
      resource("knowledgeBase", "knowledge-1"),
      agent,
    ]);

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      group: "single",
      kind: "agent",
      label: "agent-7",
      strategy: "single",
    });
    expect(options[0]?.value).toMatch(/^provider-agent:/);
    expect(options[0]?.value).not.toContain("agent-platform:agents:");
    expect(
      providerAgentResourceForTarget([agent], options[0]?.value ?? ""),
    ).toEqual(agent);
    expect(providerAgentResourceForTarget([agent], "crewon")).toBeNull();
  });
});

function resource(
  resourceType: ResourceRef["resourceType"],
  resourceId: string,
): ResourceRef {
  return {
    providerId: "agent-platform",
    resourceId,
    revision: "revision-1",
    resourceType,
  };
}
