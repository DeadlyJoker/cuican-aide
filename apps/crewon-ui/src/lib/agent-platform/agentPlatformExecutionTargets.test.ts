import { describe, expect, it } from "vitest";

import type { AgentPlatformSnapshot } from "./agentPlatformClient";
import {
  agentPlatformExecutionTargetOptions,
  agentPlatformExecutionTargetValue,
  platformAgentForExecutionTarget,
} from "./agentPlatformExecutionTargets";

describe("agentPlatformExecutionTargets", () => {
  const snapshot: AgentPlatformSnapshot = {
    agents: [
      { id: 7, name: "合同审核", description: "审查合同风险", is_active: 1 },
      { id: 8, name: "已停用", is_active: 0 },
    ],
    knowledgeBases: [],
    mcpServers: [],
    mcpTools: [],
    skills: [],
    workflows: [],
  };

  it("offers active cloud agents using server-resolvable Agent ids", () => {
    expect(agentPlatformExecutionTargetOptions(snapshot, [])).toEqual([
      {
        detail: "审查合同风险",
        kind: "agent",
        label: "合同审核 · 云智能体",
        strategy: "single",
        value: "agent:agent-platform:7",
      },
    ]);
    expect(
      platformAgentForExecutionTarget(
        snapshot,
        agentPlatformExecutionTargetValue(7),
      ),
    ).toEqual(snapshot.agents[0]);
  });

  it("does not duplicate a cloud agent already persisted in the workspace", () => {
    const persisted = [
      {
        config: { agentId: "agent-platform:7" },
      },
    ];
    expect(agentPlatformExecutionTargetOptions(snapshot, persisted)).toEqual([]);
  });
});
