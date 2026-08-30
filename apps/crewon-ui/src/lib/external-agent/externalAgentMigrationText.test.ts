import type { ExternalAgentConfigMigrationItem } from "@crewon/app-server-protocol/v2/ExternalAgentConfigMigrationItem";
import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../domain/crewonDomain";
import {
  externalAgentImportFailurePanel,
  externalAgentImportFailurePatch,
  externalAgentImportLoadingPanel,
  externalAgentImportLoadingPatch,
  externalAgentImportNotice,
  externalAgentImportThreadGoal,
  externalAgentImportTurnPrompt,
  externalAgentMigrationSummary,
  importedExternalAgentConfig,
} from "./externalAgentMigrationText";

function migrationItem(
  overrides: Partial<ExternalAgentConfigMigrationItem> = {},
): ExternalAgentConfigMigrationItem {
  return {
    itemType: "AGENTS_MD",
    description: "Repo instructions",
    cwd: "/repo",
    details: null,
    ...overrides,
  };
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Base Agent",
    glyph: "◷",
    accent: "blue",
    role: "Base role",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "workspace-write",
    permissions: ["workspace-write"],
    systemPrompt: "Base prompt.",
    mcp: [],
    skills: [],
    ...overrides,
  };
}

describe("external agent migration text", () => {
  it("summarizes external migration details", () => {
    expect(externalAgentMigrationSummary(migrationItem(), "en")).toBe(
      "Scope: /repo",
    );
    expect(
      externalAgentMigrationSummary(
        migrationItem({
          cwd: null,
          details: {
            plugins: [{ marketplaceName: "local", pluginNames: ["docs"] }],
            sessions: [
              { title: "Session", path: "/tmp/session.json", cwd: "/repo" },
            ],
            mcpServers: [{ name: "github" }],
            hooks: [{ name: "pre-commit" }],
            subagents: [{ name: "reviewer" }],
            commands: [{ name: "lint" }],
          },
        }),
        "zh",
      ),
    ).toBe(
      [
        "范围: Home",
        "Plugins: local/docs",
        "MCP: github",
        "Hooks: pre-commit",
        "Subagents: reviewer",
        "Commands: lint",
        "Sessions: Session",
      ].join("\n"),
    );
  });

  it("builds external agent import patches and payload text", () => {
    const item = migrationItem({ description: "Repo instructions" });
    const imported = importedExternalAgentConfig({
      baseConfig: agentConfig({ systemPrompt: "Keep changes small." }),
      item,
      locale: "en",
    });

    expect(externalAgentImportLoadingPatch("zh")).toEqual({
      body: "正在导入 Agent 配置...",
      error: undefined,
    });
    expect(
      externalAgentImportLoadingPanel(
        {
          kind: "agents",
          title: "Agents",
          subtitle: "Library",
          body: "Existing",
          items: [],
          error: "old error",
        },
        "en",
      ),
    ).toEqual({
      kind: "agents",
      title: "Agents",
      subtitle: "Library",
      body: "Importing agent config...",
      items: [],
      error: undefined,
    });
    expect(imported).toMatchObject({
      name: "Imported agent · Repo instructions",
      role: "AGENTS_MD · recruitable",
      systemPrompt: expect.stringContaining(
        "This agent was migrated into Crewon from an external agent configuration.",
      ),
    });
    expect(externalAgentImportThreadGoal(item, "zh")).toBe(
      "导入外部智能体配置「Repo instructions」，并作为办公室可招募角色使用。",
    );
    expect(
      externalAgentImportTurnPrompt({
        agentConfigPath: "/repo/.crewon/agents/imported.json",
        config: { ...imported, agentId: "agent-1" },
        item,
        locale: "en",
      }),
    ).toContain("Backend agent: agent-1");
    expect(
      externalAgentImportNotice({
        config: imported,
        locale: "en",
        threadCreated: true,
      }),
    ).toEqual({
      text: "Imported and created backend agent: Imported agent · Repo instructions",
      tone: "success",
    });
    expect(
      externalAgentImportNotice({
        config: imported,
        locale: "zh",
        threadCreated: false,
      }),
    ).toEqual({
      text: "外部配置已导入，但未创建智能体线程",
      tone: "warning",
    });
    expect(externalAgentImportFailurePatch(null, "en")).toEqual({
      error: "Unable to import agent config",
    });
    expect(externalAgentImportFailurePatch(new Error("denied"), "zh")).toEqual({
      error: "denied",
    });
    expect(externalAgentImportFailurePanel(null, null, "en")).toBeNull();
    expect(
      externalAgentImportFailurePanel(
        {
          kind: "agents",
          title: "Agents",
          subtitle: "Library",
          body: "Importing",
          items: [],
        },
        null,
        "zh",
      ),
    ).toEqual({
      kind: "agents",
      title: "Agents",
      subtitle: "Library",
      body: "Importing",
      items: [],
      error: "导入 Agent 配置失败",
    });
  });
});
