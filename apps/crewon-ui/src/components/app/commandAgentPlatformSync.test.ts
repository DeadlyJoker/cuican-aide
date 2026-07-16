import { describe, expect, it, vi } from "vitest";

import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";
import { syncDownloadedAgentPlatformConfigs } from "./commandAgentPlatformSync";

function snapshot(): AgentPlatformSnapshot {
  return {
    agents: [
      {
        id: 10,
        name: "AI智能助理",
        description: "处理日常任务",
        downloaded: true,
        model_info: { model_name: "qwen-plus" },
      },
      {
        id: 11,
        name: "未下载智能体",
        downloaded: false,
        model_info: { model_name: "qwen-lite" },
      },
    ],
    knowledgeBases: [],
    mcpServers: [],
    mcpTools: [],
    skills: [],
    workflows: [],
  };
}

describe("syncDownloadedAgentPlatformConfigs", () => {
  it("persists downloaded agents into the selected Team workspace", async () => {
    const saveAgentConfig = vi.fn().mockResolvedValue({});
    await expect(
      syncDownloadedAgentPlatformConfigs({
        client: {
          listAgentConfigs: vi.fn().mockResolvedValue({ data: [] }),
          saveAgentConfig,
        },
        cwd: "/workspace/team",
        snapshot: snapshot(),
      }),
    ).resolves.toBe(1);

    expect(saveAgentConfig).toHaveBeenCalledWith(
      "/workspace/team",
      expect.objectContaining({
        agentId: "agent-platform:10",
        name: "AI智能助理",
        model: "qwen-plus",
      }),
    );
  });

  it("keeps an existing runtime thread and skips unchanged configs", async () => {
    const firstSnapshot = snapshot();
    const config = {
      threadId: "existing-agent-thread",
      skills: [],
      mcp: [],
      systemPrompt: "",
      permissions: ["agent-platform-local"],
      permission: "agent-platform-local",
      models: ["qwen-plus"],
      model: "qwen-plus",
      role: "处理日常任务",
      accent: "blue" as const,
      glyph: "A",
      name: "AI智能助理",
      agentId: "agent-platform:10",
    };
    const saveAgentConfig = vi.fn().mockResolvedValue({});
    await syncDownloadedAgentPlatformConfigs({
      client: {
        listAgentConfigs: vi.fn().mockResolvedValue({
          data: [{ config, filePath: "/agents/ai.json" }],
        }),
        saveAgentConfig,
      },
      cwd: "/workspace/team",
      snapshot: firstSnapshot,
    });

    expect(saveAgentConfig).not.toHaveBeenCalled();
  });
});
