import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { TurnStartResponse } from "@crewon/app-server-protocol/v2/TurnStartResponse";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type {
  AgentConfig,
  AutomationConfig,
  LibraryPanel,
  LibraryPanelAction,
  OfficeConfig,
} from "../domain/crewonDomain";
import { handleLibraryAutomationCreateAction } from "./libraryAutomationCreateActions";

type DomainConfigRecord<TConfig> = {
  filePath: string;
  config: TConfig;
};

type CapturedAutomationCreateState = {
  configCreates: Array<{ prompt: string; threadId: string; title: string }>;
  configUpdates: Array<{ filePath: string; threadId?: string }>;
  configWrites: AutomationConfig[];
  goals: Array<{ goal: string; threadId: string; tokenBudget: number | null }>;
  libraryPanel: LibraryPanel | null;
  notice: NoticeState | null;
  renamedThreads: Array<{ threadId: string; title: string }>;
  startedTurns: Array<{ text: string; threadId: string }>;
  threads: Thread[];
};

class UnsupportedRpcError extends Error {}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function turnStartResponse(
  overrides: Partial<TurnStartResponse> = {},
): TurnStartResponse {
  return {
    turn: turn(),
    ...overrides,
  } as TurnStartResponse;
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "automation-thread",
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
    turns: [],
    ...overrides,
  };
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: "agent-1",
    name: "Runner",
    glyph: "R",
    accent: "blue",
    role: "Run automations",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "workspace-write",
    permissions: ["workspace-write"],
    systemPrompt: "Run the automation",
    mcp: [],
    skills: [],
    ...overrides,
  };
}

function officeConfig(overrides: Partial<OfficeConfig> = {}): OfficeConfig {
  return {
    title: "Office",
    subtitle: "Workspace",
    workspace: {
      goal: "Coordinate work",
      members: [],
      messages: [],
      tasks: [],
    },
    ...overrides,
  };
}

function panel(fields: LibraryPanel["fields"] = []): LibraryPanel {
  return {
    kind: "automation",
    title: "Automation",
    subtitle: "Library",
    items: [],
    fields,
  };
}

async function handleAction(
  action: LibraryPanelAction,
  options: {
    agents?: Array<DomainConfigRecord<AgentConfig>>;
    createAutomationConfig?: (
      params: { prompt: string; threadId: string; title: string },
      state: CapturedAutomationCreateState,
    ) => Promise<{ config: AutomationConfig; filePath: string }>;
    offices?: Array<DomainConfigRecord<OfficeConfig>>;
    panel?: LibraryPanel;
    startAutomationThread?: () => Promise<Thread | null>;
  } = {},
): Promise<{ handled: boolean; state: CapturedAutomationCreateState }> {
  const state: CapturedAutomationCreateState = {
    configCreates: [],
    configUpdates: [],
    configWrites: [],
    goals: [],
    libraryPanel: options.panel ?? panel(),
    notice: null,
    renamedThreads: [],
    startedTurns: [],
    threads: [],
  };
  const offices = options.offices ?? [
    { filePath: "/offices/office.json", config: officeConfig() },
  ];
  const agents = options.agents ?? [
    { filePath: "/agents/runner.json", config: agentConfig() },
  ];

  const handled = await handleLibraryAutomationCreateAction({
    action,
    createAutomationConfig: async (params) => {
      if (options.createAutomationConfig) {
        return options.createAutomationConfig(params, state);
      }
      state.configCreates.push({
        prompt: params.prompt,
        threadId: params.threadId,
        title: params.title,
      });
      return {
        filePath: "/automations/sync.json",
        config: {
          title: params.title,
          subtitle: "Remote config",
          body: "Remote body",
          prompt: params.prompt,
          threadId: params.threadId,
        },
      };
    },
    isUnsupportedRpcError: (error) => error instanceof UnsupportedRpcError,
    libraryPanel: state.libraryPanel,
    listAgentConfigs: async () => agents,
    listOfficeConfigs: async () => offices,
    locale: "en",
    now: () => new Date("2026-06-18T14:30:00Z"),
    renameThread: async (threadId, title) => {
      state.renamedThreads.push({ threadId, title });
    },
    setLibraryPanel: (updater) => {
      state.libraryPanel = updater(state.libraryPanel);
    },
    setNotice: (notice) => {
      state.notice = notice;
    },
    setThreadGoal: async (threadId, goal, tokenBudget) => {
      state.goals.push({ goal, threadId, tokenBudget });
    },
    setThreads: (updater) => {
      state.threads = updater(state.threads);
    },
    startAutomationThread:
      options.startAutomationThread ?? (async () => thread()),
    startTurn: async (threadId, text) => {
      state.startedTurns.push({ text, threadId });
      return turnStartResponse();
    },
    updateAutomationConfig: async (filePath, config) => {
      state.configUpdates.push({ filePath, threadId: config.threadId });
      return { filePath, config };
    },
    writeAutomationConfig: async (config) => {
      state.configWrites.push(config);
      return "/automations/fallback.json";
    },
  });

  return { handled, state };
}

describe("library automation create actions", () => {
  it("leaves unrelated actions for the app handler", async () => {
    const { handled, state } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
    expect(state.startedTurns).toEqual([]);
  });

  it("shows binding selections before creating automation", async () => {
    const { handled, state } = await handleAction({
      id: "create-automation",
      label: "Create automation",
    });

    expect(handled).toBe(true);
    expect(state.libraryPanel).toMatchObject({
      title: "New automation",
      subtitle: "1 offices · 1 agents",
      error: undefined,
      fields: expect.arrayContaining([
        expect.objectContaining({ id: "automation-office", value: "/offices/office.json" }),
        expect.objectContaining({ id: "automation-agent", value: "/agents/runner.json" }),
      ]),
    });
    expect(state.startedTurns).toEqual([]);
  });

  it("warns when there are no saved offices or agents", async () => {
    const { handled, state } = await handleAction(
      {
        id: "create-automation",
        label: "Create automation",
      },
      { agents: [], offices: [] },
    );

    expect(handled).toBe(true);
    expect(state.notice).toEqual({
      text: "Creating an automation requires a saved office and backend agent. Create an office and create/save an agent first.",
      tone: "warning",
    });
    expect(state.libraryPanel?.error).toBe(state.notice?.text);
  });

  it("creates automation config, updates it, starts a thread turn, and updates the panel", async () => {
    const { handled, state } = await handleAction(
      {
        id: "create-automation",
        label: "Create automation",
      },
      {
        panel: panel([
          { id: "automation-title", label: "Name", value: "Daily sync" },
          { id: "automation-office", label: "Office", value: "/offices/office.json" },
          { id: "automation-agent", label: "Agent", value: "/agents/runner.json" },
          { id: "automation-trigger", label: "Trigger", value: "manual" },
          { id: "automation-prompt", label: "Prompt", value: "Summarize work" },
        ]),
      },
    );

    expect(handled).toBe(true);
    expect(state.renamedThreads).toEqual([
      { threadId: "automation-thread", title: "Daily sync" },
    ]);
    expect(state.goals).toEqual([
      {
        goal: "Run automation with a target office and execution agent, keeping future run records.",
        threadId: "automation-thread",
        tokenBudget: null,
      },
    ]);
    expect(state.configCreates).toEqual([
      {
        prompt: expect.stringContaining("Run automation"),
        threadId: "automation-thread",
        title: "Daily sync",
      },
    ]);
    expect(state.configUpdates).toEqual([
      { filePath: "/automations/sync.json", threadId: "automation-thread" },
    ]);
    expect(state.startedTurns).toEqual([
      {
        threadId: "automation-thread",
        text: expect.stringContaining("Create automation: Daily sync"),
      },
    ]);
    expect(state.threads[0]).toMatchObject({
      id: "automation-thread",
      name: "Daily sync",
      turns: [turn()],
    });
    expect(state.libraryPanel).toMatchObject({
      body: expect.stringContaining("Created backend automation: Daily sync"),
      error: undefined,
    });
  });

  it("falls back to legacy config writes when automation create is unsupported", async () => {
    const { handled, state } = await handleAction(
      {
        id: "create-automation",
        label: "Create automation",
      },
      {
        panel: panel([
          { id: "automation-title", label: "Name", value: "Daily sync" },
          { id: "automation-office", label: "Office", value: "/offices/office.json" },
          { id: "automation-agent", label: "Agent", value: "/agents/runner.json" },
        ]),
        createAutomationConfig: async (params, currentState) => {
          currentState.configCreates.push(params);
          throw new UnsupportedRpcError("unsupported");
        },
      },
    );

    expect(handled).toBe(true);
    expect(state.configWrites.map((config) => config.threadId)).toEqual([
      "automation-thread",
    ]);
    expect(state.libraryPanel?.body).toContain(
      "Backend record: /automations/fallback.json",
    );
  });
});
