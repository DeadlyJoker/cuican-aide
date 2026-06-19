import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";
import { describe, expect, it } from "vitest";

import type { PendingComposerMention } from "../shared/composerMentions";
import type { NoticeState } from "../shared/noticeState";
import {
  createDemoThreadAction,
  createThreadAction,
  interruptActiveTurnAction,
  sendMessageAction,
  type InterruptActiveTurnActionParams,
  type SendMessageActionParams,
} from "./threadMessageActions";

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

function threadState(initialThreads: Thread[] = [thread()]) {
  let threads = initialThreads;
  let selectedThreadId: string | null = initialThreads[0]?.id ?? null;
  let notice: NoticeState | null = null;
  let activeTurns: Record<string, string> = {};
  let composerValue = "";
  let focusSignal = 0;
  let pendingMentions: PendingComposerMention[] = [
    { name: "Files", path: "app://files" },
  ];
  let isSending = false;
  return {
    get activeTurns() {
      return activeTurns;
    },
    get composerValue() {
      return composerValue;
    },
    get focusSignal() {
      return focusSignal;
    },
    get isSending() {
      return isSending;
    },
    get notice() {
      return notice;
    },
    get pendingMentions() {
      return pendingMentions;
    },
    get selectedThreadId() {
      return selectedThreadId;
    },
    get threads() {
      return threads;
    },
    setActiveTurnByThread: (
      updater: (current: Record<string, string>) => Record<string, string>,
    ) => {
      activeTurns = updater(activeTurns);
    },
    setComposerFocusSignal: (updater: (signal: number) => number) => {
      focusSignal = updater(focusSignal);
    },
    setComposerValue: (value: string) => {
      composerValue = value;
    },
    setIsSending: (nextIsSending: boolean) => {
      isSending = nextIsSending;
    },
    setNotice: (nextNotice: NoticeState | null) => {
      notice = nextNotice;
    },
    setPendingComposerMentions: (mentions: PendingComposerMention[]) => {
      pendingMentions = mentions;
    },
    setSelectedThreadId: (threadId: string | null) => {
      selectedThreadId = threadId;
    },
    setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => {
      threads = updater(threads);
    },
  };
}

function baseSendParams(
  overrides: Partial<SendMessageActionParams> = {},
): SendMessageActionParams {
  const state = threadState();
  return {
    activeTurnId: null,
    client: {
      async resumeThread(threadId) {
        return thread({ id: threadId, status: { type: "idle" } });
      },
      async startTurn() {
        return turnStartResponse();
      },
      async steerTurn() {
        return { turnId: "turn-steered" };
      },
    },
    createThread: async () => thread(),
    demoResponse: "Demo response",
    isConnected: true,
    isDemoPreview: false,
    isSending: false,
    locale: "en",
    pendingComposerMentions: state.pendingMentions,
    preserveThreadsAfterConnectionLoss: () => {},
    selectedThread: thread(),
    selectedThreadId: "thread-1",
    setActiveTurnByThread: state.setActiveTurnByThread,
    setComposerFocusSignal: state.setComposerFocusSignal,
    setComposerValue: state.setComposerValue,
    setIsSending: state.setIsSending,
    setNotice: state.setNotice,
    setPendingComposerMentions: state.setPendingComposerMentions,
    setSelectedThreadId: state.setSelectedThreadId,
    setThreads: state.setThreads,
    text: "Hello",
    ...overrides,
  };
}

describe("thread message actions", () => {
  it("creates a demo thread when disconnected", () => {
    const state = threadState([]);
    let inspectorOpen = true;
    let sidebarOpen = true;

    const createdThread = createDemoThreadAction({
      initialPrompt: "Write tests for message flow",
      locale: "en",
      newDraftPreview: "Draft",
      newDraftThread: "New draft",
      setInspectorOpen: (open) => {
        inspectorOpen = open;
      },
      setSelectedThreadId: state.setSelectedThreadId,
      setSidebarOpen: (open) => {
        sidebarOpen = open;
      },
      setThreads: state.setThreads,
      shouldAutoCloseSidebar: () => true,
    });

    expect(createdThread.id).toMatch(/^demo-/);
    expect(createdThread.preview).toBe("Write tests for message flow");
    expect(state.threads[0]).toEqual(createdThread);
    expect(state.selectedThreadId).toBe(createdThread.id);
    expect(inspectorOpen).toBe(false);
    expect(sidebarOpen).toBe(false);
  });

  it("starts a backend thread and selects it", async () => {
    const state = threadState([]);
    let sidebarOpen = true;
    const starts: Array<{ cwd?: string; source?: string }> = [];

    const createdThread = await createThreadAction({
      client: {
        async startThread(cwd, source) {
          starts.push({ cwd, source });
          return thread({ id: "thread-created" });
        },
      },
      createDemoThread: () => thread({ id: "demo-thread" }),
      initialPrompt: "Build",
      isConnected: true,
      locale: "en",
      preserveThreadsAfterConnectionLoss: () => {},
      resolveBackendCwd: async () => "/repo",
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setSidebarOpen: (open) => {
        sidebarOpen = open;
      },
      setThreads: state.setThreads,
      shouldAutoCloseSidebar: () => true,
      threadSource: "agent",
    });

    expect(starts).toEqual([{ cwd: "/repo", source: "agent" }]);
    expect(createdThread?.id).toBe("thread-created");
    expect(state.threads.map((item) => item.id)).toEqual(["thread-created"]);
    expect(state.selectedThreadId).toBe("thread-created");
    expect(sidebarOpen).toBe(false);
  });

  it("preserves threads when backend thread creation fails", async () => {
    const state = threadState();
    let preserved = false;

    const createdThread = await createThreadAction({
      client: {
        async startThread() {
          throw new Error("create failed");
        },
      },
      createDemoThread: () => thread({ id: "demo-thread" }),
      isConnected: true,
      locale: "en",
      preserveThreadsAfterConnectionLoss: () => {
        preserved = true;
      },
      resolveBackendCwd: async () => "/repo",
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setSidebarOpen: () => {},
      setThreads: state.setThreads,
      shouldAutoCloseSidebar: () => false,
    });

    expect(createdThread).toBeNull();
    expect(preserved).toBe(true);
    expect(state.notice).toEqual({ text: "create failed", tone: "warning" });
  });

  it("steers an active turn instead of starting a new one", async () => {
    const state = threadState();
    const steerCalls: Array<{
      mentions: PendingComposerMention[];
      text: string;
      threadId: string;
    }> = [];

    await sendMessageAction(
      baseSendParams({
        activeTurnId: "turn-active",
        client: {
          async resumeThread(threadId) {
            return thread({ id: threadId });
          },
          async startTurn() {
            throw new Error("should not start turn");
          },
          async steerTurn(threadId, text, mentions = []) {
            steerCalls.push({ mentions, text, threadId });
            return { turnId: "turn-steered" };
          },
        },
        setActiveTurnByThread: state.setActiveTurnByThread,
        setIsSending: state.setIsSending,
        setNotice: state.setNotice,
        setPendingComposerMentions: state.setPendingComposerMentions,
      }),
    );

    expect(steerCalls).toEqual([
      {
        mentions: [{ name: "Files", path: "app://files" }],
        text: "Hello",
        threadId: "thread-1",
      },
    ]);
    expect(state.pendingMentions).toEqual([]);
    expect(state.activeTurns).toEqual({ "thread-1": "turn-steered" });
    expect(state.notice).toEqual({
      text: "Added guidance to the current turn",
      tone: "success",
    });
    expect(state.isSending).toBe(false);
  });

  it("creates demo thread content when disconnected", async () => {
    const state = threadState([]);
    const demoThread = thread({ id: "demo-thread", preview: "", turns: [] });

    await sendMessageAction(
      baseSendParams({
        client: null,
        createThread: async () => {
          state.setThreads(() => [demoThread]);
          return demoThread;
        },
        isConnected: false,
        selectedThread: null,
        selectedThreadId: null,
        setIsSending: state.setIsSending,
        setThreads: state.setThreads,
      }),
    );

    expect(state.threads[0]?.turns).toHaveLength(1);
    expect(state.threads[0]?.preview).toBe("Hello");
    expect(state.threads[0]?.name).toBe("Hello");
    expect(state.isSending).toBe(false);
  });

  it("resumes not loaded threads before starting a turn", async () => {
    const state = threadState([
      thread({ id: "thread-1", status: { type: "notLoaded" } }),
    ]);
    const calls: string[] = [];

    await sendMessageAction(
      baseSendParams({
        client: {
          async resumeThread(threadId) {
            calls.push(`resume:${threadId}`);
            return thread({ id: threadId, status: { type: "idle" } });
          },
          async startTurn(threadId) {
            calls.push(`start:${threadId}`);
            return turnStartResponse({ turn: turn({ id: "turn-started" }) });
          },
          async steerTurn() {
            throw new Error("should not steer");
          },
        },
        selectedThread: thread({ id: "thread-1", status: { type: "notLoaded" } }),
        setActiveTurnByThread: state.setActiveTurnByThread,
        setIsSending: state.setIsSending,
        setPendingComposerMentions: state.setPendingComposerMentions,
        setSelectedThreadId: state.setSelectedThreadId,
        setThreads: state.setThreads,
      }),
    );

    expect(calls).toEqual(["resume:thread-1", "start:thread-1"]);
    expect(state.selectedThreadId).toBe("thread-1");
    expect(state.threads[0]?.turns.map((item) => item.id)).toEqual([
      "turn-started",
    ]);
    expect(state.activeTurns).toEqual({ "thread-1": "turn-started" });
    expect(state.pendingMentions).toEqual([]);
  });

  it("restores composer text and preserves threads after send failure", async () => {
    const state = threadState();
    let preserved = false;

    await sendMessageAction(
      baseSendParams({
        client: {
          async resumeThread(threadId) {
            return thread({ id: threadId });
          },
          async startTurn() {
            throw new Error("send failed");
          },
          async steerTurn() {
            throw new Error("should not steer");
          },
        },
        preserveThreadsAfterConnectionLoss: () => {
          preserved = true;
        },
        setComposerFocusSignal: state.setComposerFocusSignal,
        setComposerValue: state.setComposerValue,
        setIsSending: state.setIsSending,
        setNotice: state.setNotice,
        setPendingComposerMentions: state.setPendingComposerMentions,
        text: "Keep this text",
      }),
    );

    expect(preserved).toBe(true);
    expect(state.pendingMentions).toEqual([]);
    expect(state.composerValue).toBe("Keep this text");
    expect(state.focusSignal).toBe(1);
    expect(state.notice).toEqual({ text: "send failed", tone: "warning" });
    expect(state.isSending).toBe(false);
  });

  it("interrupts the active turn", async () => {
    const state = threadState();
    const interrupts: Array<{ threadId: string; turnId: string }> = [];

    await interruptActiveTurnAction({
      activeTurnId: "turn-1",
      client: {
        async interruptTurn(threadId, turnId) {
          interrupts.push({ threadId, turnId });
        },
      },
      isConnected: true,
      locale: "en",
      selectedThreadId: "thread-1",
      setIsSending: state.setIsSending,
      setNotice: state.setNotice,
    } satisfies InterruptActiveTurnActionParams);

    expect(interrupts).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
    expect(state.notice).toEqual({
      text: "Requested stop for current turn",
      tone: "success",
    });
    expect(state.isSending).toBe(false);
  });
});
