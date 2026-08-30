import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../domain/crewonDomain";
import { isLegacyGeneratedAgentPlaceholder } from "./legacyAgentPlaceholder";

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    accent: "cyan",
    glyph: "✦",
    mcp: [],
    model: "gpt-5.5",
    models: ["gpt-5.5"],
    name: "新智能体",
    permission: ":read-only",
    permissions: [":read-only"],
    role: "后端能力智能体 · 可招募",
    skills: [],
    systemPrompt:
      "你是办公室中的自定义智能体。你的模型、权限、MCP 和 Skill 来自当前 app-server。先理解目标，再列出计划，必要时调用已授权工具，并把结果沉淀为可复用交付物。",
    ...overrides,
  };
}

describe("legacy Agent placeholders", () => {
  it("recognizes the exact generated Chinese and English signatures", () => {
    expect(isLegacyGeneratedAgentPlaceholder(agentConfig())).toBe(true);
    expect(
      isLegacyGeneratedAgentPlaceholder(
        agentConfig({
          name: "New Agent",
          role: "Backend-capable agent · recruitable",
          systemPrompt:
            "You are a custom agent in an office. Your model, permission profile, MCP connectors, and skills come from the current app-server. Understand the goal, outline a plan, use authorized tools when needed, and turn results into reusable deliverables.",
        }),
      ),
    ).toBe(true);
  });

  it("keeps similarly named agents with a real identity", () => {
    expect(
      isLegacyGeneratedAgentPlaceholder(
        agentConfig({ role: "负责后端 API 的真实交付智能体" }),
      ),
    ).toBe(false);
    expect(
      isLegacyGeneratedAgentPlaceholder(
        agentConfig({ name: "后端交付智能体" }),
      ),
    ).toBe(false);
  });
});
