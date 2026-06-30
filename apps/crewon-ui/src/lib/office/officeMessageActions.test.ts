import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import type { OfficeRunResponse } from "../app-server/appServer";
import type {
  LibraryPanel,
  OfficeConfig,
  OfficeMessage,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import {
  sendOfficeMessageAction,
  type OfficeMessageActionParams,
} from "./officeMessageActions";
import type { OfficeRunTurnRecord } from "./officeRunPanel";

type CapturedOfficeMessageState = {
  activeTurns: Record<string, string>;
  ensuredThreads: Array<{ forceNew?: boolean; workspaceMessages: number }>;
  libraryPanel: LibraryPanel | null;
  persistedMessages: Array<{ text: string; threadId: string }>;
  runRecords: Record<string, OfficeRunTurnRecord>;
  runThreads: string[];
  startedTurns: Array<{ input: string; threadId: string }>;
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
    cwd: "/repo",
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

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Ship cleaner frontend",
    threadId: "office-thread",
    backendStatus: "connected",
    members: [
      {
        name: "Coordinator",
        role: "Office coordination",
        glyph: "@",
        accent: "blue",
        status: "online",
        online: true,
      },
    ],
    messages: [],
    tasks: [],
    activity: {
      trace: [],
      approvals: [],
      budget: [],
      budgetCapUsd: 0,
      artifacts: [],
      runs: [],
    },
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

function runResponse(overrides: Partial<OfficeRunResponse> = {}): OfficeRunResponse {
  return {
    filePath: "/offices/office.json",
    config: officeConfig(workspace({ threadId: "run-thread" })),
    threadId: "run-thread",
    runId: "run-1",
    turn: turn({ id: "run-turn" }),
    ...overrides,
  };
}

function state(initialPanel: LibraryPanel | null = panel()): CapturedOfficeMessageState {
  return {
    activeTurns: {},
    ensuredThreads: [],
    libraryPanel: initialPanel,
    persistedMessages: [],
    runRecords: {},
    runThreads: [],
    startedTurns: [],
    threads: [thread()],
  };
}

function disconnectedAppend(
  workspaceBeforeMessage: OfficeWorkspace,
  text: string,
): OfficeWorkspace {
  const message: OfficeMessage = {
    author: "Coordinator",
    glyph: "@",
    accent: "slate",
    time: "now",
    kind: "message",
    text: text.trim(),
  };
  const reply: OfficeMessage = {
    author: "System",
    glyph: "⌗",
    accent: "green",
    time: "now",
    kind: "message",
    text: "local reply",
  };
  return {
    ...workspaceBeforeMessage,
    messages: [...workspaceBeforeMessage.messages, message, reply],
  };
}

function baseParams(
  captured: CapturedOfficeMessageState,
  overrides: Partial<OfficeMessageActionParams> = {},
): OfficeMessageActionParams {
  return {
    appendDisconnectedMessage: disconnectedAppend,
    ensureOfficeThread: async (_panel, targetWorkspace, forceNew) => {
      captured.ensuredThreads.push({
        forceNew,
        workspaceMessages: targetWorkspace.messages.length,
      });
      return forceNew ? "office-thread-recreated" : "office-thread";
    },
    isConnected: true,
    isMissingThreadError: (error) =>
      error instanceof Error && error.message === "missing-thread",
    locale: "en",
    panel: captured.libraryPanel,
    persistOfficeMessage: async (
      _panel,
      _workspaceBeforeMessage,
      _message,
      text,
      threadId,
      fallbackWorkspace,
    ) => {
      captured.persistedMessages.push({ text, threadId });
      return officeConfig({ ...fallbackWorkspace, threadId });
    },
    recordOfficeRunTurn: (turnId, record) => {
      captured.runRecords[turnId] = record;
    },
    runOfficeMessage: async () => ({
      cwd: "/repo",
      handled: false,
      response: null,
    }),
    setActiveTurnByThread: (updater) => {
      captured.activeTurns = updater(captured.activeTurns);
    },
    setLibraryPanel: (updater) => {
      captured.libraryPanel = updater(captured.libraryPanel);
    },
    setThreads: (updater) => {
      captured.threads = updater(captured.threads);
    },
    startTurn: async (threadId, input) => {
      captured.startedTurns.push({ threadId, input });
      return { turn: turn({ id: `turn-${threadId}` }) };
    },
    text: "Ship it",
    ...overrides,
  };
}

describe("office message actions", () => {
  it("updates the office locally when disconnected", async () => {
    const captured = state();
    const handled = await sendOfficeMessageAction(
      baseParams(captured, {
        isConnected: false,
      }),
    );

    expect(handled).toBe(true);
    expect(captured.ensuredThreads).toEqual([]);
    expect(captured.libraryPanel?.workspace?.messages).toEqual([
      {
        author: "Coordinator",
        glyph: "@",
        accent: "slate",
        time: "now",
        kind: "message",
        text: "Ship it",
      },
      {
        author: "System",
        glyph: "⌗",
        accent: "green",
        time: "now",
        kind: "message",
        text: "local reply",
      },
    ]);
  });

  it("records backend run responses and skips fallback persistence", async () => {
    const captured = state(panel(workspace({ threadId: "run-thread" })));
    captured.threads = [thread({ id: "run-thread" })];
    const response = runResponse();
    const handled = await sendOfficeMessageAction(
      baseParams(captured, {
        runOfficeMessage: async (_panel, _workspace, _message, _text, threadId) => {
          captured.runThreads.push(threadId);
          return {
            cwd: "/repo",
            handled: true,
            response,
          };
        },
      }),
    );

    expect(handled).toBe(true);
    expect(captured.runThreads).toEqual(["office-thread"]);
    expect(captured.persistedMessages).toEqual([]);
    expect(captured.startedTurns).toEqual([]);
    expect(captured.runRecords).toEqual({
      "run-turn": {
        cwd: "/repo",
        runId: "run-1",
        threadId: "run-thread",
        turnThreadId: "run-thread",
        config: response.config,
      },
    });
    expect(captured.activeTurns).toEqual({ "run-thread": "run-turn" });
    expect(captured.threads[0]?.turns).toEqual([response.turn]);
    expect(captured.libraryPanel?.workspace?.threadId).toBe("run-thread");
  });

  it("falls back to turn start and message persistence when run API is unavailable", async () => {
    const captured = state();
    const handled = await sendOfficeMessageAction(baseParams(captured));

    expect(handled).toBe(true);
    expect(captured.ensuredThreads).toEqual([
      { forceNew: undefined, workspaceMessages: 1 },
    ]);
    expect(captured.startedTurns).toEqual([
      {
        threadId: "office-thread",
        input: [
          'Office "Office" group chat message: Ship it',
          "Manager agent: first decide whether this message is a question, status nudge, added context, or new actionable goal before planning or delegating tasks.",
          "Backend record: submitted to office/message/send",
          "Execution thread: office-thread",
        ].join("\n"),
      },
    ]);
    expect(captured.persistedMessages).toEqual([
      { text: "Ship it", threadId: "office-thread" },
    ]);
    expect(captured.activeTurns).toEqual({
      "office-thread": "turn-office-thread",
    });
    expect(captured.libraryPanel?.workspace?.backendStatus).toBe("connected");
    expect(captured.libraryPanel?.workspace?.messages).toHaveLength(1);
  });

  it("recreates missing threads for run and turn fallback", async () => {
    const captured = state();
    let runCalls = 0;
    let startCalls = 0;
    const handled = await sendOfficeMessageAction(
      baseParams(captured, {
        runOfficeMessage: async () => {
          runCalls += 1;
          if (runCalls === 1) {
            throw new Error("missing-thread");
          }
          return {
            cwd: "/repo",
            handled: false,
            response: null,
          };
        },
        startTurn: async (threadId, input) => {
          startCalls += 1;
          if (startCalls === 1) {
            throw new Error("missing-thread");
          }
          captured.startedTurns.push({ threadId, input });
          return { turn: turn({ id: `turn-${threadId}` }) };
        },
      }),
    );

    expect(handled).toBe(true);
    expect(captured.ensuredThreads).toEqual([
      { forceNew: undefined, workspaceMessages: 1 },
      { forceNew: true, workspaceMessages: 1 },
      { forceNew: true, workspaceMessages: 1 },
    ]);
    expect(captured.startedTurns[0]?.threadId).toBe("office-thread-recreated");
    expect(captured.persistedMessages).toEqual([
      { text: "Ship it", threadId: "office-thread-recreated" },
    ]);
    expect(captured.activeTurns).toEqual({
      "office-thread-recreated": "turn-office-thread-recreated",
    });
  });

  it("marks the office workspace as errored on backend failure", async () => {
    const captured = state();
    const handled = await sendOfficeMessageAction(
      baseParams(captured, {
        runOfficeMessage: async () => {
          throw new Error("backend failed");
        },
      }),
    );

    expect(handled).toBe(true);
    expect(captured.libraryPanel?.workspace?.backendStatus).toBe("error");
    expect(captured.libraryPanel?.workspace?.messages.at(-1)).toMatchObject({
      author: "System",
      glyph: "⌗",
      accent: "rose",
      text: "backend failed",
    });
  });

  it("does nothing without an office workspace", async () => {
    const captured = state(null);
    const handled = await sendOfficeMessageAction(baseParams(captured));

    expect(handled).toBe(false);
    expect(captured.libraryPanel).toBeNull();
    expect(captured.ensuredThreads).toEqual([]);
  });
});
