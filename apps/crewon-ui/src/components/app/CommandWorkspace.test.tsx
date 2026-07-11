import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@crewon-protocol/v2/Thread";

import {
  activateDesignPanelTab,
  applyDesignCardVisibility,
  cleanSlotTitle,
  commandComposerKeyIntent,
  CommandWorkspace,
  insertTokenIntoComposerValue,
  selectCommandHomeSlots,
  setDefaultTeamOfficePreview,
  setActiveFilter,
  syncDesignFilterState,
} from "./CommandWorkspace";
import { ResourceDock } from "./CommandWorkspaceChrome";
import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";

function snapshot(): AgentPlatformSnapshot {
  return {
    agents: [
      {
        id: 1,
        name: "Plain Agent",
        model_info: { model_name: "qwen-lite" },
        is_active: true,
      },
      {
        id: 2,
        name: "Delivery Agent",
        description: "Has all bindings.",
        model_info: { model_name: "qwen-plus" },
        knowledge_base_ids: [10],
        skill_ids: [20],
        mcp_servers: ["filesystem"],
        is_active: true,
      },
    ],
    knowledgeBases: [
      {
        id: 10,
        name: "Delivery Knowledge",
        document_count: 3,
        embedding_model: "text-embedding-v2",
      },
    ],
    skills: [
      {
        id: 20,
        name: "Schema 校验",
        description: "Validate schema.",
      },
      {
        id: 21,
        name: "交付检查 Skill",
        description: "Check delivery.",
      },
      {
        id: 22,
        name: "Unused Skill",
      },
    ],
    mcpServers: [
      {
        id: 30,
        name: "filesystem",
        alias: "Filesystem MCP",
        description: "Read files.",
      },
      {
        id: 31,
        name: "http-tools",
        alias: "HTTP Tools",
      },
      {
        id: 32,
        name: "unused",
      },
    ],
    mcpTools: [],
    workflows: [
      {
        id: 40,
        name: "普通流程",
      },
      {
        id: 41,
        name: "Workflow Gate",
        description: "Gate approval.",
      },
    ],
  };
}

describe("selectCommandHomeSlots", () => {
  it("selects real platform resources only for the design palettes", () => {
    const slots = selectCommandHomeSlots(snapshot());

    expect(slots.agent.title).toBe("Delivery Agent");
    expect(slots.model).toBe("qwen-plus");
    expect(slots.workflow.title).toBe("Workflow Gate");
    expect(slots.knowledge.title).toBe("Delivery Knowledge");
    expect(slots.skills.map((item) => item.title)).toEqual([
      "Schema 校验",
      "交付检查 Skill",
    ]);
    expect(slots.mcps.map((item) => item.title)).toEqual([
      "Filesystem MCP",
      "HTTP Tools",
    ]);
  });

  it("cleans low-quality test resource names before placing them in palettes", () => {
    const slots = selectCommandHomeSlots({
      ...snapshot(),
      agents: [
        {
          id: 3,
          name: "测试12333",
          model_info: { model_name: "qwen-plus" },
          is_active: true,
        },
      ],
      skills: [
        { id: 20, name: "测试技能" },
        { id: 21, name: "12345" },
      ],
      mcpServers: [
        { id: 30, name: "test-mcp" },
        { id: 31, name: "filesystem" },
      ],
    });

    expect(slots.agent.title).toBe("产品审阅智能体");
    expect(slots.skills.map((item) => item.title)).toEqual([
      "页面审阅 Skill",
      "交付检查 Skill",
    ]);
    expect(slots.mcps.map((item) => item.title)).toEqual([
      "Filesystem MCP",
      "Screenshot MCP",
    ]);
    expect(cleanSlotTitle("Delivery Agent", "Fallback")).toBe("Delivery Agent");
  });
});

describe("CommandWorkspace", () => {
  afterEach(() => {
    if (typeof document !== "undefined") {
      document.body.classList.remove("modal-open");
    }
  });

  function commandWorkspaceElement() {
    return (
      <CommandWorkspace
        composerValue=""
        connectionState="disconnected"
        cwd="C:\\Users\\admin\\Documents\\crewon"
        isSending={false}
        modelOptions={[
          { label: "gpt-5.6-sol", value: "gpt-5.6-sol" },
          { detail: "GPT 5.5", label: "gpt-5.5", value: "gpt-5.5" },
        ]}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />
    );
  }

  function renderCommandWorkspace() {
    return renderToStaticMarkup(commandWorkspaceElement());
  }

  it("inserts slash command tokens without losing mention syntax", () => {
    expect(
      insertTokenIntoComposerValue({
        prefix: "/",
        token: "$review",
        value: "检查主页",
      }),
    ).toBe("检查主页 $review ");
    expect(
      insertTokenIntoComposerValue({
        prefix: "@",
        token: "Agent 小队交付空间",
        value: "",
      }),
    ).toBe("@Agent 小队交付空间 ");
  });

  it("maps command composer keyboard shortcuts for chat-style sending", () => {
    const baseEvent = {
      altKey: false,
      composerValue: "继续推进",
      ctrlKey: false,
      hasOpenPalette: false,
      isComposing: false,
      key: "Enter",
      metaKey: false,
      shiftKey: false,
    };

    expect(commandComposerKeyIntent(baseEvent)).toBe("send");
    expect(commandComposerKeyIntent({ ...baseEvent, shiftKey: true })).toBeNull();
    expect(commandComposerKeyIntent({ ...baseEvent, altKey: true })).toBeNull();
    expect(commandComposerKeyIntent({ ...baseEvent, ctrlKey: true })).toBe(
      "send",
    );
    expect(commandComposerKeyIntent({ ...baseEvent, isComposing: true })).toBeNull();
    expect(
      commandComposerKeyIntent({ ...baseEvent, hasOpenPalette: true }),
    ).toBeNull();
    expect(
      commandComposerKeyIntent({
        ...baseEvent,
        hasOpenPalette: true,
        key: "Escape",
      }),
    ).toBe("closePalette");
    expect(commandComposerKeyIntent({ ...baseEvent, key: "@" })).toBe(
      "openContext",
    );
    expect(
      commandComposerKeyIntent({
        ...baseEvent,
        composerValue: "调用 ",
        key: "/",
      }),
    ).toBe("openSlash");
    expect(
      commandComposerKeyIntent({
        ...baseEvent,
        composerValue: "http://example.com/",
        key: "/",
      }),
    ).toBeNull();
  });

  it("renders the original desktop command shell and clean Chinese copy", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain('class="desktop-window command-window"');
    expect(markup).toContain('class="command-sidebar"');
    expect(markup).toContain('class="command-canvas"');
    expect(markup).toContain('class="shell-view command-home-view active"');
    expect(markup).toContain("\u521b\u5efa\u53ef\u7f16\u6392\u7684 Agent \u5c0f\u961f");
    expect(markup).toContain("\u4f8b\u5982\uff1a\u6574\u7406\u4eca\u5929\u7684\u9879\u76ee\u4e8b\u9879");
    expect(markup).not.toContain("????");
  });

  it("renders only real workspaces and conversations in the sidebar", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain("新建会话");
    expect(markup).toContain("新增空间");
    expect(markup).toContain("文件夹路径");
    expect(markup).toContain("工作空间");
    expect(markup).toContain('aria-controls="current-workspace-thread-list"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('id="current-workspace-thread-list"');
    expect(markup).toContain("crewon");
    expect(markup).not.toContain("建议任务");
    expect(markup).not.toContain('data-od-id="workspace-node-product"');
  });

  it("keeps only the original visible composer actions and hidden palette hooks", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain('class="icon-action prompt-action"');
    expect(markup).toContain('aria-label="\u8bed\u97f3\u8f93\u5165"');
    expect(markup).toContain('class="send-button"');
    expect(markup).toContain('data-context-open=""');
    expect(markup).toContain('data-slash-open=""');
    expect(markup).toContain("gpt-5.6-sol");
    expect(markup).toContain("gpt-5.5");
    expect(markup).toContain('data-value="gpt-5.6-sol"');
    expect(markup).not.toContain("自动选择");
    expect(markup).not.toContain("快速模型");
    expect(markup).not.toContain('class="icon-action context-trigger"');
    expect(markup).not.toContain('class="icon-action slash-trigger"');
  });

  it("renders shell views for sidebar navigation", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain('data-shell-view="assist"');
    expect(markup).toContain('data-shell-view="projects"');
    expect(markup).toContain('data-shell-view="agents"');
    expect(markup).toContain('data-shell-view="schedule"');
    expect(markup).toContain('data-shell-view="team"');
    expect(markup).toContain('data-run-title-zh="\u77e5\u8bc6\u5e93"');
  });

  it("includes original page-specific content for sidebar targets", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain("\u5df2\u8fde\u63a5\uff1a");
    expect(markup).toContain("Crewon \u52a9\u7406");
    expect(markup).toContain("\u5f53\u524d\u4efb\u52a1");
    expect(markup).toContain("Workflow \u6267\u884c\u961f\u5217");
    expect(markup).toContain("\u6267\u884c\u72b6\u6001\u673a");
    expect(markup).toContain("\u6280\u80fd\u00b7\u8fde\u63a5\u5668");
    expect(markup).toContain("\u8ba1\u5212\u00b7\u63d0\u9192");
    expect(markup).toContain("\u529e\u516c\u5ba4");
  });

  it("labels agent-platform fallback without implying app-server is down", () => {
    const markup = renderToStaticMarkup(
      <ResourceDock
        platformState="fallback"
        slots={selectCommandHomeSlots(snapshot())}
      />,
    );

    expect(markup).toContain("可选资源服务未启动，对话后端可用");
    expect(markup).not.toContain("资源服务未连接");
  });

  it("includes original schedule modal and filter landmarks", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain('data-shell-view="schedule"');
    expect(markup).toContain('data-filter-group="schedule-mode" data-filter="calendar"');
    expect(markup).toContain('data-filter-group="schedule-source" data-filter="teamflow"');
    expect(markup).toContain('data-od-id="schedule-calendar-team"');
    expect(markup).toContain('data-od-id="schedule-arrangement-catalog"');
    expect(markup).toContain('id="schedule-arrangement-modal"');
    expect(markup).toContain("创建任务安排");
    expect(markup).toContain("小队执行安排");
  });

  it("renders real slash commands as homepage palette candidates", () => {
    const command: ComposerSlashCommand = {
      id: "skill:review",
      kind: "skill",
      label: "Review Skill",
      meta: "Skill",
      description: "Review the page",
      token: "$review",
      mention: {
        kind: "skill",
        name: "Review Skill",
        path: "skills/review",
      },
    };
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        slashCommands={[command]}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
        onSlashCommandSelect={() => undefined}
      />,
    );

    expect(markup).toContain('data-slash-item=""');
    expect(markup).toContain('data-label="Review Skill"');
    expect(markup).toContain("Review the page");
  });

  it("renders real conversation history in the workspace tree", () => {
    const backendThread = {
      cwd: "/repo/frontend",
      id: "thread-backend-1",
      name: "Backend agent conversation",
      preview: "Tool and MCP run streamed from app-server",
      updatedAt: Math.floor(Date.now() / 1000),
    } as unknown as Thread;
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        linkedThreads={[backendThread]}
        selectedThreadId="thread-backend-1"
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSelectLinkedThread={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect(markup).toContain("工作空间");
    expect(markup).toContain("frontend");
    expect(markup).not.toContain("建议任务");
    expect(markup).not.toContain("后端会话");
    expect(markup).toContain('data-linked-thread-id="thread-backend-1"');
    expect(markup).toContain("Backend agent conversation");
    expect(markup).toContain("Tool and MCP run streamed from app-server");
  });

  it("renders workspace-less conversations in their own sidebar group", () => {
    const standaloneThread = {
      cwd: null,
      id: "thread-standalone-1",
      name: "Standalone conversation",
      preview: "No folder was attached to this chat",
      updatedAt: Math.floor(Date.now() / 1000),
    } as unknown as Thread;
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        linkedThreads={[standaloneThread]}
        selectedThreadId="thread-standalone-1"
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSelectLinkedThread={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect(markup).toContain("无工作空间");
    expect(markup).toContain('aria-controls="standalone-workspace-thread-list"');
    expect(markup).toContain('id="standalone-workspace-thread-list"');
    expect(markup).toContain('data-linked-thread-id="thread-standalone-1"');
    expect(markup).toContain("Standalone conversation");
    expect(markup).toContain("No folder was attached to this chat");
  });

  it("renders selected real conversations inside the command shell instead of leaving the shell", () => {
    const selectedThread = {
      id: "thread-command-room",
      name: "Command room transcript",
      preview: "Agent answered in the command shell",
      updatedAt: Math.floor(Date.now() / 1000),
      cwd: "/repo/frontend",
      turns: [
        {
          id: "turn-command-room",
          status: "completed",
          durationMs: 1_000,
          startedAt: 1,
          completedAt: 2,
          error: null,
          itemsView: "full",
          items: [
            {
              id: "item-user",
              type: "userMessage",
              clientId: null,
              content: [{ type: "text", text: "Run inside command shell" }],
            },
            {
              id: "item-agent",
              type: "agentMessage",
              text: "## Command response\n\n- [x] Stayed in shell",
              phase: null,
              memoryCitation: null,
            },
          ],
        },
      ],
    } as unknown as Thread;

    const markup = renderToStaticMarkup(
      <CommandWorkspace
        activeTurnId={null}
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        linkedThreads={[selectedThread]}
        selectedThread={selectedThread}
        selectedThreadId="thread-command-room"
        streamingText=""
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSelectLinkedThread={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );

    expect(markup).toContain('data-has-thread="true"');
    expect(markup).toContain('data-od-id="command-thread-room"');
    expect(markup).toContain('class="command-thread-identity"');
    expect(markup).toContain("Agent 对话");
    expect(markup).toContain(">工作空间 · frontend</em>");
    expect(markup).toContain("Command room transcript");
    expect(markup).toContain('class="transcript"');
    expect(markup).toContain('class="command-input thread-command-input"');
    expect(markup).toContain("内容由 AI 生成，请核实重要信息");
    expect(markup).toContain("Run inside command shell");
    expect(markup).toContain("Command response");
    expect(markup).toContain("task-list-item");
    expect(markup).not.toContain('class="app-shell"');
  });

  it("keeps Command, MCP, Skill, Markdown, and Mermaid output inside the command shell transcript", () => {
    const selectedThread = {
      id: "thread-command-tools",
      name: "Command tool transcript",
      preview: "MCP and Skill output",
      updatedAt: Math.floor(Date.now() / 1000),
      cwd: "/repo/frontend",
      turns: [
        {
          id: "turn-command-tools",
          status: "completed",
          durationMs: 1_000,
          startedAt: 1,
          completedAt: 2,
          error: null,
          itemsView: "full",
          items: [
            {
              id: "item-user-tools",
              type: "userMessage",
              clientId: null,
              content: [{ type: "text", text: "Run MCP and Skill checks" }],
            },
            {
              id: "item-mcp-tools",
              type: "mcpToolCall",
              server: "filesystem",
              tool: "read_file",
              status: "completed",
              arguments: { path: "README.md" },
              pluginId: null,
              result: {
                content: [
                  {
                    type: "text",
                    text: "## MCP result\n\n- [x] Read context",
                  },
                ],
                structuredContent: { ok: true },
                _meta: null,
              },
              error: null,
              durationMs: 120,
            },
            {
              id: "item-skill-tools",
              type: "dynamicToolCall",
              namespace: "skills",
              tool: "delivery-check",
              arguments: { target: "command-home" },
              status: "completed",
              contentItems: [
                {
                  type: "inputText",
                  text: "| Gate | State |\n| --- | --- |\n| Command shell | Pass |",
                },
              ],
              success: true,
              durationMs: 240,
            },
            {
              id: "item-command-tools",
              type: "commandExecution",
              command: "pnpm test -- CommandWorkspace",
              cwd: "/repo/frontend",
              processId: null,
              source: "agent",
              status: "completed",
              commandActions: [],
              aggregatedOutput: "Command workspace tests passed",
              exitCode: 0,
              durationMs: 1_200,
            },
            {
              id: "item-agent-tools",
              type: "agentMessage",
              text: "```mermaid\ngraph LR\n  Agent --> Tool\n```",
              phase: null,
              memoryCitation: null,
            },
          ],
        },
      ],
    } as unknown as Thread;

    const markup = renderToStaticMarkup(
      <CommandWorkspace
        activeTurnId={null}
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        linkedThreads={[selectedThread]}
        selectedThread={selectedThread}
        selectedThreadId="thread-command-tools"
        streamingText=""
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSelectLinkedThread={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );

    expect(markup).toContain('data-od-id="command-thread-room"');
    expect(markup).toContain('class="transcript"');
    expect(markup).toContain("MCP 1");
    expect(markup).toContain("Skill 1");
    expect(markup).toContain("命令 1");
    expect(markup).toContain("filesystem.read_file");
    expect(markup).toContain("已读取 1 个文件");
    expect(markup).toContain("README.md");
    expect(markup).toContain("skills.delivery-check");
    expect(markup).toContain("$ pnpm test -- CommandWorkspace");
    expect(markup).toContain("Command workspace tests passed");
    expect(markup).toContain("退出码 0");
    expect(markup).toContain("<table>");
    expect(markup).toContain("<td>Pass</td>");
    expect(markup).toContain('data-renderer="mermaid"');
    expect(markup).toContain("graph LR");
    expect(markup).not.toContain('class="app-shell"');
  });

  it("labels command composer input as steer guidance while an agent turn is running", () => {
    const runningThread = {
      id: "thread-running-command-room",
      name: "Running command room transcript",
      preview: "Agent is still working",
      updatedAt: Math.floor(Date.now() / 1000),
      cwd: "/repo/frontend",
      turns: [
        {
          id: "turn-running-command-room",
          status: "inProgress",
          durationMs: null,
          startedAt: 1,
          completedAt: null,
          error: null,
          itemsView: "full",
          items: [
            {
              id: "item-user-running",
              type: "userMessage",
              clientId: null,
              content: [{ type: "text", text: "Start a long task" }],
            },
          ],
        },
      ],
    } as unknown as Thread;

    const markup = renderToStaticMarkup(
      <CommandWorkspace
        activeTurnId="turn-running-command-room"
        composerValue="补充验收标准"
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        linkedThreads={[runningThread]}
        selectedThread={runningThread}
        selectedThreadId="thread-running-command-room"
        streamingText=""
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSelectLinkedThread={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );

    expect(markup).toContain("Agent 正在执行");
    expect(markup).toContain("继续补充指令");
    expect(markup).toContain('aria-label="发送补充指令"');
    expect(markup).toContain('title="发送补充指令"');
  });

  it("summarizes live backend agent work in the command transcript toolbar", () => {
    const runningThread = {
      id: "thread-live-agent-runtime",
      name: "Live agent runtime",
      preview: "MCP, Skill, command output, and streaming text",
      updatedAt: Math.floor(Date.now() / 1000),
      cwd: "/repo/frontend",
      turns: [
        {
          id: "turn-live-agent-runtime",
          status: "inProgress",
          durationMs: null,
          startedAt: 1,
          completedAt: null,
          error: null,
          itemsView: "full",
          items: [
            {
              id: "item-user-live",
              type: "userMessage",
              clientId: null,
              content: [{ type: "text", text: "Run a live agent flow" }],
            },
            {
              id: "item-mcp-live",
              type: "mcpToolCall",
              server: "filesystem",
              tool: "read_file",
              status: "completed",
              arguments: { path: "README.md" },
              pluginId: null,
              result: { content: [{ type: "text", text: "## MCP result" }] },
              error: null,
              durationMs: 240,
            },
            {
              id: "item-skill-live",
              type: "dynamicToolCall",
              namespace: "skill",
              tool: "code-review-system",
              arguments: { target: "homepage" },
              status: "inProgress",
              contentItems: null,
              success: null,
              durationMs: null,
            },
            {
              id: "item-command-live",
              type: "commandExecution",
              command: "pnpm test",
              cwd: "/repo/frontend",
              processId: null,
              source: "agent",
              status: "completed",
              commandActions: [],
              aggregatedOutput: "ok",
              exitCode: 0,
              durationMs: 1_200,
            },
          ],
        },
      ],
    } as unknown as Thread;

    const markup = renderToStaticMarkup(
      <CommandWorkspace
        activeTurnId="turn-live-agent-runtime"
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        linkedThreads={[runningThread]}
        selectedThread={runningThread}
        selectedThreadId="thread-live-agent-runtime"
        streamingText="正在实时生成最终回复"
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSelectLinkedThread={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );

    expect(markup).toContain('class="command-thread-runtime"');
    expect(markup).toContain('data-state="running"');
    expect(markup).toContain("实时渲染中");
    expect(markup).toContain("MCP 1");
    expect(markup).toContain("Skill 1");
    expect(markup).toContain("命令 1");
    expect(markup).toContain("正在实时生成最终回复");
  });

  it("makes sidebar search results actionable for real conversations and views", () => {
    const backendThread = {
      id: "thread-search-1",
      name: "Searchable conversation",
      preview: "Open this real app-server transcript",
      updatedAt: Math.floor(Date.now() / 1000),
    } as unknown as Thread;
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        linkedThreads={[backendThread]}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSelectLinkedThread={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect(markup).not.toContain('data-search-action="conversation"');
    expect(markup).toContain('data-search-action="thread"');
    expect(markup).toContain('data-search-action="view"');
    expect(markup).toContain('data-thread-id="thread-search-1"');
    expect(markup).toContain("Searchable conversation");
    expect(markup).toContain("Open this real app-server transcript");
  });

  it("filters schedule cards like the original design runtime", () => {
    if (typeof document === "undefined") {
      return;
    }
    const scope = document.createElement("section");
    scope.innerHTML = `
      <button class="filter-chip active" data-filter-group="schedule-mode" data-filter="calendar"></button>
      <button class="filter-chip" data-filter-group="schedule-mode" data-filter="arrangement"></button>
      <button class="filter-chip" data-filter-group="schedule-source" data-filter="personal"></button>
      <button class="filter-chip active" data-filter-group="schedule-source" data-filter="teamflow"></button>
      <article data-card-filter="calendar personal" data-card="personal-calendar"></article>
      <article data-card-filter="calendar teamflow" data-card="team-calendar"></article>
      <article data-card-filter="arrangement personal" data-card="personal-arrangement"></article>
      <article data-card-filter="arrangement teamflow" data-card="team-arrangement"></article>
    `;

    syncDesignFilterState(scope);
    expect(scope.querySelector<HTMLElement>('[data-card="team-calendar"]')?.hidden).toBe(false);
    expect(scope.querySelector<HTMLElement>('[data-card="personal-calendar"]')?.hidden).toBe(true);
    expect(scope.querySelector<HTMLElement>('[data-card="personal-arrangement"]')?.hidden).toBe(
      true,
    );
    expect(scope.querySelector<HTMLElement>('[data-card="team-arrangement"]')?.hidden).toBe(true);

    setActiveFilter(scope, "schedule-mode", "arrangement");
    expect(scope.querySelector<HTMLElement>('[data-card="team-calendar"]')?.hidden).toBe(true);
    expect(scope.querySelector<HTMLElement>('[data-card="team-arrangement"]')?.hidden).toBe(false);

    setActiveFilter(scope, "schedule-source", "personal");
    expect(scope.querySelector<HTMLElement>('[data-card="team-arrangement"]')?.hidden).toBe(true);
    expect(scope.querySelector<HTMLElement>('[data-card="personal-arrangement"]')?.hidden).toBe(
      false,
    );
  });

  it("applies catalog search on top of active filters", () => {
    if (typeof document === "undefined") {
      return;
    }
    const scope = document.createElement("section");
    scope.innerHTML = `
      <label class="catalog-search"><input value="Code Review"></label>
      <button class="filter-chip active" data-filter="calendar"></button>
      <article data-card-filter="calendar">Code Review 安排</article>
      <article data-card-filter="calendar">个人周报草稿</article>
    `;

    applyDesignCardVisibility(scope);
    expect(scope.querySelectorAll<HTMLElement>("[data-card-filter]")[0]?.hidden).toBe(false);
    expect(scope.querySelectorAll<HTMLElement>("[data-card-filter]")[1]?.hidden).toBe(true);
  });

  it("resets team page to the original office list state without showing inline rooms", () => {
    if (typeof document === "undefined") {
      return;
    }
    const view = document.createElement("section");
    view.setAttribute("data-shell-view", "team");
    view.innerHTML = `
      <div data-filter-scope>
        <button class="filter-chip active" data-filter-group="team-mode" data-filter="workflow"></button>
        <button class="filter-chip" data-filter-group="team-mode" data-filter="office"></button>
        <section data-card-filter="office" data-office-shell class="team-office-shell is-room-open">
          <div data-office-list hidden></div>
          <section data-office-room></section>
          <aside data-office-drawer="members"></aside>
          <button data-office-drawer-open="members" aria-expanded="true"></button>
        </section>
        <section data-card-filter="workflow" data-workflow-shell class="team-workflow-shell is-room-open">
          <div data-workflow-list hidden></div>
          <section data-workflow-room></section>
          <aside data-workflow-drawer="members"></aside>
          <button data-workflow-drawer-open="members" aria-expanded="true"></button>
        </section>
      </div>
    `;
    view.classList.add("office-room-active", "workflow-room-active");

    setDefaultTeamOfficePreview(view);

    expect(view.querySelector<HTMLElement>("[data-office-list]")?.hidden).toBe(false);
    expect(view.querySelector<HTMLElement>("[data-office-room]")?.hidden).toBe(true);
    expect(view.querySelector<HTMLElement>("[data-workflow-list]")?.hidden).toBe(false);
    expect(view.querySelector<HTMLElement>("[data-workflow-room]")?.hidden).toBe(true);
    expect(view.querySelector<HTMLElement>("[data-office-shell]")?.classList.contains("is-room-open")).toBe(false);
    expect(view.querySelector<HTMLElement>("[data-workflow-shell]")?.classList.contains("is-room-open")).toBe(false);
    expect(view.classList.contains("office-room-active")).toBe(false);
    expect(view.classList.contains("workflow-room-active")).toBe(false);
    expect(view.querySelector<HTMLElement>('[data-office-drawer="members"]')?.hidden).toBe(true);
    expect(view.querySelector<HTMLElement>("[data-office-drawer-open]")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("switches room tab panels like the original design runtime", () => {
    if (typeof document === "undefined") {
      return;
    }
    const scope = document.createElement("section");
    scope.setAttribute("data-tab-scope", "");
    scope.innerHTML = `
      <button data-tab-target="#chat" class="active" aria-selected="true"></button>
      <button data-tab-target="#run" aria-selected="false"></button>
      <button data-tab-target="#memory" aria-selected="false"></button>
      <section id="chat" data-tab-panel></section>
      <section id="run" data-tab-panel hidden></section>
      <section id="memory" data-tab-panel hidden></section>
    `;
    const runTab = scope.querySelector<HTMLButtonElement>('[data-tab-target="#run"]');
    expect(runTab).not.toBeNull();

    if (runTab) {
      activateDesignPanelTab(runTab, scope);
    }

    expect(scope.querySelector<HTMLElement>('[data-tab-target="#chat"]')?.classList.contains("active")).toBe(false);
    expect(scope.querySelector<HTMLElement>('[data-tab-target="#run"]')?.classList.contains("active")).toBe(true);
    expect(scope.querySelector<HTMLElement>('[data-tab-target="#run"]')?.getAttribute("aria-selected")).toBe("true");
    expect(scope.querySelector<HTMLElement>("#chat")?.hidden).toBe(true);
    expect(scope.querySelector<HTMLElement>("#run")?.hidden).toBe(false);
    expect(scope.querySelector<HTMLElement>("#memory")?.hidden).toBe(true);
  });

});
