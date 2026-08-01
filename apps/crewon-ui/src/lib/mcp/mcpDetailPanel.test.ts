import { describe, expect, it } from "vitest";

import type { McpDetailAction } from "../domain/crewonDomain";
import {
  buildMcpDetailPanelContent,
  mcpBackendToolEventPrompt,
  mcpDetailContentPanel,
  mcpDetailContentPatch,
  mcpToolEmptyHistoryPanel,
  mcpToolHistoryFailurePanel,
  mcpToolHistoryFailurePatch,
  mcpToolHistoryPanel,
  mcpToolHistoryPatch,
  mcpToolThreadGoal,
  mcpToolThreadTitle,
  mcpToolThreadTitleForNames,
} from "./mcpDetailPanel";

function mcpAction(overrides: Partial<McpDetailAction> = {}): McpDetailAction {
  return {
    type: "mcp-detail",
    title: "GitHub MCP",
    subtitle: "github",
    body: "MCP server details",
    ...overrides,
  };
}

function panel() {
  return {
    kind: "tools" as const,
    title: "GitHub MCP",
    subtitle: "github",
    body: "Existing",
    items: [{ title: "existing", meta: "history", description: "keep" }],
    actions: [
      { id: "open-thread" as const, label: "Old thread", threadId: "old" },
      { id: "call-mcp-tool" as const, label: "Call", mcpToolName: "search" },
    ],
    error: "old error",
  };
}

describe("mcp detail panel content", () => {
  it("exposes persisted MCP config as an editable form", () => {
    const content = buildMcpDetailPanelContent(
      mcpAction({
        configName: "github",
        config: {
          url: "https://api.githubcopilot.com/mcp/",
          bearer_token_env_var: "GITHUB_PAT_TOKEN",
          enabled: false,
        },
      }),
      "zh",
    );

    expect(content.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mcp-draft-name", value: "github" }),
        expect.objectContaining({
          id: "mcp-draft-config",
          value: expect.stringContaining("api.githubcopilot.com"),
        }),
      ]),
    );
    expect(content.actions?.[0]).toMatchObject({
      id: "save-mcp-config",
      label: "保存更改",
    });
  });

  it("builds MCP detail lifecycle patches", () => {
    expect(
      mcpDetailContentPatch(
        {
          title: "GitHub MCP",
          subtitle: "github",
          body: "MCP server details",
        },
        [{ title: "existing", meta: "history", description: "keep" }],
      ),
    ).toEqual({
      title: "GitHub MCP",
      subtitle: "github",
      body: "MCP server details",
      fields: undefined,
      actions: undefined,
      items: [{ title: "existing", meta: "history", description: "keep" }],
      error: undefined,
    });
    expect(
      mcpToolThreadTitle(
        {
          server: "github",
          name: "search_issues",
          label: "Search issues",
          inputSchema: "{}",
        },
        "en",
      ),
    ).toBe("Tool check · github.search_issues");
    expect(mcpToolThreadTitleForNames("github", "search_issues", "zh")).toBe(
      "工具验证 · github.search_issues",
    );
    expect(mcpToolThreadGoal("github", "search_issues", "en")).toBe(
      "Verify backend MCP tool call result for github.search_issues.",
    );
    expect(mcpBackendToolEventPrompt("Record", "Body")).toBe("Record\n\nBody");
    expect(
      mcpToolHistoryPatch({
        currentActions: [
          { id: "open-thread", label: "Old thread", threadId: "old" },
          { id: "call-mcp-tool", label: "Call", mcpToolName: "search" },
        ],
        items: [{ title: "history", meta: "1 record", description: "done" }],
        locale: "zh",
        threadId: "thread-1",
      }),
    ).toEqual({
      actions: [
        {
          id: "open-thread",
          label: "打开工具验证线程",
          threadId: "thread-1",
        },
        { id: "call-mcp-tool", label: "Call", mcpToolName: "search" },
      ],
      items: [{ title: "history", meta: "1 record", description: "done" }],
      error: undefined,
    });
    expect(mcpToolHistoryFailurePatch(null, "en")).toEqual({
      error: "Unable to read tool call history",
    });
    expect(mcpToolHistoryFailurePatch(new Error("denied"), "zh")).toEqual({
      error: "denied",
    });
  });

  it("patches matching MCP detail panels", () => {
    expect(
      mcpDetailContentPanel(panel(), {
        title: "GitHub MCP",
        subtitle: "github",
        body: "MCP server details",
      }),
    ).toEqual({
      ...panel(),
      body: "MCP server details",
      fields: undefined,
      actions: undefined,
      error: undefined,
    });
    expect(
      mcpToolEmptyHistoryPanel(
        panel(),
        { title: "GitHub MCP", subtitle: "github" },
        "en",
      ),
    ).toEqual({
      ...panel(),
      items: [
        {
          title: "No call history",
          meta: "Waiting for first call",
          description:
            "Call an MCP tool or read a resource to write results into the backend tool verification thread.",
          glyph: "◷",
          accent: "slate",
        },
      ],
    });
    expect(
      mcpToolHistoryPanel(
        panel(),
        { title: "GitHub MCP", subtitle: "github" },
        {
          items: [{ title: "history", meta: "1 record", description: "done" }],
          locale: "en",
          threadId: "thread-1",
        },
      ),
    ).toEqual({
      ...panel(),
      actions: [
        {
          id: "open-thread",
          label: "Open tool verification thread",
          threadId: "thread-1",
        },
        { id: "call-mcp-tool", label: "Call", mcpToolName: "search" },
      ],
      items: [{ title: "history", meta: "1 record", description: "done" }],
      error: undefined,
    });
    expect(
      mcpToolHistoryFailurePanel(
        panel(),
        { title: "GitHub MCP", subtitle: "github" },
        null,
        "zh",
      ),
    ).toEqual({
      ...panel(),
      error: "读取工具调用记录失败",
    });
    expect(
      mcpToolHistoryPanel(
        panel(),
        { title: "Other", subtitle: "github" },
        {
          items: [{ title: "history", meta: "1 record", description: "done" }],
          locale: "en",
          threadId: "thread-1",
        },
      ),
    ).toEqual(panel());
    expect(
      mcpToolHistoryFailurePanel(
        null,
        { title: "GitHub MCP", subtitle: "github" },
        null,
        "en",
      ),
    ).toBeNull();
  });

  it("builds resource, tool, config, field, and loading items", () => {
    const content = buildMcpDetailPanelContent(
      mcpAction({
        resource: {
          server: "github",
          uri: "repo://issues",
          label: "Issues",
        },
        tool: {
          server: "github",
          name: "search_issues",
          label: "Search issues",
          inputSchema: '{"type":"object"}',
        },
        configName: "github",
        configPath: "/repo/.codex/mcp/github.toml",
      }),
      "en",
    );

    expect(content).toEqual({
      title: "GitHub MCP",
      subtitle: "github",
      body: [
        "MCP server details",
        "",
        "Default callable tool",
        "Search issues (search_issues)",
        "inputSchema:",
        '{"type":"object"}',
      ].join("\n"),
      fields: [
        {
          id: "mcp-tool-arguments",
          label: "Tool arguments JSON",
          placeholder: "{\n}",
          value: "{}",
        },
      ],
      actions: [
        {
          id: "read-mcp-resource",
          label: "Read resource: Issues",
          mcpResourceServer: "github",
          mcpResourceUri: "repo://issues",
          tone: "primary",
        },
        {
          id: "call-mcp-tool",
          label: "Call tool: Search issues",
          mcpServerName: "github",
          mcpToolName: "search_issues",
          tone: "primary",
        },
        {
          id: "delete-mcp-config",
          label: "Delete MCP config",
          mcpServerName: "github",
          tone: "danger",
        },
        {
          id: "open-path",
          label: "Open backend record",
          pathToOpen: "/repo/.codex/mcp/github.toml",
          pathKind: "file",
        },
        {
          id: "delete-config-file",
          label: "Delete tool-library record only",
          pathToOpen: "/repo/.codex/mcp/github.toml",
          pathKind: "file",
          domainConfigKind: "tool",
          tone: "danger",
        },
      ],
      items: [
        {
          title: "Reading call history",
          meta: "app-server",
          description:
            "Loading recent calls from the tool verification thread.",
          glyph: "◷",
          accent: "blue",
        },
      ],
    });
  });

  it("adds login action and leaves resource/tool actions secondary while logged out", () => {
    expect(
      buildMcpDetailPanelContent(
        mcpAction({
          authStatus: "notLoggedIn",
          resource: {
            server: "github",
            uri: "repo://issues",
            label: "Issues",
          },
          tool: {
            server: "github",
            name: "search_issues",
            label: "Search issues",
            inputSchema: "{}",
          },
        }),
        "zh",
      ).actions,
    ).toEqual([
      {
        id: "login-mcp-oauth",
        label: "登录服务",
        mcpServerName: "github",
        tone: "primary",
      },
      {
        id: "read-mcp-resource",
        label: "读取资源：Issues",
        mcpResourceServer: "github",
        mcpResourceUri: "repo://issues",
        tone: undefined,
      },
      {
        id: "call-mcp-tool",
        label: "调用工具：Search issues",
        mcpServerName: "github",
        mcpToolName: "search_issues",
        tone: undefined,
      },
    ]);
  });

  it("omits optional presentation when no actionable MCP details exist", () => {
    expect(buildMcpDetailPanelContent(mcpAction(), "en")).toEqual({
      title: "GitHub MCP",
      subtitle: "github",
      body: "MCP server details",
      fields: undefined,
      actions: undefined,
      items: undefined,
    });
  });
});
