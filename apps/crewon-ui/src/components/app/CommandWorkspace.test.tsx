import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ProviderResourceSnapshot } from "../../lib/provider-resource/providerResourceSession";

import {
  activateDesignPanelTab,
  applyDesignCardVisibility,
  cleanSlotTitle,
  commandComposerResourceSelection,
  commandComposerKeyIntent,
  CommandWorkspace,
  type CommandWorkspaceControlNav,
  executionIntentAfterCommit,
  insertTokenIntoComposerValue,
  nextExecutionIntent,
  selectCommandHomeSlots,
  setDefaultTeamOfficePreview,
  setActiveFilter,
  shouldCreateCommandThread,
  shouldCloseComposerPalette,
  submitCommandComposer,
  syncDesignFilterState,
} from "./CommandWorkspace";
import { Palette } from "./CommandWorkspaceChrome";
import { commandComposerPermissionOptions } from "../composer/commandComposerPermissionOptions";
import {
  modelEffortGroups,
  modelEffortMenuOptions,
} from "../composer/composerModelEffortMenu";
import {
  commandLocalWorkspaceSlashItems,
  commandOnlineWorkspaceSlashItems,
  commandSceneSlashItems,
} from "./commandWorkspaceSceneResources";
import { providerAgentExecutionTargetOptions } from "../../lib/provider-resource/providerAgentExecutionTargets";
import { executionTargetOptionsFromDomain } from "../../lib/scene/sceneCatalog";
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
        downloaded: true,
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
        downloaded: true,
      },
    ],
    knowledgeBases: [
      {
        id: 10,
        name: "Delivery Knowledge",
        document_count: 3,
        embedding_model: "text-embedding-v2",
        downloaded: true,
      },
    ],
    skills: [
      {
        id: 20,
        name: "Schema 校验",
        description: "Validate schema.",
        downloaded: true,
      },
      {
        id: 21,
        name: "交付检查 Skill",
        description: "Check delivery.",
        downloaded: true,
      },
      {
        id: 22,
        name: "Unused Skill",
        downloaded: true,
      },
    ],
    mcpServers: [
      {
        id: 30,
        name: "filesystem",
        alias: "Filesystem MCP",
        description: "Read files.",
        downloaded: true,
      },
      {
        id: 31,
        name: "http-tools",
        alias: "HTTP Tools",
        downloaded: true,
      },
      {
        id: 32,
        name: "unused",
        downloaded: true,
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
          downloaded: true,
        },
      ],
      skills: [
        { id: 20, name: "测试技能", downloaded: true },
        { id: 21, name: "12345", downloaded: true },
      ],
      mcpServers: [
        { id: 30, name: "test-mcp", downloaded: true },
        { id: 31, name: "filesystem", downloaded: true },
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

describe("commandSceneSlashItems", () => {
  it("exposes the real packaged workspace Skill and MCP together", () => {
    expect(
      commandLocalWorkspaceSlashItems("zh").map((item) => ({
        execution: item.platformResource?.execution,
        kind: item.kind,
        title: item.title,
      })),
    ).toEqual([
      { execution: "local", kind: "skill", title: "工作区验收" },
      { execution: "local", kind: "mcp", title: "本地工作区" },
    ]);
  });

  it("exposes the connected online workspace as a selectable service", () => {
    const items = commandOnlineWorkspaceSlashItems("zh");

    expect(items).toEqual([
      expect.objectContaining({
        kind: "mcp",
        title: "在线工作区",
        platformResource: expect.objectContaining({
          execution: "local",
          name: "online-workspace",
        }),
      }),
    ]);
    expect(
      renderToStaticMarkup(
        <Palette
          id="online-workspace-menu"
          inputId="online-workspace-search"
          items={items}
          kind="add"
          open
          placeholder="添加资源"
          query=""
          onClose={() => undefined}
          onQueryChange={() => undefined}
          onSelect={() => undefined}
        />,
      ),
    ).toMatchSnapshot();
  });

  it("reserves palette capacity for MCP resources when many skills exist", () => {
    const platformSnapshot = snapshot();
    platformSnapshot.skills = Array.from({ length: 12 }, (_, index) => ({
      downloaded: true,
      id: 100 + index,
      is_enabled: true,
      name: `Skill ${index + 1}`,
      skill_md_content:
        index === 0 ? "# Release review\nCheck evidence." : null,
    }));
    platformSnapshot.agents[1] = {
      ...platformSnapshot.agents[1],
      api_enabled: true,
      skill_ids: platformSnapshot.skills.map((skill) => skill.id),
      mcp_servers: platformSnapshot.mcpServers.map((server) => server.id),
    };
    platformSnapshot.mcpServers = platformSnapshot.mcpServers.map((server) => ({
      ...server,
      is_connected: true,
      is_enabled: true,
    }));

    const items = commandSceneSlashItems(platformSnapshot, []);

    expect(items.filter((item) => item.kind === "skill")).toHaveLength(11);
    expect(
      items.filter((item) => item.kind === "mcp").map((item) => item.title),
    ).toEqual(["Filesystem MCP"]);
    expect(items.find((item) => item.kind === "skill")?.content).toContain(
      "Check evidence",
    );
  });
});

describe("CommandWorkspace", () => {
  // The schedule calendar marks today, so the markup snapshot drifts with the
  // wall clock. Pin the date to keep the snapshot reproducible.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00+08:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (typeof document !== "undefined") {
      document.body.classList.remove("modal-open");
    }
  });

  function commandWorkspaceElement(
    overrides: Partial<ComponentProps<typeof CommandWorkspace>> = {},
  ) {
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
        {...overrides}
      />
    );
  }

  function renderCommandWorkspace() {
    return renderToStaticMarkup(commandWorkspaceElement());
  }

  function controlWorkspaceNav(): CommandWorkspaceControlNav {
    return {
      name: "cuican-aide",
      busy: false,
      onClear: () => undefined,
      onSelect: () => undefined,
    };
  }

  function workspaceCommandThread(): Thread {
    return {
      id: "thread-command-room",
      name: "Command room transcript",
      preview: "Agent answered in the command shell",
      updatedAt: Math.floor(Date.now() / 1000),
      cwd: "/repo/frontend",
      turns: [],
    } as unknown as Thread;
  }

  function renderControlWorkspaceThread(): string {
    const selectedThread = workspaceCommandThread();
    return renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        controlWorkspaceNav={controlWorkspaceNav()}
        cwd="/repo/frontend"
        isSending={false}
        linkedThreads={[selectedThread]}
        selectedThread={selectedThread}
        selectedThreadId={selectedThread.id}
        workMode="code"
        workspaceAuthority="control"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSelectLinkedThread={() => undefined}
        onSend={() => undefined}
      />,
    );
  }

  it("uses the selected locale across the primary command shell", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="disconnected"
        cwd="/repo/frontend"
        isSending={false}
        locale="en"
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect({
      addContext: markup.includes('aria-label="Add context"'),
      commandHeading: markup.includes("Put CrewON to work"),
      languageMarker: markup.includes('data-locale="en"'),
      nav: ["New task", "Assistant", "Agents", "Schedule", "Team"].map(
        (label) => markup.includes(`<strong>${label}</strong>`),
      ),
      permissions: markup.includes('aria-label="Permissions"'),
      startTask: markup.includes('aria-label="Start task"'),
      workspaceTree: markup.includes(
        'aria-label="Workspaces and conversations"',
      ),
    }).toMatchSnapshot();
  });

  it("offers Provider execution resources only while creating their owning conversation", () => {
    const providerResource = {
      snapshot: providerSnapshot(),
      selectedResource: null,
      selectedWorkspaceKey: "workspace-1",
      canSelect: true,
      onRefresh: () => undefined,
      onSelect: () => undefined,
      onUnbind: () => undefined,
      onWorkspaceSelect: () => undefined,
    };
    const draft = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        providerResource={providerResource}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );
    const existingThread = {
      id: "thread-existing",
      turns: [],
    } as unknown as Thread;
    const existing = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        providerResource={providerResource}
        selectedThread={existingThread}
        selectedThreadId={existingThread.id}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect(draft).toContain("provider-mcp-tool");
    expect(existing).not.toContain("provider-mcp-tool");
  });

  it("snapshots a Provider Agent in the execution target selector, not the add palette", () => {
    const agent = {
      providerId: "agent-platform",
      resourceId: "review-agent",
      revision: "agent-revision-1",
      resourceType: "agent" as const,
    };
    const snapshot = providerSnapshot();
    snapshot.provider = snapshot.provider
      ? {
          ...snapshot.provider,
          capabilities: [...snapshot.provider.capabilities, "remoteAgent"],
          resourceCapabilities: [
            ...snapshot.provider.resourceCapabilities,
            {
              resourceType: "agent",
              mode: "providerManaged",
              executionLocation: "provider",
            },
          ],
        }
      : null;
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        providerResource={{
          snapshot,
          selectedResource: null,
          executionAgents: [agent],
          selectedExecutionAgent: null,
          selectedWorkspaceKey: "workspace-1",
          canSelect: true,
          onRefresh: () => undefined,
          onSelect: () => undefined,
          onExecutionAgentSelect: () => undefined,
          onUnbind: () => undefined,
          onWorkspaceSelect: () => undefined,
        }}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );
    const existingThread = {
      id: "thread-existing-provider-agent",
      turns: [],
    } as unknown as Thread;
    const existingThreadMarkup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        providerResource={{
          snapshot,
          selectedResource: null,
          executionAgents: [agent],
          selectedExecutionAgent: null,
          selectedWorkspaceKey: "workspace-1",
          canSelect: false,
          onRefresh: () => undefined,
          onSelect: () => undefined,
          onExecutionAgentSelect: () => undefined,
          onUnbind: () => undefined,
          onWorkspaceSelect: () => undefined,
        }}
        selectedThread={existingThread}
        selectedThreadId={existingThread.id}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );

    // The selector menu only renders while open, so the agent's presence among
    // the execution targets is asserted on the option config the select is fed
    // with; the markup assertions pin the trigger and the add-palette boundary.
    const targetOptions = providerAgentExecutionTargetOptions([agent]);
    expect(targetOptions).toEqual([
      expect.objectContaining({
        group: "single",
        kind: "agent",
        label: "review-agent",
      }),
    ]);
    expect(markup).toContain('aria-label="执行主体"');
    expect(existingThreadMarkup).toContain('aria-label="执行主体"');
    expect(markup).not.toContain("添加 review-agent");
    expect(markup).toMatchSnapshot();
  });

  it("maps platform Skill, MCP, and knowledge selections to structured composer resources", () => {
    expect(
      commandComposerResourceSelection({
        detail: "3 个文档",
        kind: "knowledge",
        label: "知识库",
        platformResource: {
          execution: "remote",
          id: 10,
          name: "产品知识库",
          type: "knowledge_bases",
        },
        title: "产品知识库",
      }),
    ).toEqual({
      kind: "knowledge",
      name: "产品知识库",
      platformResource: {
        execution: "remote",
        id: 10,
        name: "产品知识库",
        type: "knowledge_bases",
      },
    });
    expect(
      commandComposerResourceSelection({
        content: "Use the filesystem tools.",
        detail: "读取文件",
        kind: "mcp",
        label: "MCP",
        platformResource: {
          execution: "remote",
          id: 30,
          name: "filesystem",
          type: "mcp_servers",
        },
        title: "Filesystem MCP",
        token: "Filesystem MCP",
      }),
    ).toEqual({
      content: "Use the filesystem tools.",
      kind: "mcp",
      name: "Filesystem MCP",
      platformResource: {
        execution: "remote",
        id: 30,
        name: "filesystem",
        type: "mcp_servers",
      },
    });
  });

  it("shows selected Skill, MCP, and knowledge resources as composer tags", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue="检查这些资源"
        connectionState="connected"
        cwd="/repo"
        isSending={false}
        pendingComposerMentions={[
          {
            kind: "skill",
            name: "code-review",
            path: "/skills/code-review/SKILL.md",
            resourceKind: "skill",
          },
          {
            name: "Filesystem",
            path: "mcp://filesystem",
            resourceKind: "mcp",
          },
          {
            name: "产品知识库",
            path: "agent-platform://knowledge_bases/10",
            resourceKind: "knowledge",
          },
        ]}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect(markup).toContain('data-resource-kind="skill"');
    expect(markup).toContain('data-resource-kind="mcp"');
    expect(markup).toContain('data-resource-kind="knowledge"');
    expect(markup).toContain("code-review");
    expect(markup).toContain("Filesystem");
    expect(markup).toContain("产品知识库");
  });

  it("passes workspace cwd only when creating a new thread", () => {
    const existingThreadCalls: unknown[][] = [];
    const newThreadCalls: unknown[][] = [];
    const settings = { model: "gpt-5.5" };

    submitCommandComposer({
      cwd: "/srv/crewon-workspaces/agent-platform",
      onSend: (...args) => existingThreadCalls.push(args),
      onSendNewThread: (...args) => newThreadCalls.push(args),
      settings,
      shouldCreateNewThread: false,
      text: "继续处理",
    });
    submitCommandComposer({
      cwd: "/srv/crewon-workspaces/agent-platform",
      onSend: (...args) => existingThreadCalls.push(args),
      onSendNewThread: (...args) => newThreadCalls.push(args),
      settings,
      shouldCreateNewThread: true,
      text: "新建任务",
    });

    expect(existingThreadCalls).toEqual([["继续处理", settings]]);
    expect(newThreadCalls).toEqual([
      ["新建任务", settings, "/srv/crewon-workspaces/agent-platform"],
    ]);
  });

  it("creates a new authority thread before first Provider Agent execution", () => {
    const selectedThread = { id: "thread-1" } as Thread;

    expect(
      shouldCreateCommandThread({
        hasProviderAgentTarget: true,
        isProviderAgentBoundToSelectedThread: false,
        newTaskDraft: false,
        selectedThread,
      }),
    ).toBe(true);
    expect(
      shouldCreateCommandThread({
        hasProviderAgentTarget: true,
        isProviderAgentBoundToSelectedThread: true,
        newTaskDraft: false,
        selectedThread,
      }),
    ).toBe(false);
    expect(
      shouldCreateCommandThread({
        hasProviderAgentTarget: false,
        isProviderAgentBoundToSelectedThread: false,
        newTaskDraft: false,
        selectedThread,
      }),
    ).toBe(false);
  });

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
    expect(
      commandComposerKeyIntent({ ...baseEvent, shiftKey: true }),
    ).toBeNull();
    expect(commandComposerKeyIntent({ ...baseEvent, altKey: true })).toBeNull();
    expect(commandComposerKeyIntent({ ...baseEvent, ctrlKey: true })).toBe(
      "send",
    );
    expect(
      commandComposerKeyIntent({ ...baseEvent, isComposing: true }),
    ).toBeNull();
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

  it("renders the three-scene command shell and clean Chinese copy", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain('class="desktop-window command-window"');
    expect(markup).toContain('class="command-sidebar"');
    expect(markup).toContain('class="command-canvas"');
    expect(markup).toContain('class="shell-view command-home-view active"');
    expect(markup).toContain("让 CrewON 完成你的工作");
    expect(markup).toContain("整理、撰写和推进你的工作");
    expect(markup).toContain(
      "例如：整理今天的项目事项，安排会议、跟进阻塞，并把结论写入知识库",
    );
    expect(markup).toContain(">CrewON</span>");
    expect(markup).toContain("本地自动");
    expect(markup).toContain('aria-label="执行主体"');
    // The execution-target menu only renders while open; its empty state is
    // asserted on the option builder instead of the static markup.
    expect(
      executionTargetOptionsFromDomain({
        agents: [],
        locale: "zh",
        offices: [],
        status: "ready",
      }).map((option) => option.label),
    ).toContain("暂无可选智能体或小队");
    expect(markup).not.toContain("执行主体：");
    expect(markup).not.toContain('data-od-id="workspace-pill"');
    expect(markup).not.toContain('aria-label="任务类型"');
    expect(markup).not.toContain("核心上下文");
    expect(markup).not.toContain("默认交付");
    expect(markup).not.toContain("创建可编排的 Agent 小队");
    expect(markup).not.toContain("资源入口已就绪");
    expect(markup).not.toContain("Agent / Skill / MCP / Knowledge / Workflow");
    expect(markup).not.toContain("????");
  });

  it("snapshots the default command-home landmarks", () => {
    const markup = renderCommandWorkspace();
    const commandHomeMarkup = markup.slice(
      markup.indexOf('data-shell-view="command"'),
      markup.indexOf('data-shell-view="assist"'),
    );
    const visibleText = (pattern: RegExp) =>
      Array.from(commandHomeMarkup.matchAll(pattern), (match) => match[1]);

    expect({
      executionTargets: visibleText(
        /data-value="(?:crewon|team:[^"]+)"[^>]*><span><strong>([^<]+)/g,
      ),
      hero: visibleText(/<h1>([^<]+)<\/h1>/g),
      quickActions: visibleText(/data-scene="office" type="button">([^<]+)/g),
      sceneTabs: visibleText(/data-scene-target="[^"]+"[^>]*>\s*([^<]+)/g),
      executionIntents: visibleText(
        /data-execution-intent="[^"]+"[^>]*>\s*<svg[^>]*>.*?<\/svg>\s*<span>([^<]+)/gs,
      ),
      workspaceOptions: visibleText(
        /data-value="(?:__no_workspace__|C:\\Users\\admin\\Documents\\crewon)"[^>]*>\s*<span><strong>([^<]+)/g,
      ),
    }).toMatchSnapshot();
  });

  /*
   * Order is the point of the layout: the composer is what someone came to use,
   * and the starter cards are the fallback underneath it. A snapshot alone would
   * let a refactor quietly swap them, so the positions are compared directly.
   */
  it("puts the starter cards after the composer, not above it", () => {
    const markup = renderCommandWorkspace();
    const commandHomeMarkup = markup.slice(
      markup.indexOf('data-shell-view="command"'),
      markup.indexOf('data-shell-view="assist"'),
    );

    const composerAt = commandHomeMarkup.indexOf('data-od-id="ai-composer"');
    const cardsAt = commandHomeMarkup.indexOf('data-od-id="quick-scenarios"');

    expect(composerAt).toBeGreaterThan(-1);
    expect(cardsAt).toBeGreaterThan(composerAt);
  });

  it("drops the recommended-capability line from the home scene", () => {
    const markup = renderCommandWorkspace();

    expect(markup).not.toContain("data-scene-capabilities");
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

  it("renders Control threads as path-free entries and removes the legacy workspace picker", () => {
    const privatePath = "/Users/private/control-only/workspace";
    const thread = {
      cwd: privatePath,
      id: "thread-control-authority",
      name: "Control task",
      preview: "Safe task preview",
      turns: [],
      updatedAt: Math.floor(Date.now() / 1000),
    } as unknown as Thread;
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd={privatePath}
        isSending={false}
        linkedThreads={[thread]}
        locale="en"
        workspaceAuthority="control"
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onChangeWorkspaceCwd={vi.fn()}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect({
      hasPrivatePath: markup.includes(privatePath),
      hasPathPrefix: markup.includes("/Users/private"),
      hasPathInput: markup.includes("command-workspace-path"),
      hasLegacyPicker: markup.includes('class="workspace-dropdown"'),
      hasWorkspaceTree: markup.includes(
        'aria-label="Workspaces and conversations"',
      ),
      hasTask: markup.includes("Control task"),
    }).toEqual({
      hasPrivatePath: false,
      hasPathPrefix: false,
      hasPathInput: false,
      hasLegacyPicker: false,
      hasWorkspaceTree: true,
      hasTask: true,
    });
  });

  it("offers full access as a warning-toned permission", () => {
    // The select menu only renders while open, so the tone mapping is asserted
    // on the option config the trigger is fed with.
    for (const locale of ["zh", "en"] as const) {
      const options = commandComposerPermissionOptions(locale);
      expect(options.map((option) => option.value)).toEqual([
        "approve-for-me",
        "request-approval",
        "full-access",
      ]);
      expect(options.find((option) => option.value === "full-access")).toEqual(
        expect.objectContaining({ tone: "warning" }),
      );
      expect(
        options.find((option) => option.value === "approve-for-me")?.tone,
      ).toBeUndefined();
    }
    expect(
      commandComposerPermissionOptions("zh").map((o) => o.label),
    ).toContain("完全访问");

    const markup = renderCommandWorkspace();
    expect(markup).toContain('aria-label="权限选择"');
  });

  it("pairs the model with its reasoning effort in one control", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        modelOptions={[
          {
            defaultReasoningEffort: "xhigh",
            isDefault: true,
            label: "gpt-5-mini",
            reasoningEfforts: [
              { value: "medium" },
              { description: "最深入的推理", value: "xhigh" },
            ],
            value: "gpt-5-mini",
          },
        ]}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="模型与推理档位"');
    expect(markup).toContain("gpt-5-mini 极高");

    // Menu content only renders while the select is open, so the pairing of
    // model and effort values is asserted on the option config directly.
    const options = modelEffortMenuOptions({
      effortOptions: [
        { label: "中", value: "medium" },
        { detail: "最深入的推理", label: "极高", value: "xhigh" },
      ],
      modelOptions: [
        {
          defaultReasoningEffort: "xhigh",
          isDefault: true,
          label: "gpt-5-mini",
          reasoningEfforts: [],
          value: "gpt-5-mini",
        },
      ],
    });
    expect(options.map((option) => option.value)).toEqual([
      "gpt-5-mini",
      "effort:medium",
      "effort:xhigh",
    ]);
    expect(options.find((option) => option.value === "effort:xhigh")).toEqual(
      expect.objectContaining({
        detail: "最深入的推理",
        group: "effort",
      }),
    );
    expect(modelEffortGroups("zh").map((group) => group.label)).toEqual([
      "模型",
      "推理档位",
    ]);
  });

  it("shows run progress and the active goal above a thread composer", () => {
    const thread = {
      cwd: "/repo/frontend",
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          items: [
            {
              type: "plan",
              id: "plan-1",
              text: "- [completed] 一\n- [completed] 二\n- [inProgress] 三\n- [pending] 四\n- [pending] 五",
            },
            {
              type: "fileChange",
              id: "change-1",
              status: { type: "completed" },
              changes: [
                {
                  path: "a.ts",
                  kind: { type: "update" },
                  diff: "+one\n+two\n-three",
                },
              ],
            },
          ],
          status: "completed",
        },
      ],
    } as unknown as Thread;
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        selectedThread={thread}
        selectedThreadId="thread-1"
        threadGoal={{
          createdAt: "2026-08-09T07:00:00.000Z",
          goalId: "goal-1",
          objective: "看一下我们之前的设计",
          revision: 1,
          status: "active",
          threadId: "thread-1",
          timeUsedSeconds: 2913,
          tokenBudget: null,
          tokensUsed: 0,
          updatedAt: "2026-08-09T07:00:00.000Z",
        }}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect(markup).toContain('data-od-id="composer-progress-pill"');
    expect(markup).toContain("第 3 / 5 步");
    expect(markup).toContain("1 个文件已更改");
    expect(markup).toContain("+2");
    expect(markup).toContain("-1");
    expect(markup).toContain('data-od-id="composer-goal-bar"');
    expect(markup).toContain("进行中的目标");
    expect(markup).toContain("看一下我们之前的设计");
    expect(markup).toContain("48m 33s");
    expect(markup).toContain('aria-label="编辑目标"');
    expect(markup).toContain('aria-label="暂停目标"');
    expect(markup).toContain('aria-label="删除目标"');
  });

  it("keeps progress and goal off the new-task home composer", () => {
    const markup = renderCommandWorkspace();

    expect(markup).not.toContain('data-od-id="composer-progress-pill"');
    expect(markup).not.toContain('data-od-id="composer-goal-bar"');
  });

  it("keeps only execution-relevant composer controls and hidden palette hooks", () => {
    const markup = renderCommandWorkspace();
    const commandHomeMarkup = markup.slice(
      markup.indexOf('data-shell-view="command"'),
      markup.indexOf('data-shell-view="assist"'),
    );

    expect(commandHomeMarkup).toContain(
      'class="icon-action composer-plus-action"',
    );
    expect(commandHomeMarkup).toContain('aria-label="添加上下文"');
    expect(commandHomeMarkup).toContain('aria-label="权限选择"');
    // Goal/plan intents live inside the + palette; the toolbar only shows an
    // active-intent chip once one is selected.
    expect(commandHomeMarkup).not.toContain('class="execution-intent-chip"');
    expect(commandHomeMarkup).toContain('placeholder="添加"');
    expect(commandHomeMarkup).toContain("选择文件");
    expect(commandHomeMarkup).toContain("选择文件夹");
    expect(markup).toContain('aria-label="从本地电脑选择文件"');
    expect(markup).toContain('aria-label="从本地电脑选择文件夹"');
    const addPanelMarkup = commandHomeMarkup.slice(
      commandHomeMarkup.indexOf('id="add-search-panel"'),
      commandHomeMarkup.indexOf('id="context-search-panel"'),
    );
    expect(addPanelMarkup).toContain('class="add-palette-group"');
    expect(addPanelMarkup).toContain('class="add-palette-item"');
    expect(addPanelMarkup).toContain("执行方式");
    expect(addPanelMarkup).toContain('data-kind="intent"');
    expect(addPanelMarkup).toContain('data-label="目标模式"');
    expect(addPanelMarkup).toContain('data-label="计划模式"');
    expect(addPanelMarkup).toContain("文件");
    expect(addPanelMarkup).not.toContain(">工作空间<");
    expect(commandHomeMarkup).toContain('aria-label="执行主体"');
    expect(commandHomeMarkup).toContain('aria-label="模型与推理档位"');
    expect(commandHomeMarkup).toContain('aria-label="工作空间选择"');
    // Select menus only render while open, so option-level expectations live
    // on the exported option builders instead of the static markup.
    expect(commandHomeMarkup).toContain(">CrewON</span>");
    expect(commandHomeMarkup).toContain('class="send-button"');
    expect(commandHomeMarkup).toContain('data-context-open=""');
    expect(commandHomeMarkup).toContain('data-slash-open=""');
    // Select menus only render while open; model option coverage lives in the
    // pairing test above via modelEffortMenuOptions.
    expect(commandHomeMarkup).not.toContain('aria-label="任务类型"');
    expect(commandHomeMarkup).not.toContain('aria-label="优化提示词"');
    expect(commandHomeMarkup).not.toContain('aria-label="搜索资源"');
    expect(commandHomeMarkup).not.toContain('aria-label="语音输入"');
  });

  it("toggles goal and plan as an optional mutually exclusive intent", () => {
    expect(nextExecutionIntent("none", "goal")).toBe("goal");
    expect(nextExecutionIntent("goal", "goal")).toBe("none");
    expect(nextExecutionIntent("goal", "plan")).toBe("plan");
    expect(nextExecutionIntent("plan", "goal")).toBe("goal");
    expect(nextExecutionIntent("plan", "plan")).toBe("none");
    expect(executionIntentAfterCommit("goal", "goal")).toBe("none");
    expect(executionIntentAfterCommit("plan", "goal")).toBe("plan");
    expect(executionIntentAfterCommit("none", "plan")).toBe("none");
  });

  it("closes composer palettes only for outside pointer targets", () => {
    const paletteTarget = {} as Node;
    const triggerTarget = {} as Node;
    const outsideTarget = {} as Node;
    const paletteRoot = {
      contains: (target: Node) => target === paletteTarget,
    };
    const trigger = {
      contains: (target: Node) => target === triggerTarget,
    };

    expect(
      shouldCloseComposerPalette({
        paletteRoots: [paletteRoot],
        target: paletteTarget,
        triggers: [trigger],
      }),
    ).toBe(false);
    expect(
      shouldCloseComposerPalette({
        paletteRoots: [paletteRoot],
        target: triggerTarget,
        triggers: [trigger],
      }),
    ).toBe(false);
    expect(
      shouldCloseComposerPalette({
        paletteRoots: [paletteRoot],
        target: outsideTarget,
        triggers: [trigger],
      }),
    ).toBe(true);
  });

  it("groups add-menu resource types with visible separators", () => {
    const markup = renderToStaticMarkup(
      <Palette
        id="add-menu"
        inputId="add-menu-search"
        items={[
          {
            detail: "选择本地内容",
            kind: "file",
            label: "文件",
            title: "选择文件",
          },
          {
            detail: "选择本地目录",
            kind: "folder",
            label: "文件夹",
            title: "选择文件夹",
          },
          {
            detail: "引用知识",
            kind: "knowledge",
            label: "知识库",
            title: "产品知识",
          },
          {
            detail: "检查页面",
            kind: "skill",
            label: "Skill",
            title: "页面审阅",
          },
          {
            detail: "访问文件",
            kind: "mcp",
            label: "MCP",
            title: "Filesystem",
          },
        ]}
        kind="add"
        open
        placeholder="添加资源"
        query=""
        onClose={() => undefined}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(markup.match(/class="add-palette-group"/g)).toHaveLength(4);
    expect(markup).toContain('class="add-palette-group-label">文件');
    expect(markup).toContain('class="add-palette-group-label">知识库');
    expect(markup).toContain('class="add-palette-group-label">Skill');
    expect(markup).toContain('class="add-palette-group-label">MCP');
    expect(markup).toContain('class="add-palette-item"');
    expect(markup).toMatchSnapshot();
  });

  it("uses a compact connection light instead of visible connection copy", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect(markup).toContain('class="connection-indicator"');
    expect(markup).toContain('data-state="connected"');
    expect(markup).toContain('aria-label="对话服务已连接"');
    expect(markup).not.toContain('class="composer-state connection-state"');
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

  it("keeps sidebar targets useful without exposing implementation language", () => {
    const markup = renderCommandWorkspace();

    expect(markup).toContain(
      "\u4ece\u8fd9\u91cc\u5f00\u59cb\u957f\u671f\u5bf9\u8bdd",
    );
    expect(markup).toContain(
      "\u4e0a\u4e0b\u6587\u63a5\u8fd1\u4e0a\u9650\u65f6\u81ea\u52a8\u538b\u7f29",
    );
    expect(markup).toContain(
      "\u9700\u8981\u5904\u7406\u7684\u4efb\u52a1\u4f18\u5148\u663e\u793a",
    );
    expect(markup).toContain('aria-label="\u4efb\u52a1\u8303\u56f4"');
    expect(markup).not.toContain("Workflow \u6267\u884c\u961f\u5217");
    expect(markup).not.toContain("\u6267\u884c\u72b6\u6001\u673a");
    expect(markup).toContain("\u667a\u80fd\u4f53");
    expect(markup).toContain("\u65e5\u7a0b\u5b89\u6392");
    expect(markup).toContain("\u529e\u516c\u5ba4");
  });

  it("snapshots the real single-thread assistant surface", () => {
    const assistantThread = {
      id: "assistant-thread",
      threadSource: "assistant",
      name: "Legacy title should stay hidden",
      preview: "持续跟进发布计划",
      cwd: "/private/default-runtime",
      createdAt: 1,
      updatedAt: 2,
      turns: [],
      status: { type: "idle" },
    } as unknown as Thread;
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        assistantThread={assistantThread}
        composerValue="继续跟进"
        connectionState="connected"
        cwd="/repo/frontend"
        isSending={false}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSend={() => undefined}
        onSendAssistant={() => undefined}
      />,
    );
    const assistantMarkup = markup.slice(
      markup.indexOf('data-shell-view="assist"'),
      markup.indexOf('data-shell-view="projects"'),
    );

    expect({
      hasRealTranscript: assistantMarkup.includes(
        'data-od-id="command-thread-room"',
      ),
      hasSharedComposer: assistantMarkup.includes(
        'data-command-composer="true"',
      ),
      hasExtraDisclaimer:
        assistantMarkup.includes("内容由 AI 生成，请核实重要信息"),
      hasClearConversationAction:
        assistantMarkup.includes('aria-label="清理会话"'),
      hasLeakedHomepageDraft: assistantMarkup.includes("继续跟进"),
      hasThreadHeader: assistantMarkup.includes(
        'data-od-id="desktop-command-header"',
      ),
      hasThreadToolbar: assistantMarkup.includes("command-thread-toolbar"),
      usesThreadComposer: assistantMarkup.includes(
        "thread-command-input assistant-home-composer",
      ),
      hasWorkspace: assistantMarkup.includes("/private/default-runtime"),
      hasDefaultEnvironment: assistantMarkup.includes(
        "\u9ed8\u8ba4\u6267\u884c\u73af\u5883",
      ),
    }).toMatchSnapshot();
  });

  it("keeps workspaces from existing conversations visible when another workspace is active", () => {
    const originalWorkspaceThread = {
      cwd: "/repo/original-workspace",
      id: "thread-original-workspace",
      name: "Original workspace conversation",
      preview: "Conversation from the original workspace",
      updatedAt: Math.floor(Date.now() / 1000),
    } as unknown as Thread;
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd="/repo/current-workspace"
        isSending={false}
        linkedThreads={[originalWorkspaceThread]}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSelectLinkedThread={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect(markup).toContain("current-workspace");
    expect(markup).toContain("original-workspace");
    expect(markup).toContain('aria-label="切换到工作空间 original-workspace"');
    expect(markup).toContain(
      'data-linked-thread-id="thread-original-workspace"',
    );
  });

  it("renders the schedule calendar on the Control runtime without technical jargon", () => {
    const markup = renderToStaticMarkup(
      commandWorkspaceElement({ workspaceAuthority: "control" }),
    );
    const scheduleMarkup = markup.slice(
      markup.indexOf('data-shell-view="schedule"'),
      markup.indexOf('data-shell-view="team"'),
    );

    expect(scheduleMarkup).toContain('aria-label="日程日历"');
    expect(scheduleMarkup).toContain("新建日程");
    expect(scheduleMarkup).toContain("定时执行");
    expect(scheduleMarkup).toContain("手动执行");
    expect(scheduleMarkup).toContain("下一次执行");
    expect(scheduleMarkup).not.toContain("manualOnly");
    expect(scheduleMarkup).not.toContain("automaticScheduling");
    expect(scheduleMarkup).not.toContain("App Server");
    expect(scheduleMarkup).not.toContain("Run SSE");
    expect(scheduleMarkup).not.toContain("authority");
    expect(scheduleMarkup).not.toContain("新建自动化");
    const modelLabelAt = markup.indexOf('aria-label="模型与推理档位"');
    const modelTrigger = markup.slice(
      markup.lastIndexOf("<button", modelLabelAt),
      markup.indexOf(">", modelLabelAt),
    );
    expect(modelTrigger).toMatchSnapshot();
    expect(modelTrigger).not.toContain('disabled=""');
  });

  it("renders the same schedule calendar while Control is not in charge", () => {
    const markup = renderCommandWorkspace();
    const scheduleMarkup = markup.slice(
      markup.indexOf('data-shell-view="schedule"'),
      markup.indexOf('data-shell-view="team"'),
    );

    expect(scheduleMarkup).toContain('aria-label="日程日历"');
    expect(scheduleMarkup).toContain("日程服务暂未配置");
    expect(scheduleMarkup).not.toContain("个人日程");
    expect(scheduleMarkup).not.toContain("手动自动化");
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

  it("keeps existing workspaces actionable for a workspace-less new task", () => {
    const workspaceThread = {
      cwd: "/repo/frontend",
      id: "thread-existing-workspace",
      name: "Existing workspace conversation",
      preview: "This workspace remains available from a standalone draft",
      updatedAt: Math.floor(Date.now() / 1000),
    } as unknown as Thread;
    const markup = renderToStaticMarkup(
      <CommandWorkspace
        composerValue=""
        connectionState="connected"
        cwd=""
        isSending={false}
        linkedThreads={[workspaceThread]}
        workMode="code"
        onAttachContext={() => undefined}
        onChangeComposerValue={() => undefined}
        onChangeWorkspaceCwd={() => undefined}
        onModeChange={() => undefined}
        onRetryConnection={() => undefined}
        onSelectLinkedThread={() => undefined}
        onSend={() => undefined}
      />,
    );

    expect(markup).not.toContain(
      "当前没有绑定文件夹空间，可以新增空间或直接开始无空间会话。",
    );
    expect(markup).toContain('aria-label="在工作空间 frontend 中新建会话"');
    expect(markup).toContain(
      'data-linked-thread-id="thread-existing-workspace"',
    );
    expect({
      hasEmptyWorkspaceHint: markup.includes(
        "当前没有绑定文件夹空间，可以新增空间或直接开始无空间会话。",
      ),
      hasNewConversationAction: markup.includes(
        'aria-label="在工作空间 frontend 中新建会话"',
      ),
      hasWorkspaceThread: markup.includes(
        'data-linked-thread-id="thread-existing-workspace"',
      ),
    }).toMatchInlineSnapshot(`
      {
        "hasEmptyWorkspaceHint": false,
        "hasNewConversationAction": true,
        "hasWorkspaceThread": true,
      }
    `);
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
    expect(markup).toContain(
      'aria-controls="standalone-workspace-thread-list"',
    );
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
    // The task bar carries the task name only; workspace and run state moved out.
    expect(markup).not.toContain('class="command-thread-cwd"');
    expect(markup).not.toContain('class="command-thread-runtime"');
    expect(markup).toContain("Command room transcript");
    expect(markup).toContain('class="transcript"');
    expect(markup).toContain(
      '<form class="command-input thread-command-input"',
    );
    expect(markup).toContain('data-command-composer="true"');
    expect(markup).not.toContain("内容由 AI 生成，请核实重要信息");
    expect(markup).toContain("Run inside command shell");
    expect(markup).toContain("Command response");
    expect(markup).toContain("task-list-item");
    expect(markup).not.toContain('class="app-shell"');
    expect(markup).not.toContain('data-workspace-operations-slot="mounted"');
    expect(markup).not.toContain('data-workspace-operations="control"');
  });

  it("keeps the conversation free of workspace operations chrome in Control mode", () => {
    const markup = renderControlWorkspaceThread();

    expect(markup).not.toContain('data-workspace-operations-slot="mounted"');
    expect(markup).not.toContain("command-thread-operations-rail");
    expect(markup).not.toContain('data-workspace-operations="control"');
    expect(markup).not.toContain("command-thread-stage");
    // The bound workspace lives in the sidebar tree instead.
    expect(markup).toContain('aria-label="工作空间和对话"');
    expect(markup).toContain("cuican-aide");
    expect(markup).toContain('data-od-id="command-thread-room"');
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
    expect(markup).toContain("filesystem.read_file");
    expect(markup).toContain("已读取 1 个文件");
    expect(markup).toContain("README.md");
    expect(markup).toContain("skills.delivery-check");
    expect(markup).toContain("pnpm test -- CommandWorkspace");
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
    expect(markup).toContain('data-action="stop"');
    expect(markup).toContain('aria-label="停止"');
    expect(markup).toContain('title="停止"');
  });

  it("renders live backend agent work in the command transcript", () => {
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

    // Run state belongs to the transcript and composer, not the task bar.
    expect(markup).not.toContain('class="command-thread-runtime"');
    expect(markup).toContain("正在实时生成最终回复");
    expect(markup).toContain("filesystem");
    expect(markup).toContain("code-review-system");
    expect(markup).toContain("pnpm test");
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
    expect(
      scope.querySelector<HTMLElement>('[data-card="team-calendar"]')?.hidden,
    ).toBe(false);
    expect(
      scope.querySelector<HTMLElement>('[data-card="personal-calendar"]')
        ?.hidden,
    ).toBe(true);
    expect(
      scope.querySelector<HTMLElement>('[data-card="personal-arrangement"]')
        ?.hidden,
    ).toBe(true);
    expect(
      scope.querySelector<HTMLElement>('[data-card="team-arrangement"]')
        ?.hidden,
    ).toBe(true);

    setActiveFilter(scope, "schedule-mode", "arrangement");
    expect(
      scope.querySelector<HTMLElement>('[data-card="team-calendar"]')?.hidden,
    ).toBe(true);
    expect(
      scope.querySelector<HTMLElement>('[data-card="team-arrangement"]')
        ?.hidden,
    ).toBe(false);

    setActiveFilter(scope, "schedule-source", "personal");
    expect(
      scope.querySelector<HTMLElement>('[data-card="team-arrangement"]')
        ?.hidden,
    ).toBe(true);
    expect(
      scope.querySelector<HTMLElement>('[data-card="personal-arrangement"]')
        ?.hidden,
    ).toBe(false);
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
    expect(
      scope.querySelectorAll<HTMLElement>("[data-card-filter]")[0]?.hidden,
    ).toBe(false);
    expect(
      scope.querySelectorAll<HTMLElement>("[data-card-filter]")[1]?.hidden,
    ).toBe(true);
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

    expect(view.querySelector<HTMLElement>("[data-office-list]")?.hidden).toBe(
      false,
    );
    expect(view.querySelector<HTMLElement>("[data-office-room]")?.hidden).toBe(
      true,
    );
    expect(
      view.querySelector<HTMLElement>("[data-workflow-list]")?.hidden,
    ).toBe(false);
    expect(
      view.querySelector<HTMLElement>("[data-workflow-room]")?.hidden,
    ).toBe(true);
    expect(
      view
        .querySelector<HTMLElement>("[data-office-shell]")
        ?.classList.contains("is-room-open"),
    ).toBe(false);
    expect(
      view
        .querySelector<HTMLElement>("[data-workflow-shell]")
        ?.classList.contains("is-room-open"),
    ).toBe(false);
    expect(view.classList.contains("office-room-active")).toBe(false);
    expect(view.classList.contains("workflow-room-active")).toBe(false);
    expect(
      view.querySelector<HTMLElement>('[data-office-drawer="members"]')?.hidden,
    ).toBe(true);
    expect(
      view
        .querySelector<HTMLElement>("[data-office-drawer-open]")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
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
    const runTab = scope.querySelector<HTMLButtonElement>(
      '[data-tab-target="#run"]',
    );
    expect(runTab).not.toBeNull();

    if (runTab) {
      activateDesignPanelTab(runTab, scope);
    }

    expect(
      scope
        .querySelector<HTMLElement>('[data-tab-target="#chat"]')
        ?.classList.contains("active"),
    ).toBe(false);
    expect(
      scope
        .querySelector<HTMLElement>('[data-tab-target="#run"]')
        ?.classList.contains("active"),
    ).toBe(true);
    expect(
      scope
        .querySelector<HTMLElement>('[data-tab-target="#run"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(scope.querySelector<HTMLElement>("#chat")?.hidden).toBe(true);
    expect(scope.querySelector<HTMLElement>("#run")?.hidden).toBe(false);
    expect(scope.querySelector<HTMLElement>("#memory")?.hidden).toBe(true);
  });
});

function providerSnapshot(): ProviderResourceSnapshot {
  return {
    generation: 1,
    phase: "ready",
    workspaces: [
      {
        workspaceKey: "workspace-1",
        displayName: "cuican-aide",
        nodeId: "node-1",
        environmentId: "local",
        availability: "available",
      },
    ],
    provider: {
      connectionId: "connection-1",
      providerId: "agent-platform",
      kind: "agentPlatform",
      protocolVersion: "v1",
      status: "connected",
      capabilities: ["remoteTool"],
      resourceCapabilities: [
        {
          resourceType: "mcpTool",
          mode: "remoteReference",
          executionLocation: "provider",
        },
      ],
      projectionEtag: "etag-1",
      observedAt: 1n,
    },
    resources: [
      {
        providerId: "agent-platform",
        resourceId: "provider-mcp-tool",
        revision: "revision-1",
        resourceType: "mcpTool",
      },
    ],
    workspace: null,
    binding: null,
    error: null,
  };
}
