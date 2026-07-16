import { describe, expect, it, vi } from "vitest";

import type { AgentConfig, OfficeConfig } from "../../lib/domain/crewonDomain";
import {
  createCommandOffice,
  type CommandOfficeCreationClient,
} from "./commandOfficeCreation";

function officeConfig(
  title: string,
  members: OfficeConfig["workspace"]["members"] = [],
): OfficeConfig {
  return {
    title,
    subtitle: "办公室 · 配置阶段",
    workspace: {
      goal: "交付新版办公室",
      members,
      messages: [],
      tasks: [],
    },
  };
}

function agent(agentId: string, name: string): AgentConfig {
  return {
    agentId,
    name,
    glyph: name.slice(0, 1),
    accent: "blue",
    role: "交付审阅",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "request-approval",
    permissions: ["request-approval"],
    systemPrompt: "Review delivery.",
    mcp: [],
    skills: [],
  };
}

describe("createCommandOffice", () => {
  it("creates the canonical Office and recruits selected real agents in order", async () => {
    const createOfficeConfig = vi.fn(async () => ({
      config: officeConfig("设计交付办公室"),
      filePath: "/repo/.crewon/offices/office.json",
    }));
    const addOfficeMemberConfig = vi.fn(
      async (
        _cwd: string,
        config: OfficeConfig,
        agentId: string,
        member: OfficeConfig["workspace"]["members"][number],
      ) => ({
        config: {
          ...config,
          workspace: {
            ...config.workspace,
            members: [
              ...config.workspace.members,
              { ...member, memberId: agentId },
            ],
          },
        },
        filePath: "/repo/.crewon/offices/office.json",
      }),
    );
    const client: CommandOfficeCreationClient = {
      addOfficeMemberConfig,
      createOfficeConfig,
    };

    const result = await createCommandOffice(
      client,
      "/repo",
      {
        goal: "交付新版办公室",
        members: [
          {
            config: agent("agent-review", "审阅智能体"),
            responsibility: "负责最终验收",
          },
          {
            config: agent("agent-build", "开发智能体"),
            responsibility: "负责实现与测试",
          },
        ],
        title: "设计交付办公室",
      },
      "zh",
    );

    expect(createOfficeConfig).toHaveBeenCalledWith("/repo", {
      goal: "交付新版办公室",
      subtitle: "办公室 · 配置阶段",
      threadId: null,
      title: "设计交付办公室",
    });
    expect(addOfficeMemberConfig).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      record: {
        config: officeConfig("设计交付办公室", [
          {
            accent: "blue",
            agentId: "agent-review",
            glyph: "审",
            memberId: "agent-review",
            name: "审阅智能体",
            online: true,
            role: "负责最终验收",
            status: "已从智能体库招募",
          },
          {
            accent: "blue",
            agentId: "agent-build",
            glyph: "开",
            memberId: "agent-build",
            name: "开发智能体",
            online: true,
            role: "负责实现与测试",
            status: "已从智能体库招募",
          },
        ]),
        filePath: "/repo/.crewon/offices/office.json",
        workspaceCwd: "/repo",
      },
      warnings: [],
    });
  });

  it("returns the created Office when one optional member cannot be recruited", async () => {
    const client: CommandOfficeCreationClient = {
      createOfficeConfig: async () => ({
        config: officeConfig("稳定性办公室"),
        filePath: "/repo/.crewon/offices/stable.json",
      }),
      addOfficeMemberConfig: async () => {
        throw new Error("agent revision changed");
      },
    };

    const result = await createCommandOffice(
      client,
      "/repo",
      {
        goal: "保持创建结果可恢复",
        members: [
          { config: agent("agent-1", "审阅智能体"), responsibility: "审阅" },
        ],
        title: "稳定性办公室",
      },
      "zh",
    );

    expect(result).toEqual({
      record: {
        config: officeConfig("稳定性办公室"),
        filePath: "/repo/.crewon/offices/stable.json",
        workspaceCwd: "/repo",
      },
      warnings: ["agent revision changed"],
    });
  });
});
