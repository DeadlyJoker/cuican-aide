import { describe, expect, it } from "vitest";

import type { LibraryPanel } from "../domain/crewonDomain";
import {
  buildMcpDraftPanel,
  buildMcpDraftPanelContent,
  buildMcpDraftPayload,
  buildSkillDraftPanel,
  buildSkillDraftPanelContent,
  buildSkillDraftPayload,
  draftTimestampName,
  draftPayloadErrorPanel,
  mcpDraftSavedNotice,
  mcpDraftSavingPanel,
  skillDraftSavedNotice,
  skillDraftSavingPanel,
  skillDraftMissingWorkspaceMessage,
  skillDraftMissingWorkspacePanel,
} from "./draftSavePayloads";

function toolPanel(): LibraryPanel {
  return {
    kind: "tools",
    title: "Tools",
    subtitle: "Library",
    items: [{ title: "Existing", meta: "old" }],
  };
}

describe("draft save payload builders", () => {
  it("builds timestamp draft names", () => {
    expect(draftTimestampName("workspace-mcp", "202606171430")).toBe(
      "workspace-mcp-202606171430",
    );
    expect(draftTimestampName("workspace skill", "2026:06")).toBe(
      "workspace-skill-2026-06",
    );
  });

  it("builds MCP draft panel content", () => {
    expect(
      buildMcpDraftPanelContent({
        serverName: "workspace-mcp-202606171430",
        locale: "en",
      }),
    ).toMatchObject({
      title: "Add MCP service",
      subtitle: "Saved to config.toml and reloaded",
      fields: [
        {
          id: "mcp-draft-name",
          label: "MCP name",
          value: "workspace-mcp-202606171430",
        },
        {
          id: "mcp-draft-config",
          value:
            '{\n  "command": "npx",\n  "args": [\n    "-y",\n    "@modelcontextprotocol/server-everything"\n  ],\n  "enabled": false\n}',
        },
      ],
      actions: [
        {
          id: "save-mcp-draft",
          label: "Add MCP",
          tone: "primary",
        },
        {
          id: "reload-tools",
          label: "Back and refresh tools",
        },
      ],
      items: [],
      error: undefined,
    });
    expect(
      buildMcpDraftPanel(toolPanel(), {
        serverName: "workspace-mcp-202606171430",
        locale: "en",
      }),
    ).toMatchObject({
      title: "Add MCP service",
      subtitle: "Saved to config.toml and reloaded",
      items: [],
      error: undefined,
    });
    expect(
      buildMcpDraftPanel(null, {
        serverName: "workspace-mcp-202606171430",
        locale: "en",
      }),
    ).toMatchObject({
      kind: "tools",
      title: "Add MCP service",
    });
  });

  it("builds skill draft panel content", () => {
    expect(
      buildSkillDraftPanelContent({
        cwd: "/repo",
        skillName: "workspace-skill-202606171430",
        locale: "zh",
      }),
    ).toEqual({
      title: "新建技能",
      subtitle: "/repo · 保存到 .crewon/skill",
      body: "填写技能名称、描述和工作流步骤。保存后会写入 SKILL.md 并注册技能目录。",
      fields: [
        {
          id: "skill-draft-name",
          label: "技能名称",
          value: "workspace-skill-202606171430",
        },
        {
          id: "skill-draft-description",
          label: "描述",
          value: "从 CrewON 创建的可复用工作流。",
        },
        {
          id: "skill-draft-workflow",
          label: "工作流步骤",
          value:
            "- 确认目标产物和受众。\n- 收集当前应用状态和后端证据。\n- 输出简洁结果和验证记录。",
        },
      ],
      actions: [
        {
          id: "save-skill-draft",
          label: "保存技能",
          tone: "primary",
        },
        {
          id: "reload-tools",
          label: "返回并刷新工具",
        },
      ],
      items: [],
      error: undefined,
    });
    expect(
      buildSkillDraftPanel(toolPanel(), {
        cwd: "/repo",
        skillName: "workspace-skill-202606171430",
        locale: "zh",
      }),
    ).toMatchObject({
      title: "新建技能",
      subtitle: "/repo · 保存到 .crewon/skill",
      items: [],
      error: undefined,
    });
    expect(skillDraftMissingWorkspaceMessage("en")).toBe(
      "No workspace path is available for creating a skill",
    );
    expect(skillDraftMissingWorkspacePanel(toolPanel(), "zh")).toEqual({
      ...toolPanel(),
      error: "当前没有工作区路径，无法创建技能",
    });
    expect(skillDraftMissingWorkspacePanel(null, "en")).toBeNull();
  });

  it("builds MCP draft payloads", () => {
    expect(
      buildMcpDraftPayload(
        [
          { id: "mcp-draft-name", label: "Name", value: "GitHub MCP" },
          {
            id: "mcp-draft-config",
            label: "Config",
            value:
              '{"command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_TOKEN":"secret"},"enabled":false}',
          },
        ],
        "en",
      ),
    ).toEqual({
      type: "ok",
      payload: {
        serverName: "github-mcp",
        serverConfig: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "secret" },
          enabled: false,
        },
        toolRecord: {
          kind: "mcp",
          title: "github-mcp",
          name: "github-mcp",
          description: "MCP service config: npx",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "secret" },
          enabled: false,
        },
      },
    });
  });

  it("validates MCP draft payloads", () => {
    expect(
      buildMcpDraftPayload(
        [{ id: "mcp-draft-name", label: "Name", value: "Missing command" }],
        "zh",
      ),
    ).toEqual({
      type: "error",
      message: "服务名称和配置不能为空",
    });

    expect(
      buildMcpDraftPayload(
        [
          { id: "mcp-draft-name", label: "Name", value: "Bad args" },
          {
            id: "mcp-draft-config",
            label: "Config",
            value: '{"command":"node","args":{"not":"array"}}',
          },
        ],
        "en",
      ),
    ).toEqual({
      type: "error",
      message: "args must be an array of strings",
    });

    expect(
      buildMcpDraftPayload(
        [
          { id: "mcp-draft-name", label: "Name", value: "Bad env" },
          {
            id: "mcp-draft-config",
            label: "Config",
            value: '{"command":"node","env":{"PORT":3000}}',
          },
        ],
        "en",
      ),
    ).toEqual({
      type: "error",
      message: "env must be an object of string values",
    });

    expect(
      buildMcpDraftPayload(
        [
          { id: "mcp-draft-name", label: "Name", value: "Cloud service" },
          {
            id: "mcp-draft-config",
            label: "Config",
            value:
              '{"command":"npx","args":["-y","mcp-remote","<SERVICE_URL>"],"env":{"TOKEN":"<YOUR_TOKEN>"},"enabled":true}',
          },
        ],
        "zh",
      ),
    ).toEqual({
      type: "error",
      message: "请先替换服务配置占位符：<SERVICE_URL>、<YOUR_TOKEN>",
    });
  });

  it("builds MCP draft save feedback", () => {
    expect(draftPayloadErrorPanel(toolPanel(), "bad draft")).toEqual({
      ...toolPanel(),
      error: "bad draft",
    });
    expect(draftPayloadErrorPanel(null, "bad draft")).toBeNull();
    expect(mcpDraftSavingPanel(toolPanel(), "github-mcp", "en")).toEqual({
      ...toolPanel(),
      body: "Saving MCP config: github-mcp",
      error: undefined,
    });
    expect(
      mcpDraftSavedNotice({
        locale: "zh",
        serverName: "github-mcp",
        toolRecord: {
          operation: "updated",
          filePath: "/repo/.crewon/tools/github-mcp.json",
        },
      }),
    ).toEqual({
      text: "已更新服务：github-mcp（配置记录：/repo/.crewon/tools/github-mcp.json）",
      tone: "success",
    });
  });

  it("builds skill draft payloads", () => {
    expect(
      buildSkillDraftPayload(
        [
          { id: "skill-draft-name", label: "Name", value: "Frontend Cleanup" },
          {
            id: "skill-draft-description",
            label: "Description",
            value: "Keep UI code clean.",
          },
          {
            id: "skill-draft-workflow",
            label: "Workflow",
            value: "1. Inspect\n2. Refactor",
          },
        ],
        "/repo",
        "en",
      ),
    ).toEqual({
      type: "ok",
      payload: {
        cwd: "/repo",
        name: "frontend-cleanup",
        description: "Keep UI code clean.",
        body: [
          "# frontend-cleanup",
          "",
          "Keep UI code clean.",
          "",
          "## Workflow",
          "1. Inspect\n2. Refactor",
          "",
        ].join("\n"),
      },
    });
  });

  it("validates skill draft payloads", () => {
    expect(buildSkillDraftPayload([], null, "en")).toEqual({
      type: "error",
      message: "Workspace, name, description, and workflow steps are required",
    });
  });

  it("builds skill draft save feedback", () => {
    expect(
      skillDraftSavingPanel(toolPanel(), "frontend-cleanup", "zh"),
    ).toEqual({
      ...toolPanel(),
      body: "正在写入技能：frontend-cleanup",
      error: undefined,
    });
    expect(skillDraftSavingPanel(null, "frontend-cleanup", "zh")).toBeNull();
    expect(
      skillDraftSavedNotice({
        locale: "en",
        skillName: "frontend-cleanup",
        toolRecord: {
          operation: "created",
          filePath: "/repo/.crewon/tools/frontend-cleanup.json",
        },
      }),
    ).toEqual({
      text: "Saved skill: frontend-cleanup (backend record: /repo/.crewon/tools/frontend-cleanup.json)",
      tone: "success",
    });
  });
});
