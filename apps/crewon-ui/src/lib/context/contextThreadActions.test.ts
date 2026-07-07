import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  contextThreadActionForActionId,
  createContextThreadActionHandlers,
  type ContextThreadActionHandlersParams,
} from "./contextThreadActions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

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

function baseParams(
  overrides: Partial<ContextThreadActionHandlersParams> = {},
): ContextThreadActionHandlersParams {
  let panel: CapabilityPanel | null = {
    title: "Files",
    body: "Ready",
  };
  let notice: NoticeState | null = null;
  let threads = [thread()];
  let selectedThreadId = "thread-1";
  let activeTurns: Record<string, string> = {};
  return {
    busyToolId: null,
    client: {
      async resumeThread(threadId) {
        return thread({ id: threadId });
      },
      async startTurn() {
        return turnStartResponse();
      },
    },
    createThread: async () => thread({ id: "created-thread" }),
    isConnected: true,
    locale: "en",
    pendingContextFile: {
      path: "/repo/README.md",
      text: "Project notes",
    },
    selectedThread: thread(),
    setActiveTurnByThread: (updater) => {
      activeTurns = updater(activeTurns);
    },
    setBusyToolId: () => {},
    setCapabilityPanel: (updater) => {
      panel = updater(panel);
    },
    setNotice: (nextNotice) => {
      notice = nextNotice;
    },
    setSelectedThreadId: (threadId) => {
      selectedThreadId = threadId;
    },
    setThreads: (updater) => {
      threads = updater(threads);
    },
    threadId: "thread-1",
    ...overrides,
  };
}

describe("context thread actions", () => {
  it("maps context thread action ids", () => {
    expect(contextThreadActionForActionId("send-context-to-thread")).toBe(
      "sendContext",
    );
    expect(contextThreadActionForActionId("search-files")).toBeNull();
  });

  it("sends context to the selected backend thread", async () => {
    let panel: CapabilityPanel | null = {
      title: "Files",
      body: "Ready",
    };
    let notice: NoticeState | null = null;
    let threads = [thread()];
    let selectedThreadId = "";
    let activeTurns: Record<string, string> = {};
    const prompts: Array<{ text: string; threadId: string }> = [];
    const handlers = createContextThreadActionHandlers(
      baseParams({
        client: {
          async resumeThread(threadId) {
            return thread({ id: threadId });
          },
          async startTurn(threadId, text) {
            prompts.push({ text, threadId });
            return turnStartResponse({ turn: turn({ id: "turn-2" }) });
          },
        },
        setActiveTurnByThread: (updater) => {
          activeTurns = updater(activeTurns);
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setNotice: (nextNotice) => {
          notice = nextNotice;
        },
        setSelectedThreadId: (threadId) => {
          selectedThreadId = threadId;
        },
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    );

    handlers.sendContext();
    await flushAsyncAction();

    expect(prompts).toEqual([
      {
        threadId: "thread-1",
        text: expect.stringContaining("Project notes"),
      },
    ]);
    expect(threads[0]?.turns).toEqual([turn({ id: "turn-2" })]);
    expect(selectedThreadId).toBe("thread-1");
    expect(activeTurns).toEqual({ "thread-1": "turn-2" });
    expect(panel).toMatchObject({
      body: "Sent to backend thread: Preview",
      error: undefined,
    });
    expect(notice).toEqual({
      text: "Context file sent to backend thread",
      tone: "success",
    });
  });

  it("resumes a not-loaded thread before sending context", async () => {
    const calls: string[] = [];
    const handlers = createContextThreadActionHandlers(
      baseParams({
        client: {
          async resumeThread(threadId) {
            calls.push(`resume:${threadId}`);
            return thread({ id: threadId, preview: "Resumed" });
          },
          async startTurn(threadId) {
            calls.push(`start:${threadId}`);
            return turnStartResponse();
          },
        },
        selectedThread: thread({
          status: { type: "notLoaded" } as Thread["status"],
        }),
      }),
    );

    handlers.sendContext();
    await flushAsyncAction();

    expect(calls).toEqual(["resume:thread-1", "start:thread-1"]);
  });

  it("creates a thread when no backend thread is selected", async () => {
    let selectedThreadId = "";
    const createdWith: string[] = [];
    const prompts: Array<{ text: string; threadId: string }> = [];
    const handlers = createContextThreadActionHandlers(
      baseParams({
        createThread: async (initialPrompt) => {
          createdWith.push(initialPrompt ?? "");
          return thread({ id: "created-thread", preview: "Created" });
        },
        client: {
          async resumeThread(threadId) {
            return thread({ id: threadId });
          },
          async startTurn(threadId, text) {
            prompts.push({ text, threadId });
            return turnStartResponse();
          },
        },
        selectedThread: null,
        setSelectedThreadId: (threadId) => {
          selectedThreadId = threadId;
        },
        threadId: null,
      }),
    );

    handlers.sendContext();
    await flushAsyncAction();

    expect(createdWith).toEqual(["Read workspace context: /repo/README.md"]);
    expect(prompts[0]).toMatchObject({ threadId: "created-thread" });
    expect(selectedThreadId).toBe("created-thread");
  });

  it("does nothing without pending context", () => {
    let called = false;
    const handlers = createContextThreadActionHandlers(
      baseParams({
        client: {
          async resumeThread(threadId) {
            return thread({ id: threadId });
          },
          async startTurn() {
            called = true;
            return turnStartResponse();
          },
        },
        pendingContextFile: null,
      }),
    );

    handlers.sendContext();

    expect(called).toBe(false);
  });
});
