import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type {
  AgentConfig,
  AutomationConfig,
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
  OfficeConfig,
} from "../domain/crewonDomain";
import {
  handleLibraryAutomationRunAction,
  type AutomationRunRecord,
} from "./libraryAutomationRunActions";

type CapturedAutomationRunState = {
  configUpdates: Array<{ filePath: string; threadId?: string }>;
  configWrites: AutomationConfig[];
  goals: Array<{ goal: string; threadId: string; tokenBudget: number | null }>;
  libraryPanel: LibraryPanel | null;
  notice: NoticeState | null;
  renamedThreads: Array<{ threadId: string; title: string }>;
  runRecordsByTurn: Record<string, AutomationRunRecord & { threadId: string }>;
  runs: Array<{ note: string | null; threadId?: string; turnId: string | null }>;
  startedTurns: Array<{ text: string; threadId: string }>;
  threads: Thread[];
  updatedRuns: Array<{ completedAt: number | null; filePath: string; status: string }>;
};

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
    turns: [],
    ...overrides,
  };
}

function agentConfig(): AgentConfig {
  return {
    agentId: "agent-1",
    name: "Runner",
    glyph: "R",
    accent: "blue",
    role: "Run automations",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "default",
    permissions: ["default"],
    systemPrompt: "Run the automation",
    mcp: [],
    skills: [],
  };
}

function officeConfig(): OfficeConfig {
  return {
    title: "Office",
    subtitle: "Workspace",
    workspace: {
      goal: "Deliver work",
      members: [],
      messages: [],
      tasks: [],
    },
  };
}

function automationConfig(
  overrides: Partial<AutomationConfig> = {},
): AutomationConfig {
  return {
    title: "Daily sync",
    subtitle: "Manual · Office · Runner",
    body: "Run daily sync",
    prompt: "Start daily sync",
    trigger: { type: "manual" },
    targetOffice: officeConfig(),
    executionAgent: agentConfig(),
    ...overrides,
  };
}

function panel(): LibraryPanel {
  return {
    kind: "automation",
    title: "Automation",
    subtitle: "Detail",
    body: "Existing",
    fields: [
      {
        id: "automation-run-note",
        label: "Run note",
        value: "Ship summary",
      },
    ],
    actions: [
      {
        id: "run-automation",
        label: "Run",
      },
    ],
    items: [],
  };
}

async function handleAction(
  action: LibraryPanelAction,
  options: {
    latestAgent?: AgentConfig | null;
    latestOffice?: OfficeConfig | null;
    readThread?: (threadId: string) => Promise<Thread | null | undefined>;
    runRecord?: AutomationRunRecord | null;
    startAutomationThread?: () => Promise<Thread | null>;
    startTurn?: (
      threadId: string,
      text: string,
    ) => Promise<TurnStartResponse | null | undefined>;
  } = {},
): Promise<{ handled: boolean; state: CapturedAutomationRunState }> {
  const state: CapturedAutomationRunState = {
    configUpdates: [],
    configWrites: [],
    goals: [],
    libraryPanel: panel(),
    notice: null,
    renamedThreads: [],
    runRecordsByTurn: {},
    runs: [],
    startedTurns: [],
    threads: [],
    updatedRuns: [],
  };

  const handled = await handleLibraryAutomationRunAction({
    action,
    isMissingThreadError: (error) =>
      error instanceof Error && error.message.includes("thread not found"),
    latestAgent: async () => options.latestAgent,
    latestOffice: async () => options.latestOffice,
    libraryPanel: state.libraryPanel,
    locale: "en",
    readAutomationRunItems: async (): Promise<LibraryItem[]> => [
      {
        title: "Backend run history",
        meta: "1 record",
        description: "Latest run",
      },
    ],
    readThread:
      options.readThread ??
      (async (threadId) => thread({ id: threadId, turns: [turn()] })),
    recordAutomationRunForTurn: (turnId, record) => {
      state.runRecordsByTurn[turnId] = record;
    },
    renameThread: async (threadId, title) => {
      state.renamedThreads.push({ threadId, title });
    },
    runAutomationConfig: async (config, note, turnId) => {
      state.runs.push({ note, threadId: config.threadId, turnId });
      return {
        record:
          options.runRecord === undefined
            ? { filePath: "/runs/run-1.json", runId: "run-1" }
            : options.runRecord,
        warning: null,
      };
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
      options.startAutomationThread ??
      (async () => thread({ id: "created-thread" })),
    startTurn:
      options.startTurn ??
      (async (threadId, text) => {
        state.startedTurns.push({ text, threadId });
        return turnStartResponse();
      }),
    updateAutomationConfig: async (filePath, config) => {
      state.configUpdates.push({ filePath, threadId: config.threadId });
      return filePath;
    },
    updateAutomationRun: async (filePath, status, completedAt) => {
      state.updatedRuns.push({ completedAt, filePath, status });
    },
    writeAutomationConfig: async (config) => {
      state.configWrites.push(config);
      return "/automations/daily-sync.json";
    },
  });

  return { handled, state };
}

describe("library automation run actions", () => {
  it("leaves unrelated actions for the app handler", async () => {
    const { handled, state } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
    expect(state.startedTurns).toEqual([]);
  });

  it("shows a warning when the automation has no target office or agent", async () => {
    const { handled, state } = await handleAction({
      id: "run-automation",
      label: "Run",
      automationConfig: automationConfig({
        executionAgent: null,
        targetOffice: null,
      }),
    });

    expect(handled).toBe(true);
    expect(state.notice).toEqual({
      text: "Running an automation requires a saved target office and backend agent. Create an office and create/save an agent first.",
      tone: "warning",
    });
    expect(state.libraryPanel?.error).toBe(state.notice?.text);
    expect(state.startedTurns).toEqual([]);
  });

  it("creates a thread, writes config, starts a turn, and records the run", async () => {
    const { handled, state } = await handleAction({
      id: "run-automation",
      label: "Run",
      automationConfig: automationConfig(),
    });

    expect(handled).toBe(true);
    expect(state.renamedThreads).toEqual([
      { threadId: "created-thread", title: "Daily sync" },
    ]);
    expect(state.goals).toEqual([
      {
        goal: 'Run and record automation "Daily sync".',
        threadId: "created-thread",
        tokenBudget: null,
      },
    ]);
    expect(state.configWrites.map((config) => config.threadId)).toEqual([
      "created-thread",
    ]);
    expect(state.startedTurns).toEqual([
      {
        threadId: "created-thread",
        text: expect.stringContaining("Run note: Ship summary"),
      },
    ]);
    expect(state.runs).toEqual([
      {
        note: "Ship summary",
        threadId: "created-thread",
        turnId: "turn-1",
      },
    ]);
    expect(state.runRecordsByTurn).toEqual({
      "turn-1": {
        filePath: "/runs/run-1.json",
        runId: "run-1",
        threadId: "created-thread",
      },
    });
    expect(state.libraryPanel).toMatchObject({
      subtitle: "Written to backend execution thread",
      error: undefined,
    });
    expect(state.libraryPanel?.items?.[0]?.title).toBe("Backend run history");
  });

  it("replaces a missing existing thread before starting the turn", async () => {
    const readCalls: string[] = [];
    const { handled, state } = await handleAction(
      {
        id: "run-automation",
        label: "Run",
        automationConfig: automationConfig({ threadId: "missing-thread" }),
        automationConfigPath: "/automations/daily-sync.json",
      },
      {
        readThread: async (threadId) => {
          readCalls.push(threadId);
          if (threadId === "missing-thread") {
            throw new Error("thread not found");
          }
          return thread({ id: threadId, turns: [turn()] });
        },
        startAutomationThread: async () => thread({ id: "replacement-thread" }),
      },
    );

    expect(handled).toBe(true);
    expect(readCalls[0]).toBe("missing-thread");
    expect(state.renamedThreads).toEqual([
      { threadId: "replacement-thread", title: "Daily sync" },
    ]);
    expect(state.configUpdates).toEqual([
      {
        filePath: "/automations/daily-sync.json",
        threadId: "replacement-thread",
      },
    ]);
    expect(state.startedTurns.map((item) => item.threadId)).toEqual([
      "replacement-thread",
    ]);
  });
});
