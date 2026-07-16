import { describe, expect, it } from "vitest";

import type { AgentConfig, OfficeConfig } from "./crewonDomain";
import {
  agentConfigRecordsToLibraryItems,
  officeConfigRecordsToLibraryItems,
} from "./domainLibraryItems";

function officeConfig(title: string, goal: string): OfficeConfig {
  return {
    title,
    subtitle:
      title === "新办公室 22:54"
        ? "新建办公室 · 配置阶段"
        : "真实办公室",
    workspace: {
      goal,
      members: [],
      messages: [],
      tasks: [],
    },
  };
}

describe("Office library records", () => {
  it("omits removed quick-create placeholders but keeps real records", () => {
    expect(
      officeConfigRecordsToLibraryItems(
        [
          {
            filePath: "/repo/.crewon/offices/placeholder.json",
            savedAt: "2026-06-28T14:54:11Z",
            config: officeConfig(
              "新办公室 22:54",
              "围绕「新办公室 22:54」进行多智能体协作，先配置成员，再启动群聊。",
            ),
          },
          {
            filePath: "/repo/.crewon/offices/release.json",
            savedAt: "2026-07-15T00:00:00Z",
            config: officeConfig("发布办公室", "完成真实版本交付"),
          },
        ],
        "zh",
      ).map((item) => item.title),
    ).toEqual(["发布办公室"]);
  });
});

describe("Agent library records", () => {
  it("omits removed quick-create placeholders but keeps configured agents", () => {
    const placeholder: AgentConfig = {
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
    };
    const realAgent = {
      ...placeholder,
      name: "发布检查智能体",
      role: "检查构建、测试和发布门禁",
    };

    expect(
      agentConfigRecordsToLibraryItems(
        [
          {
            filePath: "/repo/.crewon/agents/placeholder.json",
            savedAt: "2026-06-28T14:55:00Z",
            config: placeholder,
          },
          {
            filePath: "/repo/.crewon/agents/release.json",
            savedAt: "2026-07-15T00:00:00Z",
            config: realAgent,
          },
        ],
        "zh",
      ).map((item) => item.title),
    ).toEqual(["发布检查智能体"]);
  });
});
