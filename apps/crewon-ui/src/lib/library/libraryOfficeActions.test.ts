import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import {
  officeConfigForThread,
  type LibraryPanel,
  type LibraryPanelAction,
  type OfficeConfig,
} from "../domain/crewonDomain";
import { handleLibraryOfficeAction } from "./libraryOfficeActions";
import { newBackendOfficeWorkspace } from "../office/officeWorkspace";

type CapturedOfficeState = {
  configCreates: Array<{ goal: string; subtitle: string; threadId: string; title: string }>;
  configWrites: OfficeConfig[];
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
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
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

function panel(): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Library",
    items: [],
  };
}

async function handleAction(
  action: LibraryPanelAction,
  options: {
    createOfficeConfig?: (
      params: {
        goal: string;
        subtitle: string;
        threadId: string;
        title: string;
      },
      state: CapturedOfficeState,
    ) => Promise<{ config: OfficeConfig; filePath: string } | null>;
    startOfficeThread?: () => Promise<Thread | null>;
  } = {},
): Promise<{ handled: boolean; state: CapturedOfficeState }> {
  const state: CapturedOfficeState = {
    configCreates: [],
    configWrites: [],
    goals: [],
    libraryPanel: panel(),
    notice: null,
    renamedThreads: [],
    startedTurns: [],
    threads: [],
  };

  const handled = await handleLibraryOfficeAction({
    action,
    createOfficeConfig: async (params) => {
      if (options.createOfficeConfig) {
        return options.createOfficeConfig(params, state);
      }
      state.configCreates.push(params);
      const workspace = newBackendOfficeWorkspace(
        params.title,
        params.threadId,
        "en",
      );
      return {
        filePath: "/workspace/.crewon/offices/office.json",
        config: officeConfigForThread(
          params.title,
          params.subtitle,
          workspace,
          params.threadId,
        ),
      };
    },
    isUnsupportedRpcError: (error) => error instanceof UnsupportedRpcError,
    locale: "en",
    now: () => new Date("2026-06-18T14:30:00Z"),
    renameThread: async (threadId, title) => {
      state.renamedThreads.push({ threadId, title });
    },
    setLibraryPanel: ((panelOrUpdater) => {
      state.libraryPanel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(state.libraryPanel)
          : panelOrUpdater;
    }) as ((panel: LibraryPanel | null) => void) &
      ((updater: (panel: LibraryPanel | null) => LibraryPanel | null) => void),
    setNotice: (notice) => {
      state.notice = notice;
    },
    setThreadGoal: async (threadId, goal, tokenBudget) => {
      state.goals.push({ goal, threadId, tokenBudget });
    },
    setThreads: (updater) => {
      state.threads = updater(state.threads);
    },
    startOfficeThread:
      options.startOfficeThread ?? (async () => thread({ id: "office-thread" })),
    startTurn: async (threadId, text) => {
      state.startedTurns.push({ text, threadId });
      return turnStartResponse();
    },
    writeOfficeConfig: async (config) => {
      state.configWrites.push(config);
      return "/workspace/.crewon/offices/fallback.json";
    },
  });

  return { handled, state };
}

describe("library office actions", () => {
  it("leaves unrelated actions for the app handler", async () => {
    const { handled, state } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
    expect(state.startedTurns).toEqual([]);
    expect(state.libraryPanel).toEqual(panel());
  });

  it("creates office threads, records configs, and shows the office panel", async () => {
    const { handled, state } = await handleAction({
      id: "create-office",
      label: "Create office",
    });

    expect(handled).toBe(true);
    expect(state.renamedThreads).toEqual([
      { threadId: "office-thread", title: expect.stringContaining("New office") },
    ]);
    expect(state.goals).toEqual([
      {
        goal: expect.stringContaining("Coordinate multi-agent work"),
        threadId: "office-thread",
        tokenBudget: null,
      },
    ]);
    expect(state.startedTurns).toEqual([
      {
        threadId: "office-thread",
        text: expect.stringContaining("Create office:"),
      },
    ]);
    expect(state.configCreates).toHaveLength(1);
    expect(state.configWrites).toEqual([]);
    expect(state.threads[0]).toMatchObject({
      id: "office-thread",
      name: expect.stringContaining("New office"),
      turns: [turn()],
    });
    expect(state.libraryPanel).toMatchObject({
      kind: "office",
      subtitle: "New office · backend thread bound",
      body: "Backend record: /workspace/.crewon/offices/office.json",
      workspace: {
        threadId: "office-thread",
      },
    });
  });

  it("falls back to legacy config writes when office create is unsupported", async () => {
    const { handled, state } = await handleAction(
      {
        id: "create-office",
        label: "Create office",
      },
      {
        createOfficeConfig: async (params, currentState) => {
          currentState.configCreates.push(params);
          throw new UnsupportedRpcError("unsupported");
        },
      },
    );

    expect(handled).toBe(true);
    expect(state.configWrites.map((config) => config.workspace.threadId)).toEqual(
      ["office-thread"],
    );
    expect(state.libraryPanel?.body).toBe(
      "Backend record: /workspace/.crewon/offices/fallback.json",
    );
  });

  it("shows a failure panel and notice when the backend thread cannot be created", async () => {
    const { handled, state } = await handleAction(
      {
        id: "create-office",
        label: "Create office",
      },
      {
        startOfficeThread: async () => null,
      },
    );

    expect(handled).toBe(true);
    expect(state.notice).toEqual({
      text: "Unable to create a backend office thread",
      tone: "warning",
    });
    expect(state.libraryPanel?.error).toBe(state.notice?.text);
    expect(state.configCreates).toEqual([]);
  });
});
