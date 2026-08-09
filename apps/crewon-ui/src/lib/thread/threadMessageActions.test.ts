import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";
import type { ThreadExecutionContext } from "@crewon-platform-protocol/v2/ThreadExecutionContext";
import { describe, expect, it, vi } from "vitest";

import type { PendingComposerMention } from "../shared/composerMentions";
import type { ComposerImageInput } from "../shared/composerImages";
import type { NoticeState } from "../shared/noticeState";
import type { ThreadRuntimeSettings } from "./threadRuntimeSettings";
import {
  createDemoThreadAction,
  createThreadAction,
  interruptActiveTurnAction,
  sendMessageAction,
  type InterruptActiveTurnActionParams,
  type SendMessageActionParams,
  visibleComposerMentionsForText,
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
  it("keeps pending composer mentions only while their visible tokens remain", () => {
    expect(
      visibleComposerMentionsForText("$files summarize", [
        { name: "Files", path: "app://files", token: "$files" },
        { name: "Browser", path: "app://browser", token: "$browser" },
        { name: "Pinned", path: "app://pinned" },
      ]),
    ).toEqual([
      { name: "Files", path: "app://files", token: "$files" },
      { name: "Pinned", path: "app://pinned" },
    ]);
  });

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
    const threadSettings: ThreadRuntimeSettings = {
      approvalPolicy: "on-failure",
      model: "gpt-5.6-sol",
      sandboxMode: "workspace-write",
    };
    const starts: Array<{
      cwd?: string;
      settings?: ThreadRuntimeSettings;
      source?: string;
    }> = [];

    const createdThread = await createThreadAction({
      client: {
        async startThread(cwd, source, settings) {
          starts.push({ cwd, settings, source });
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
      threadSettings,
      threadSource: "agent",
    });

    expect(starts).toEqual([
      { cwd: "/repo", settings: threadSettings, source: "agent" },
    ]);
    expect(createdThread?.id).toBe("thread-created");
    expect(state.threads.map((item) => item.id)).toEqual(["thread-created"]);
    expect(state.selectedThreadId).toBe("thread-created");
    expect(sidebarOpen).toBe(false);
  });

  it("creates durable thread authority before binding Provider resources", async () => {
    const state = threadState([]);
    const calls: string[] = [];
    const created = thread({ id: "thread-provider" });
    const executionContext = {
      threadId: created.id,
      workspace: {
        workspaceKey: "workspace-1",
        bindingId: "workspace-binding-1",
        scope: "conversation",
        scopeId: created.id,
        nodeId: "node-1",
        environmentId: "env-1",
      },
      resourceBindings: [],
      executionBinding: null,
      revision: 1n,
      createdAt: 1n,
      updatedAt: 1n,
    } satisfies ThreadExecutionContext;

    const result = await createThreadAction({
      client: {
        async startThread() {
          throw new Error("legacy start must not be used");
        },
        async startThreadWithExecutionContext(workspaceKey) {
          calls.push(`start:${workspaceKey}`);
          return { thread: created, executionContext };
        },
      },
      createDemoThread: () => thread({ id: "demo-thread" }),
      executionContextPreparation: {
        workspaceKey: "workspace-1",
        async afterStart(threadValue, context) {
          calls.push(`bind:${threadValue.id}:${context.revision}`);
        },
      },
      isConnected: true,
      locale: "en",
      preserveThreadsAfterConnectionLoss: () => {},
      resolveBackendCwd: async () => "/repo",
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setSidebarOpen: () => {},
      setThreads: state.setThreads,
      shouldAutoCloseSidebar: () => false,
    });

    expect(calls).toEqual(["start:workspace-1", "bind:thread-provider:1"]);
    expect(result).toEqual(created);
    expect(state.threads).toEqual([created]);
  });

  it("deletes an empty authority thread when Provider binding fails", async () => {
    const state = threadState([]);
    const deleted: string[] = [];
    const created = thread({ id: "thread-provider-failed" });
    const executionContext = {
      threadId: created.id,
      workspace: {
        workspaceKey: "workspace-1",
        bindingId: "workspace-binding-1",
        scope: "conversation",
        scopeId: created.id,
        nodeId: "node-1",
        environmentId: "env-1",
      },
      resourceBindings: [],
      executionBinding: null,
      revision: 1n,
      createdAt: 1n,
      updatedAt: 1n,
    } satisfies ThreadExecutionContext;

    const result = await createThreadAction({
      client: {
        async deleteThread(threadId) {
          deleted.push(threadId);
        },
        async startThread() {
          throw new Error("legacy start must not be used");
        },
        async startThreadWithExecutionContext() {
          return { thread: created, executionContext };
        },
      },
      createDemoThread: () => thread({ id: "demo-thread" }),
      executionContextPreparation: {
        workspaceKey: "workspace-1",
        async afterStart() {
          throw new Error("binding failed");
        },
      },
      isConnected: true,
      locale: "en",
      preserveThreadsAfterConnectionLoss: () => {},
      resolveBackendCwd: async () => "/repo",
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setSidebarOpen: () => {},
      setThreads: state.setThreads,
      shouldAutoCloseSidebar: () => false,
    });

    expect(result).toBeNull();
    expect(deleted).toEqual([created.id]);
    expect(state.threads).toEqual([]);
  });

  it("uses an explicit new-task workspace without resolving a fallback", async () => {
    const state = threadState([]);
    const resolveBackendCwd = vi.fn(async () => "/repo/fallback");
    const starts: Array<string | undefined> = [];

    await createThreadAction({
      client: {
        async startThread(cwd) {
          starts.push(cwd);
          return thread({ cwd, id: "thread-workspace" });
        },
      },
      createDemoThread: () => thread({ id: "demo-thread" }),
      isConnected: true,
      locale: "en",
      preserveThreadsAfterConnectionLoss: () => {},
      resolveBackendCwd,
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setSidebarOpen: () => {},
      setThreads: state.setThreads,
      shouldAutoCloseSidebar: () => false,
      workspaceCwd: "/repo/selected",
    });

    expect(resolveBackendCwd).not.toHaveBeenCalled();
    expect(starts).toEqual(["/repo/selected"]);
    expect(state.threads[0]?.cwd).toBe("/repo/selected");
  });

  it("omits cwd for an explicitly workspace-less new task", async () => {
    const state = threadState([]);
    const resolveBackendCwd = vi.fn(async () => "/repo/fallback");
    const starts: Array<string | undefined> = [];

    await createThreadAction({
      client: {
        async startThread(cwd) {
          starts.push(cwd);
          return thread({ id: "thread-standalone" });
        },
      },
      createDemoThread: () => thread({ id: "demo-thread" }),
      isConnected: true,
      locale: "en",
      preserveThreadsAfterConnectionLoss: () => {},
      resolveBackendCwd,
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setSidebarOpen: () => {},
      setThreads: state.setThreads,
      shouldAutoCloseSidebar: () => false,
      workspaceCwd: null,
    });

    expect(resolveBackendCwd).not.toHaveBeenCalled();
    expect(starts).toEqual([undefined]);
  });

  it("keeps the connection state when Provider preparation fails", async () => {
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
    expect(preserved).toBe(false);
    expect(state.notice).toEqual({ text: "create failed", tone: "warning" });
  });

  it("marks a real connection close during thread creation", async () => {
    const state = threadState();
    let preserved = false;

    await createThreadAction({
      client: {
        async startThread() {
          throw new Error("App-server connection closed");
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

    expect(preserved).toBe(true);
    expect(state.notice).toEqual({
      text: "App-server connection closed",
      tone: "warning",
    });
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

  it("filters removed slash mentions before steering an active turn", async () => {
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
        pendingComposerMentions: [
          { name: "Files", path: "app://files", token: "$files" },
        ],
        setActiveTurnByThread: state.setActiveTurnByThread,
        setIsSending: state.setIsSending,
        setNotice: state.setNotice,
        setPendingComposerMentions: state.setPendingComposerMentions,
        text: "Hello",
      }),
    );

    expect(steerCalls).toEqual([
      {
        mentions: [],
        text: "Hello",
        threadId: "thread-1",
      },
    ]);
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
        selectedThread: thread({
          id: "thread-1",
          status: { type: "notLoaded" },
        }),
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

  it("updates existing thread runtime settings before starting a turn", async () => {
    const state = threadState();
    const threadSettings: ThreadRuntimeSettings = {
      approvalPolicy: "never",
      model: "gpt-5.5",
      sandboxMode: "danger-full-access",
    };
    const calls: Array<{
      method: "start" | "settings";
      settings?: ThreadRuntimeSettings;
      threadId: string;
    }> = [];

    await sendMessageAction(
      baseSendParams({
        client: {
          async resumeThread(threadId) {
            return thread({ id: threadId });
          },
          async startTurn(_threadId, _text, _mentions, settings) {
            calls.push({ method: "start", settings, threadId: _threadId });
            return turnStartResponse({ turn: turn({ id: "turn-started" }) });
          },
          async steerTurn() {
            throw new Error("should not steer");
          },
          async updateThreadSettings(threadId, settings) {
            calls.push({ method: "settings", settings, threadId });
          },
        },
        setActiveTurnByThread: state.setActiveTurnByThread,
        setIsSending: state.setIsSending,
        setPendingComposerMentions: state.setPendingComposerMentions,
        setSelectedThreadId: state.setSelectedThreadId,
        setThreads: state.setThreads,
        threadSettings,
      }),
    );

    expect(calls).toEqual([
      { method: "settings", settings: threadSettings, threadId: "thread-1" },
      { method: "start", settings: threadSettings, threadId: "thread-1" },
    ]);
  });

  it.each(["goal", "plan"] as const)(
    "submits %s only through atomic startTurn and acknowledges its visible reset",
    async (executionIntent) => {
      const state = threadState();
      const calls: Array<{
        images: ComposerImageInput[];
        mentions: PendingComposerMention[];
        settings?: ThreadRuntimeSettings;
        text: string;
        threadId: string;
      }> = [];
      const legacySetGoal = vi.fn(async () => undefined);
      const legacyClearGoal = vi.fn(async () => undefined);
      const committedIntents: Array<"goal" | "plan"> = [];
      const settings: ThreadRuntimeSettings = {
        executionIntent,
        model: "gpt-5.6-sol",
      };
      const images: ComposerImageInput[] = [
        { detail: "high", url: "data:image/png;base64,AA==" },
      ];
      const client = {
        clearThreadGoal: legacyClearGoal,
        async resumeThread(threadId: string) {
          return thread({ id: threadId });
        },
        setThreadGoal: legacySetGoal,
        async startTurn(
          threadId: string,
          text: string,
          mentions: PendingComposerMention[] = [],
          turnSettings?: ThreadRuntimeSettings,
          turnImages: ComposerImageInput[] = [],
        ) {
          calls.push({
            images: turnImages,
            mentions,
            settings: turnSettings,
            text,
            threadId,
          });
          return turnStartResponse({ turn: turn({ id: "turn-started" }) });
        },
        async steerTurn() {
          throw new Error("should not steer");
        },
      };

      await sendMessageAction(
        baseSendParams({
          client,
          images,
          onExecutionIntentCommitted: (intent) => {
            committedIntents.push(intent);
          },
          setActiveTurnByThread: state.setActiveTurnByThread,
          setIsSending: state.setIsSending,
          setPendingComposerMentions: state.setPendingComposerMentions,
          setThreads: state.setThreads,
          threadSettings: settings,
        }),
      );

      expect(legacySetGoal).not.toHaveBeenCalled();
      expect(legacyClearGoal).not.toHaveBeenCalled();
      expect(calls).toEqual([
        {
          images,
          mentions: [{ name: "Files", path: "app://files" }],
          settings,
          text: "Hello",
          threadId: "thread-1",
        },
      ]);
      expect(committedIntents).toEqual([executionIntent]);
      expect(state.threads[0]?.turns.map((item) => item.id)).toEqual([
        "turn-started",
      ]);
    },
  );

  it("waits for the atomic startTurn response before acknowledging Goal", async () => {
    const state = threadState();
    const committed = vi.fn();
    let releaseStart!: (response: TurnStartResponse) => void;
    let markStartReached!: () => void;
    const startReached = new Promise<void>((resolve) => {
      markStartReached = resolve;
    });
    const startResponse = new Promise<TurnStartResponse>((resolve) => {
      releaseStart = resolve;
    });

    const sending = sendMessageAction(
      baseSendParams({
        client: {
          async resumeThread(threadId) {
            return thread({ id: threadId });
          },
          async startTurn() {
            markStartReached();
            return startResponse;
          },
          async steerTurn() {
            throw new Error("should not steer");
          },
        },
        onExecutionIntentCommitted: committed,
        setActiveTurnByThread: state.setActiveTurnByThread,
        setIsSending: state.setIsSending,
        setPendingComposerMentions: state.setPendingComposerMentions,
        setThreads: state.setThreads,
        threadSettings: { executionIntent: "goal" },
      }),
    );

    await startReached;
    expect(committed).not.toHaveBeenCalled();
    releaseStart(turnStartResponse({ turn: turn({ id: "turn-started" }) }));
    await sending;
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledWith("goal");
  });

  it("does not acknowledge a visible Goal reset when atomic startTurn fails", async () => {
    const state = threadState();
    const legacySetGoal = vi.fn(async () => undefined);
    const legacyClearGoal = vi.fn(async () => undefined);
    const committedIntents: Array<"goal" | "plan"> = [];
    const client = {
      clearThreadGoal: legacyClearGoal,
      async resumeThread(threadId: string) {
        return thread({ id: threadId });
      },
      setThreadGoal: legacySetGoal,
      async startTurn() {
        throw new Error("atomic Goal start failed");
      },
      async steerTurn() {
        throw new Error("should not steer");
      },
    };

    await sendMessageAction(
      baseSendParams({
        client,
        onExecutionIntentCommitted: (intent) => {
          committedIntents.push(intent);
        },
        setComposerFocusSignal: state.setComposerFocusSignal,
        setComposerValue: state.setComposerValue,
        setIsSending: state.setIsSending,
        setNotice: state.setNotice,
        setPendingComposerMentions: state.setPendingComposerMentions,
        setThreads: state.setThreads,
        text: "Keep Goal selected",
        threadSettings: { executionIntent: "goal" },
      }),
    );

    expect(legacySetGoal).not.toHaveBeenCalled();
    expect(legacyClearGoal).not.toHaveBeenCalled();
    expect(committedIntents).toEqual([]);
    expect(state.composerValue).toBe("Keep Goal selected");
    expect(state.notice).toEqual({
      text: "atomic Goal start failed",
      tone: "warning",
    });
    expect(state.threads[0]?.turns[0]).toMatchObject({ status: "failed" });
  });

  it("filters removed slash mentions before starting a turn", async () => {
    const state = threadState();
    const startCalls: Array<{
      mentions: PendingComposerMention[];
      text: string;
      threadId: string;
    }> = [];

    await sendMessageAction(
      baseSendParams({
        client: {
          async resumeThread(threadId) {
            return thread({ id: threadId });
          },
          async startTurn(threadId, text, mentions = []) {
            startCalls.push({ mentions, text, threadId });
            return turnStartResponse({ turn: turn({ id: "turn-started" }) });
          },
          async steerTurn() {
            throw new Error("should not steer");
          },
        },
        pendingComposerMentions: [
          { name: "Files", path: "app://files", token: "$files" },
          { name: "Browser", path: "app://browser", token: "$browser" },
          { name: "Pinned", path: "app://pinned" },
        ],
        setActiveTurnByThread: state.setActiveTurnByThread,
        setIsSending: state.setIsSending,
        setPendingComposerMentions: state.setPendingComposerMentions,
        setSelectedThreadId: state.setSelectedThreadId,
        setThreads: state.setThreads,
        text: "$files Hello",
      }),
    );

    expect(startCalls).toEqual([
      {
        mentions: [
          { name: "Files", path: "app://files", token: "$files" },
          { name: "Pinned", path: "app://pinned" },
        ],
        text: "$files Hello",
        threadId: "thread-1",
      },
    ]);
  });

  it("restores composer text without faking a disconnect after send failure", async () => {
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
        setThreads: state.setThreads,
        text: "Keep this text",
      }),
    );

    expect(preserved).toBe(false);
    expect(state.pendingMentions).toEqual([]);
    expect(state.composerValue).toBe("Keep this text");
    expect(state.focusSignal).toBe(1);
    expect(state.threads[0]?.turns).toHaveLength(1);
    expect(state.threads[0]?.turns[0]).toMatchObject({
      status: "failed",
      error: { message: "send failed" },
      items: [
        {
          type: "userMessage",
          content: [
            { type: "text", text: "Keep this text", text_elements: [] },
          ],
        },
      ],
    });
    expect(state.notice).toEqual({ text: "send failed", tone: "warning" });
    expect(state.isSending).toBe(false);
  });

  it("interrupts the active turn", async () => {
    const state = threadState([thread({ turns: [turn()] })]);
    state.setActiveTurnByThread(() => ({ "thread-1": "turn-1" }));
    const interrupts: Array<{ threadId: string; turnId: string }> = [];

    await interruptActiveTurnAction({
      activeTurnId: "turn-1",
      client: {
        async interruptTurn(threadId, turnId) {
          interrupts.push({ threadId, turnId });
        },
        async readThread(threadId) {
          return thread({
            id: threadId,
            turns: [turn({ status: "interrupted" })],
          });
        },
      },
      isConnected: true,
      locale: "en",
      selectedThreadId: "thread-1",
      setActiveTurnByThread: state.setActiveTurnByThread,
      setIsSending: state.setIsSending,
      setNotice: state.setNotice,
      setThreads: state.setThreads,
    } satisfies InterruptActiveTurnActionParams);

    expect(interrupts).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
    expect(state.activeTurns).toEqual({});
    expect(state.threads[0]?.turns[0]).toEqual(turn({ status: "interrupted" }));
    expect(state.notice).toEqual({
      text: "Requested stop for current turn",
      tone: "success",
    });
    expect(state.isSending).toBe(false);
  });

  it("uses standard turn interrupt for every active thread", async () => {
    const state = threadState([
      thread({
        turns: [turn({ id: "agent-platform-turn", status: "inProgress" })],
      }),
    ]);
    const interruptTurn = vi.fn(async () => undefined);

    await interruptActiveTurnAction({
      activeTurnId: "agent-platform-turn",
      client: {
        interruptTurn,
      },
      isConnected: true,
      locale: "en",
      selectedThreadId: "thread-1",
      setActiveTurnByThread: state.setActiveTurnByThread,
      setIsSending: state.setIsSending,
      setNotice: state.setNotice,
      setThreads: state.setThreads,
    });

    expect(interruptTurn).toHaveBeenCalledWith(
      "thread-1",
      "agent-platform-turn",
    );
    expect(state.threads[0]?.turns[0]?.status).toBe("interrupted");
  });
});
