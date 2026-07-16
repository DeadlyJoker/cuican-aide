import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type {
  AgentConfig,
  LibraryPanel,
  LibraryPanelAction,
  OfficeConfig,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import { handleLibraryOfficeRecruitAction } from "./libraryOfficeRecruitActions";

type CapturedRecruitState = {
  ensuredThreads: Array<{ forceNew?: boolean; workspaceThreadId?: string }>;
  libraryPanel: LibraryPanel | null;
  notice: NoticeState | null;
  persistedMembers: Array<{
    agentId?: string;
    memberName: string;
    threadId?: string | null;
  }>;
  startedTurns: Array<{ text: string; threadId: string }>;
  threads: Thread[];
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
    id: "office-thread",
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
    name: "Office",
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
    mcp: [
      {
        id: "git",
        name: "Git",
        glyph: "G",
        accent: "green",
        description: "Git",
        enabled: true,
      },
    ],
    skills: [
      {
        id: "review",
        name: "Review",
        glyph: "R",
        accent: "amber",
        description: "Review",
        enabled: true,
      },
    ],
    ...overrides,
  };
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Coordinate work",
    threadId: "office-thread",
    backendStatus: "connected",
    members: [],
    messages: [],
    tasks: [],
    ...overrides,
  };
}

function officeConfig(workspaceConfig: OfficeWorkspace): OfficeConfig {
  return {
    title: "Office",
    subtitle: "Workspace",
    workspace: workspaceConfig,
  };
}

function panel(workspaceConfig: OfficeWorkspace = workspace()): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Workspace",
    items: [],
    workspace: workspaceConfig,
  };
}

async function handleAction(
  action: LibraryPanelAction,
  options: {
    agent?: AgentConfig | null;
    isConnected?: boolean;
    isDemo?: boolean;
    libraryPanel?: LibraryPanel | null;
    persistResult?: OfficeConfig | null;
    startTurn?: (
      threadId: string,
      text: string,
      state: CapturedRecruitState,
    ) => Promise<TurnStartResponse | null | undefined>;
  } = {},
): Promise<{ handled: boolean; state: CapturedRecruitState }> {
  const state: CapturedRecruitState = {
    ensuredThreads: [],
    libraryPanel: options.libraryPanel === undefined ? panel() : options.libraryPanel,
    notice: null,
    persistedMembers: [],
    startedTurns: [],
    threads: [thread()],
  };
  const handled = await handleLibraryOfficeRecruitAction({
    action,
    ensureOfficeThread: async (_panel, workspaceOverride, forceNew) => {
      state.ensuredThreads.push({
        forceNew,
        workspaceThreadId: workspaceOverride?.threadId,
      });
      const threadId = forceNew ? "replacement-thread" : "office-thread";
      return {
        config: officeConfig({
          ...(workspaceOverride ?? workspace()),
          threadId,
          recordRevision: forceNew
            ? "revision-replacement"
            : "revision-current",
        }),
        filePath: `/offices/${threadId}.json`,
        threadId,
      };
    },
    isConnected: options.isConnected ?? true,
    isDemo: options.isDemo ?? false,
    isMissingThreadError: (error) =>
      error instanceof Error && error.message.includes("thread not found"),
    libraryPanel: state.libraryPanel,
    locale: "en",
    persistOfficeMember: async (
      _panel,
      workspaceBeforeMember,
      agentId,
      member,
      threadId,
    ) => {
      state.persistedMembers.push({ agentId, memberName: member.name, threadId });
      const workspaceWithoutThread = { ...workspaceBeforeMember };
      delete workspaceWithoutThread.threadId;
      return Object.hasOwn(options, "persistResult")
        ? (options.persistResult ?? null)
        : officeConfig({
            ...workspaceWithoutThread,
            members: [...workspaceBeforeMember.members, member],
            ...(threadId ? { threadId } : {}),
          });
    },
    readRecruitableAgentConfig: async () =>
      options.agent === undefined ? agentConfig() : options.agent,
    setLibraryPanel: (updater) => {
      state.libraryPanel = updater(state.libraryPanel);
    },
    setNotice: (notice) => {
      state.notice = notice;
    },
    setThreads: (updater) => {
      state.threads = updater(state.threads);
    },
    startTurn: async (threadId, text) => {
      if (options.startTurn) {
        return options.startTurn(threadId, text, state);
      }
      state.startedTurns.push({ text, threadId });
      return turnStartResponse();
    },
  });

  return { handled, state };
}

describe("library office recruit actions", () => {
  it("leaves unrelated actions for the app handler", async () => {
    const { handled, state } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
    expect(state.startedTurns).toEqual([]);
  });

  it("does not invent members when the backend is unavailable", async () => {
    const { handled, state } = await handleAction(
      { id: "recruit-agent", label: "Recruit" },
      { isConnected: false, isDemo: true },
    );

    expect(handled).toBe(true);
    expect(state.libraryPanel).toEqual(panel());
    expect(state.notice).toEqual({
      text: "Connect to the App Server to recruit a real agent; the Office will not create demo members.",
      tone: "warning",
    });
    expect(state.startedTurns).toEqual([]);
  });

  it("warns when no recruitable backend agent exists", async () => {
    const { handled, state } = await handleAction(
      { id: "recruit-agent", label: "Recruit" },
      { agent: null },
    );

    expect(handled).toBe(true);
    expect(state.notice).toEqual({
      text: "No backend agent is available to recruit. Create and save an agent in the agent library first, then recruit it into the office.",
      tone: "warning",
    });
    expect(state.persistedMembers).toEqual([]);
  });

  it("persists recruited members, starts a turn, updates threads, and shows success", async () => {
    const { handled, state } = await handleAction({
      id: "recruit-agent",
      label: "Recruit",
    });

    expect(handled).toBe(true);
    expect(state.ensuredThreads).toEqual([
      { forceNew: undefined, workspaceThreadId: "office-thread" },
    ]);
    expect(state.persistedMembers).toEqual([
      { agentId: "agent-1", memberName: "Planner", threadId: "office-thread" },
    ]);
    expect(state.startedTurns).toEqual([
      {
        threadId: "office-thread",
        text: expect.stringContaining('Office "Office" recruited agent: Planner'),
      },
    ]);
    expect(state.threads[0]?.turns).toEqual([turn()]);
    expect(state.libraryPanel?.workspace).toMatchObject({
      backendStatus: "connected",
      threadId: "office-thread",
      members: [expect.objectContaining({ name: "Planner" })],
    });
    expect(state.notice).toEqual({
      text: "Recruited Planner and wrote it to the backend office config",
      tone: "success",
    });
  });

  it("persists selected agents in draft offices without starting a thread", async () => {
    const selectedAgent = agentConfig({
      agentId: "agent-selected",
      name: "Researcher",
      glyph: "R",
      role: "Research options",
    });
    const { handled, state } = await handleAction(
      {
        id: "recruit-agent",
        label: "Recruit Researcher",
        agentConfig: selectedAgent,
      },
      {
        agent: null,
        libraryPanel: panel(
          workspace({
            backendStatus: "local",
            threadId: undefined,
          }),
        ),
      },
    );

    expect(handled).toBe(true);
    expect(state.ensuredThreads).toEqual([]);
    expect(state.persistedMembers).toEqual([
      {
        agentId: "agent-selected",
        memberName: "Researcher",
        threadId: null,
      },
    ]);
    expect(state.startedTurns).toEqual([]);
    expect(state.libraryPanel?.workspace).toMatchObject({
      backendStatus: "local",
      members: [expect.objectContaining({ name: "Researcher" })],
    });
    expect(state.libraryPanel?.workspace?.threadId).toBeUndefined();
    expect(state.notice).toEqual({
      text: "Recruited Researcher and wrote it to the backend office config",
      tone: "success",
    });
  });

  it("rebinds office thread when the first recruit turn uses a missing thread", async () => {
    const { handled, state } = await handleAction(
      { id: "recruit-agent", label: "Recruit" },
      {
        startTurn: async (threadId, text, currentState) => {
          currentState.startedTurns.push({ text, threadId });
          if (threadId === "office-thread") {
            throw new Error("thread not found");
          }
          return turnStartResponse();
        },
      },
    );

    expect(handled).toBe(true);
    expect(state.ensuredThreads).toEqual([
      { forceNew: undefined, workspaceThreadId: "office-thread" },
      { forceNew: true, workspaceThreadId: "office-thread" },
    ]);
    expect(state.startedTurns.map((item) => item.threadId)).toEqual([
      "office-thread",
      "replacement-thread",
    ]);
    expect(state.libraryPanel?.workspace?.threadId).toBe("replacement-thread");
  });

  it("warns when recruited members cannot be persisted", async () => {
    const { handled, state } = await handleAction(
      { id: "recruit-agent", label: "Recruit" },
      { persistResult: null },
    );

    expect(handled).toBe(true);
    expect(state.notice).toEqual({
      text: "Agent recruitment was not written to the backend office config. Try again later.",
      tone: "warning",
    });
    expect(state.startedTurns).toEqual([]);
  });
});
