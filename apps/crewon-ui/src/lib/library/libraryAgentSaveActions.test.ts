import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { TurnStartResponse } from "@crewon/app-server-protocol/v2/TurnStartResponse";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { AgentConfig, LibraryPanel } from "../domain/crewonDomain";
import { saveAgentConfigAction } from "./libraryAgentSaveActions";

type CapturedAgentSaveState = {
  goals: Array<{ goal: string; threadId: string; tokenBudget: number | null }>;
  libraryPanel: LibraryPanel | null;
  notice: NoticeState | null;
  renamedThreads: Array<{ name: string; threadId: string }>;
  startedThreads: string[];
  startedTurns: Array<{ text: string; threadId: string }>;
  threads: Thread[];
  writtenConfigs: AgentConfig[];
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
    id: "agent-thread",
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
    name: "Planner",
    glyph: "P",
    accent: "blue",
    role: "Plan work",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "workspace-write",
    permissions: ["workspace-write"],
    systemPrompt: "Plan the work",
    mcp: [{ id: "git", name: "Git", glyph: "G", accent: "green", description: "Git", enabled: true }],
    skills: [{ id: "review", name: "Review", glyph: "R", accent: "amber", description: "Review", enabled: true }],
    ...overrides,
  };
}

function panel(config: AgentConfig | null = agentConfig()): LibraryPanel {
  return {
    kind: "agents",
    title: "Planner",
    subtitle: "Agent",
    items: [],
    agentConfig: config ?? undefined,
  };
}

async function saveAction(
  options: {
    config?: AgentConfig | null;
    isConnected?: boolean;
    readThread?: (threadId: string) => Promise<Thread | null | undefined>;
    startTurn?: (
      threadId: string,
      text: string,
      state: CapturedAgentSaveState,
    ) => Promise<TurnStartResponse | null | undefined>;
    writeError?: unknown;
  } = {},
): Promise<{ handled: boolean; state: CapturedAgentSaveState }> {
  const config = options.config === undefined ? agentConfig() : options.config;
  const state: CapturedAgentSaveState = {
    goals: [],
    libraryPanel: panel(config),
    notice: null,
    renamedThreads: [],
    startedThreads: [],
    startedTurns: [],
    threads: [thread()],
    writtenConfigs: [],
  };

  const handled = await saveAgentConfigAction({
    config,
    isConnected: options.isConnected ?? true,
    isMissingThreadError: (error) =>
      error instanceof Error && error.message.includes("thread not found"),
    locale: "en",
    readThread:
      options.readThread ??
      (async (threadId) => thread({ id: threadId, turns: [turn()] })),
    renameThread: async (threadId, name) => {
      state.renamedThreads.push({ threadId, name });
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
    startAgentThread: async () => {
      const nextThread = thread({ id: `agent-thread-${state.startedThreads.length + 1}` });
      state.startedThreads.push(nextThread.id);
      return nextThread;
    },
    startTurn: async (threadId, text) => {
      if (options.startTurn) {
        return options.startTurn(threadId, text, state);
      }
      state.startedTurns.push({ threadId, text });
      return turnStartResponse();
    },
    threads: state.threads,
    writeAgentConfig: async (nextConfig) => {
      if (options.writeError) {
        throw options.writeError;
      }
      state.writtenConfigs.push(nextConfig);
      return {
        agentId: "agent-1",
        filePath: "/agents/planner.json",
      };
    },
  });

  return { handled, state };
}

describe("library agent save actions", () => {
  it("ignores missing configs", async () => {
    const { handled, state } = await saveAction({ config: null });

    expect(handled).toBe(false);
    expect(state.notice).toBeNull();
    expect(state.writtenConfigs).toEqual([]);
  });

  it("shows a success notice without backend writes when disconnected", async () => {
    const { handled, state } = await saveAction({ isConnected: false });

    expect(handled).toBe(true);
    expect(state.writtenConfigs).toEqual([]);
    expect(state.notice).toEqual({
      text: 'Saved "Planner" · gpt-5 · 1 MCP · 1 skills',
      tone: "success",
    });
  });

  it("saves configs to an existing thread and appends history", async () => {
    const { handled, state } = await saveAction({
      config: agentConfig({ threadId: "agent-thread" }),
    });

    expect(handled).toBe(true);
    expect(state.renamedThreads).toEqual([
      { name: "Planner", threadId: "agent-thread" },
    ]);
    expect(state.goals).toEqual([
      {
        goal: 'Persist agent "Planner" configuration and make it recruitable by offices.',
        threadId: "agent-thread",
        tokenBudget: null,
      },
    ]);
    expect(state.writtenConfigs.map((config) => config.threadId)).toEqual([
      "agent-thread",
    ]);
    expect(state.startedTurns).toEqual([
      {
        threadId: "agent-thread",
        text: expect.stringContaining("Agent: Planner"),
      },
    ]);
    expect(state.libraryPanel).toMatchObject({
      body: "Agent config written: /agents/planner.json",
      agentConfig: { agentId: "agent-1", threadId: "agent-thread" },
    });
    expect(state.notice?.tone).toBe("success");
  });

  it("creates a replacement thread when the first save turn references a missing thread", async () => {
    const { handled, state } = await saveAction({
      config: agentConfig({ threadId: "agent-thread" }),
      startTurn: async (threadId, text, currentState) => {
        currentState.startedTurns.push({ threadId, text });
        if (threadId === "agent-thread") {
          throw new Error("thread not found");
        }
        return turnStartResponse();
      },
    });

    expect(handled).toBe(true);
    expect(state.startedThreads).toEqual(["agent-thread-1"]);
    expect(state.startedTurns.map((item) => item.threadId)).toEqual([
      "agent-thread",
      "agent-thread-1",
    ]);
    expect(state.writtenConfigs.map((config) => config.threadId)).toEqual([
      "agent-thread",
      "agent-thread-1",
    ]);
  });

  it("reports save failures", async () => {
    const { handled, state } = await saveAction({
      writeError: new Error("write failed"),
    });

    expect(handled).toBe(true);
    expect(state.notice).toEqual({
      text: "write failed",
      tone: "warning",
    });
  });
});
