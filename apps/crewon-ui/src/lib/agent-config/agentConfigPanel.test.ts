import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import type { AgentConfig, LibraryItemAction } from "../domain/crewonDomain";
import {
  agentCapabilityCounts,
  agentCapabilityToggledPanel,
  agentCreateCapabilityFallbackError,
  agentCreateErrorMessage,
  agentCreateRecordFallbackError,
  agentConfigHistoryPanel,
  agentConfigHydrateFailurePanel,
  agentConfigHydrateFailurePatch,
  agentConfigHydratedPanel,
  agentConfigHydratedPatch,
  agentConfigPanel,
  agentConfigPanelPatch,
  agentConfigSavedPanel,
  agentConfigUpdatedPanel,
  agentConfigWrittenBody,
  agentSaveFallbackError,
  agentSaveFailureNoticeState,
  agentSaveSuccessNotice,
  agentSaveSuccessNoticeState,
  agentSaveThreadGoal,
  agentSaveTurnSummary,
  buildAgentCreateLoadingPanel,
  buildAgentConfigPanelContent,
  buildAgentCreatePanel,
  buildAgentCreateLoadingPanelContent,
  buildAgentCreatePanelContent,
} from "./agentConfigPanel";

type AgentConfigAction = Extract<LibraryItemAction, { type: "agent-config" }>;

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Frontend Agent",
    glyph: "◷",
    accent: "blue",
    role: "Refactor UI",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "workspace-write",
    permissions: ["workspace-write"],
    systemPrompt: "Keep the frontend clean.",
    mcp: [
      {
        id: "git",
        name: "Git",
        glyph: "⌁",
        accent: "green",
        description: "Git tools",
        enabled: true,
      },
      {
        id: "db",
        name: "Database",
        glyph: "▣",
        accent: "violet",
        description: "DB tools",
        enabled: false,
      },
    ],
    skills: [
      {
        id: "review",
        name: "Review",
        glyph: "✓",
        accent: "cyan",
        description: "Review skill",
        enabled: true,
      },
    ],
    ...overrides,
  };
}

function agentAction(overrides: Partial<AgentConfigAction> = {}): AgentConfigAction {
  return {
    type: "agent-config",
    config: agentConfig(),
    ...overrides,
  };
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Preview",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    clientVersion: "test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [turn()],
    ...overrides,
  };
}

describe("agent config panel content", () => {
  it("builds agent save text", () => {
    const config = agentConfig();

    expect(agentCapabilityCounts(config)).toEqual({
      enabledMcp: 1,
      enabledSkills: 1,
    });
    expect(agentSaveThreadGoal(config, "en")).toBe(
      'Persist agent "Frontend Agent" configuration and make it recruitable by offices.',
    );
    expect(
      agentSaveTurnSummary({
        config,
        configPath: "/repo/.crewon/agents/frontend.json",
        locale: "en",
      }),
    ).toBe(
      [
        "Agent: Frontend Agent",
        "Role: Refactor UI",
        "Model: gpt-5",
        "Permission: workspace-write",
        "Enabled MCP: Git",
        "Enabled skills: Review",
        "Backend record: /repo/.crewon/agents/frontend.json",
        "",
        "Keep the frontend clean.",
      ].join("\n"),
    );
    expect(
      agentSaveTurnSummary({
        config,
        configPath: null,
        locale: "zh",
      }),
    ).toContain("后端记录：已提交到 agent/create");
    expect(
      agentConfigWrittenBody("/repo/.crewon/agents/frontend.json", "zh"),
    ).toBe("智能体配置已写入：/repo/.crewon/agents/frontend.json");
    expect(agentConfigWrittenBody(null, "en")).toBeUndefined();
    expect(agentSaveSuccessNotice({ config, locale: "en" })).toBe(
      'Saved "Frontend Agent" · gpt-5 · 1 MCP · 1 skills',
    );
    expect(agentSaveSuccessNoticeState({ config, locale: "zh" })).toEqual({
      text: "已保存「Frontend Agent」配置 · gpt-5 · 1 MCP · 1 Skill",
      tone: "success",
    });
    expect(agentSaveFallbackError("zh")).toBe("保存智能体配置失败");
    expect(agentSaveFailureNoticeState(null, "en")).toEqual({
      text: "Unable to save agent config",
      tone: "warning",
    });
    expect(agentSaveFailureNoticeState(new Error("denied"), "zh")).toEqual({
      text: "denied",
      tone: "warning",
    });
  });

  it("builds agent creation loading state", () => {
    expect(buildAgentCreateLoadingPanelContent("en")).toEqual({
      body: "Reading models, permissions, MCP, and skills...",
      error: undefined,
    });

    expect(buildAgentCreateLoadingPanelContent("zh")).toEqual({
      body: "正在读取模型、权限、MCP 和 Skill...",
      error: undefined,
    });
    expect(
      buildAgentCreateLoadingPanel(
        {
          kind: "agents",
          title: "Agents",
          subtitle: "Library",
          items: [{ title: "Existing", meta: "old" }],
        },
        "en",
      ),
    ).toEqual({
      kind: "agents",
      title: "Agents",
      subtitle: "Library",
      body: "Reading models, permissions, MCP, and skills...",
      items: [{ title: "Existing", meta: "old" }],
      error: undefined,
    });
    expect(buildAgentCreateLoadingPanel(null, "en")).toBeNull();
  });

  it("builds created agent panels", () => {
    const config = agentConfig({ agentId: "agent-1" });

    expect(
      buildAgentCreatePanelContent({
        config,
        configError: undefined,
        configPath: "/repo/.crewon/agents/frontend.json",
        locale: "en",
      }),
    ).toEqual({
      title: "Frontend Agent",
      subtitle: "Agent configuration",
      body: "Created backend agent record: /repo/.crewon/agents/frontend.json",
      actions: undefined,
      items: [],
      agentConfig: config,
      error: undefined,
    });

    expect(
      buildAgentCreatePanelContent({
        config,
        configError: "capability read failed",
        configPath: null,
        locale: "zh",
      }),
    ).toEqual({
      title: "Frontend Agent",
      subtitle: "智能体配置",
      body: undefined,
      actions: undefined,
      items: [],
      agentConfig: config,
      error: "capability read failed",
    });
    expect(
      buildAgentCreatePanel(
        {
          kind: "agents",
          title: "Agents",
          subtitle: "Library",
          items: [{ title: "Existing", meta: "old" }],
        },
        {
          config,
          configError: undefined,
          configPath: "/repo/.crewon/agents/frontend.json",
          locale: "en",
        },
      ),
    ).toEqual({
      kind: "agents",
      title: "Frontend Agent",
      subtitle: "Agent configuration",
      body: "Created backend agent record: /repo/.crewon/agents/frontend.json",
      actions: undefined,
      items: [],
      agentConfig: config,
      error: undefined,
    });
    expect(buildAgentCreatePanel(null, {
      config,
      configError: undefined,
      configPath: null,
      locale: "en",
    })).toBeNull();
    expect(agentCreateCapabilityFallbackError("zh")).toBe(
      "读取后端智能体能力失败",
    );
    expect(agentCreateRecordFallbackError("en")).toBe(
      "Unable to create backend agent record",
    );
    expect(agentCreateErrorMessage(new Error("offline"), "fallback")).toBe(
      "offline",
    );
    expect(agentCreateErrorMessage(null, "fallback")).toBe("fallback");
  });

  it("builds basic agent config panels", () => {
    expect(buildAgentConfigPanelContent(agentAction(), "en")).toEqual({
      title: "Frontend Agent",
      subtitle: "Agent configuration",
      body: undefined,
      actions: undefined,
      items: [],
      agentConfig: agentConfig(),
    });
  });

  it("builds agent config lifecycle patches", () => {
    const content = buildAgentConfigPanelContent(
      agentAction({ config: agentConfig({ threadId: "thread-1" }) }),
      "en",
    );

    expect(agentConfigPanelPatch(content)).toEqual({
      title: "Frontend Agent",
      subtitle: "Agent configuration",
      body: undefined,
      actions: undefined,
      items: content.items,
      agentConfig: content.agentConfig,
      error: undefined,
    });
    expect(
      agentConfigPanel(
        {
          kind: "agents",
          title: "Agents",
          subtitle: "Library",
          items: [],
          error: "old error",
        },
        content,
      ),
    ).toEqual({
      kind: "agents",
      title: "Frontend Agent",
      subtitle: "Agent configuration",
      body: undefined,
      actions: undefined,
      items: content.items,
      agentConfig: content.agentConfig,
      error: undefined,
    });
    expect(
      agentConfigHydratedPatch({
        config: agentConfig({ name: "Latest Agent" }),
        locale: "en",
      }),
    ).toEqual({
      title: "Latest Agent",
      agentConfig: agentConfig({ name: "Latest Agent" }),
      items: [],
      error: undefined,
    });
    expect(
      agentConfigHydratedPatch({
        config: agentConfig({ name: "Latest Agent", threadId: "thread-1" }),
        locale: "en",
        thread: thread({
          turns: [
            turn({
              items: [
                {
                  type: "agentMessage",
                  id: "item-1",
                  text: "Saved config",
                  phase: null,
                  memoryCitation: null,
                },
              ],
            }),
          ],
        }),
      }).items,
    ).toEqual([
      {
        title: "Backend records",
        meta: "1 saves",
        description: "Recent backend records loaded from the app-server agent thread.",
        section: true,
      },
      {
        title: "Config record 1",
        meta: "Completed · 01/01, 08:00 AM · 1 items",
        description: "Response: Saved config",
        glyph: "✓",
        accent: "green",
      },
    ]);
    expect(agentConfigHydrateFailurePatch(null, "zh")).toEqual({
      error: "读取智能体后端记录失败",
    });
    expect(agentConfigHydrateFailurePatch(new Error("denied"), "en")).toEqual({
      error: "denied",
    });
  });

  it("applies agent config hydrate patches only to the selected agent panel", () => {
    const panel = {
      kind: "agents" as const,
      title: "Frontend Agent",
      subtitle: "Agent configuration",
      items: [],
      agentConfig: agentConfig(),
    };

    expect(
      agentConfigHydratedPanel(panel, "Frontend Agent", {
        config: agentConfig({ name: "Latest Agent" }),
        locale: "en",
      }),
    ).toEqual({
      ...panel,
      title: "Latest Agent",
      agentConfig: agentConfig({ name: "Latest Agent" }),
      items: [],
      error: undefined,
    });
    expect(
      agentConfigHydratedPanel(panel, "Other Agent", {
        config: agentConfig({ name: "Latest Agent" }),
        locale: "en",
      }),
    ).toBe(panel);
    expect(
      agentConfigHydrateFailurePanel(panel, "Frontend Agent", null, "zh"),
    ).toEqual({
      ...panel,
      error: "读取智能体后端记录失败",
    });
    expect(agentConfigHydrateFailurePanel(null, "Frontend Agent", null, "en"))
      .toBeNull();
  });

  it("updates editable agent config state", () => {
    const panel = {
      kind: "agents" as const,
      title: "Frontend Agent",
      subtitle: "Agent configuration",
      items: [],
      body: "Existing body",
      agentConfig: agentConfig(),
    };

    expect(agentConfigUpdatedPanel(panel, { model: "gpt-5.1" })).toEqual({
      ...panel,
      agentConfig: {
        ...agentConfig(),
        model: "gpt-5.1",
      },
    });
    expect(agentCapabilityToggledPanel(panel, "mcp", "db")).toEqual({
      ...panel,
      agentConfig: {
        ...agentConfig(),
        mcp: [
          {
            id: "git",
            name: "Git",
            glyph: "⌁",
            accent: "green",
            description: "Git tools",
            enabled: true,
          },
          {
            id: "db",
            name: "Database",
            glyph: "▣",
            accent: "violet",
            description: "DB tools",
            enabled: true,
          },
        ],
      },
    });
    expect(
      agentConfigSavedPanel(panel, {
        agentId: "agent-1",
        configPath: "/repo/.crewon/agents/frontend.json",
        locale: "en",
        threadId: "thread-1",
      }),
    ).toEqual({
      ...panel,
      body: "Agent config written: /repo/.crewon/agents/frontend.json",
      agentConfig: {
        ...agentConfig(),
        agentId: "agent-1",
        threadId: "thread-1",
      },
    });
    expect(
      agentConfigSavedPanel(panel, {
        agentId: null,
        configPath: null,
        locale: "en",
        threadId: "thread-1",
      })?.body,
    ).toBe("Existing body");
    expect(agentConfigUpdatedPanel(null, { model: "gpt-5.1" })).toBeNull();
    expect(
      agentCapabilityToggledPanel(
        { kind: "agents", title: "Agents", subtitle: "Library", items: [] },
        "skills",
        "review",
      ),
    ).toEqual({
      kind: "agents",
      title: "Agents",
      subtitle: "Library",
      items: [],
    });
  });

  it("updates saved agent history", () => {
    const panel = {
      kind: "agents" as const,
      title: "Frontend Agent",
      subtitle: "Agent configuration",
      items: [{ title: "Existing", meta: "old" }],
      agentConfig: agentConfig(),
    };

    expect(agentConfigHistoryPanel(panel, null, "en")).toEqual(panel);
    expect(
      agentConfigHistoryPanel(
        panel,
        thread({
          turns: [
            turn({
              items: [
                {
                  type: "agentMessage",
                  id: "item-1",
                  text: "Saved config",
                  phase: null,
                  memoryCitation: null,
                },
              ],
            }),
          ],
        }),
        "en",
      )?.items,
    ).toEqual([
      {
        title: "Backend records",
        meta: "1 saves",
        description:
          "Recent backend records loaded from the app-server agent thread.",
        section: true,
      },
      {
        title: "Config record 1",
        meta: "Completed · 01/01, 08:00 AM · 1 items",
        description: "Response: Saved config",
        glyph: "✓",
        accent: "green",
      },
    ]);
  });

  it("adds backend record actions", () => {
    expect(
      buildAgentConfigPanelContent(
        agentAction({ configPath: "/repo/.crewon/agents/frontend.json" }),
        "zh",
      ).actions,
    ).toEqual([
      {
        id: "open-path",
        label: "打开后端记录",
        pathToOpen: "/repo/.crewon/agents/frontend.json",
        pathKind: "file",
      },
      {
        id: "delete-config-file",
        label: "删除后端记录",
        pathToOpen: "/repo/.crewon/agents/frontend.json",
        pathKind: "file",
        domainConfigKind: "agent",
        tone: "danger",
      },
    ]);
  });

  it("shows initial history loading state for thread-backed agents", () => {
    expect(
      buildAgentConfigPanelContent(
        agentAction({ config: agentConfig({ threadId: "thread-1" }) }),
        "en",
      ).items,
    ).toEqual([
      {
        title: "Reading backend records",
        meta: "app-server",
        description: "Loading recent configuration records from the agent thread.",
        glyph: "◷",
        accent: "blue",
      },
    ]);
  });
});
