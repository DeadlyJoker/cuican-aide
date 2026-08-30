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
        // A cloud agent runs as a single agent, so it joins that section and the
        // label carries no "· 云智能体" suffix repeating the header.
        group: "single",
        kind: "agent",
        label: "合同审核",
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

  /*
   * Both key shapes are on disk: the Agents page writes the resource id
   * `agent-platform:agents:<id>`, while older saved configs carry a bare
   * `agent-platform:<id>`. Only the bare form used to be covered here, so the
   * dedupe passed its test while every agent saved through the Agents page was
   * listed twice in the selector.
   */
  it("does not duplicate a cloud agent persisted under the resource id", () => {
    const persisted = [{ config: { agentId: "agent-platform:agents:7" } }];

    expect(agentPlatformExecutionTargetOptions(snapshot, persisted)).toEqual([]);
  });

  it("does not duplicate a cloud agent persisted under the legacy bare id", () => {
    const persisted = [{ config: { agentId: "agent-platform:7" } }];

    expect(agentPlatformExecutionTargetOptions(snapshot, persisted)).toEqual([]);
  });
});
