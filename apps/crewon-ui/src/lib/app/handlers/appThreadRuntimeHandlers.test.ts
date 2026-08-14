import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Thread } from "@crewon-ui-model/v2/Thread";

import type { AppThreadRuntimeHandlersParams } from "./appThreadRuntimeHandlers";
import type {
  ArchiveThreadActionParams,
  DeleteArchivedThreadActionParams,
  RenameThreadActionParams,
  SelectThreadActionParams,
  ToggleArchivedThreadsActionParams,
} from "../../thread/threadListActions";
import type {
  CreateThreadActionParams,
  InterruptActiveTurnActionParams,
  SendMessageActionParams,
} from "../../thread/threadMessageActions";
import type {
  StartReviewActionParams,
  StartSideChatActionParams,
} from "../../thread/threadToolActions";

const threadListSpy = vi.hoisted(() => ({
  archiveParams: null as ArchiveThreadActionParams | null,
  deleteParams: null as DeleteArchivedThreadActionParams | null,
  renameParams: null as RenameThreadActionParams | null,
  selectParams: null as SelectThreadActionParams | null,
  toggleParams: null as ToggleArchivedThreadsActionParams | null,
  archive: vi.fn(async (params: ArchiveThreadActionParams) => {
    threadListSpy.archiveParams = params;
  }),
  delete: vi.fn(async (params: DeleteArchivedThreadActionParams) => {
    threadListSpy.deleteParams = params;
  }),
  rename: vi.fn(async (params: RenameThreadActionParams) => {
    threadListSpy.renameParams = params;
  }),
  select: vi.fn(async (params: SelectThreadActionParams) => {
    threadListSpy.selectParams = params;
  }),
  startDraft: vi.fn(),
  toggle: vi.fn(async (params: ToggleArchivedThreadsActionParams) => {
    threadListSpy.toggleParams = params;
    return !params.showArchivedThreads;
  }),
}));

const threadMessageSpy = vi.hoisted(() => ({
  createParams: null as CreateThreadActionParams | null,
  interruptParams: null as InterruptActiveTurnActionParams | null,
  sendParams: null as SendMessageActionParams | null,
  create: vi.fn(async (params: CreateThreadActionParams) => {
    threadMessageSpy.createParams = params;
    return thread("created-thread");
  }),
  interrupt: vi.fn(async (params: InterruptActiveTurnActionParams) => {
    threadMessageSpy.interruptParams = params;
  }),
  send: vi.fn(async (params: SendMessageActionParams) => {
    threadMessageSpy.sendParams = params;
  }),
}));

const threadToolSpy = vi.hoisted(() => ({
  reviewParams: null as StartReviewActionParams | null,
  sideChatParams: null as StartSideChatActionParams | null,
  review: vi.fn(async (params: StartReviewActionParams) => {
    threadToolSpy.reviewParams = params;
  }),
  sideChat: vi.fn(async (params: StartSideChatActionParams) => {
    threadToolSpy.sideChatParams = params;
  }),
}));

vi.mock("../../thread/threadListActions", () => ({
  archiveThreadAction: threadListSpy.archive,
  deleteArchivedThreadAction: threadListSpy.delete,
  renameThreadAction: threadListSpy.rename,
  selectThreadAction: threadListSpy.select,
  startDraftThreadAction: threadListSpy.startDraft,
  toggleArchivedThreadsAction: threadListSpy.toggle,
}));

vi.mock("../../thread/threadMessageActions", () => ({
  createThreadAction: threadMessageSpy.create,
  interruptActiveTurnAction: threadMessageSpy.interrupt,
  sendMessageAction: threadMessageSpy.send,
}));

vi.mock("../../thread/threadToolActions", () => ({
  startReviewAction: threadToolSpy.review,
  startSideChatAction: threadToolSpy.sideChat,
}));

const { createAppThreadRuntimeHandlers } = await import(
  "./appThreadRuntimeHandlers"
);

type AppThreadRuntimeTestClient = NonNullable<
  AppThreadRuntimeHandlersParams["client"]
>;

function client(
  overrides: Partial<AppThreadRuntimeTestClient> = {},
): AppThreadRuntimeTestClient {
  return overrides as AppThreadRuntimeTestClient;
}

function thread(id = "thread-1"): Thread {
  return {
    id,
    name: "Thread",
    status: { type: "loaded" },
    turns: [],
  } as unknown as Thread;
}

function runningThread(id = "thread-1", turnId = "turn-running"): Thread {
  return {
    ...thread(id),
    turns: [{ id: turnId, status: "inProgress", items: [] }],
  } as unknown as Thread;
}

function createParams(
  overrides: Partial<AppThreadRuntimeHandlersParams> = {},
): AppThreadRuntimeHandlersParams {
  return {
    activeTurnId: "turn-1",
    busyToolId: null,
    client: client(),
    confirm: () => true,
    getShowArchivedThreads: () => false,
    isConnected: true,
    isDemo: false,
    isSending: false,
    locale: "en",
    pendingComposerMentions: [],
    prompt: () => "Renamed",
    recordShowArchivedThreads: () => {},
    resolveBackendCwd: async () => "/repo",
    selectedThread: thread("selected-thread"),
    selectedThreadId: "selected-thread",
    setActiveTurnByThread: () => {},
    setAppView: () => {},
    setBusyToolId: () => {},
    setCapabilityPanel: () => {},
    setComposerFocusSignal: () => {},
    setComposerValue: () => {},
    setInspectorOpen: () => {},
    setIsSending: () => {},
    setNotice: () => {},
    setPendingComposerMentions: () => {},
    setSelectedThreadId: () => {},
    setShowArchivedThreads: () => {},
    setSidebarOpen: () => {},
    setThreadSearchTerm: () => {},
    setThreads: () => {},
    shouldAutoCloseSidebar: () => false,
    untitledThreadLabel: "Untitled",
    ...overrides,
  };
}

describe("app thread runtime handlers", () => {
  beforeEach(() => {
    threadListSpy.archiveParams = null;
    threadListSpy.deleteParams = null;
    threadListSpy.renameParams = null;
    threadListSpy.selectParams = null;
    threadListSpy.toggleParams = null;
    threadMessageSpy.createParams = null;
    threadMessageSpy.interruptParams = null;
    threadMessageSpy.sendParams = null;
    threadToolSpy.reviewParams = null;
    threadToolSpy.sideChatParams = null;
    vi.clearAllMocks();
  });

  it("wires thread list actions with current archived state and dialog dependencies", async () => {
    const confirm = vi.fn(() => true);
    const prompt = vi.fn(() => "Renamed");
    const selected = thread("thread-2");
    const handlers = createAppThreadRuntimeHandlers(
      createParams({
        confirm,
        getShowArchivedThreads: () => true,
        prompt,
      }),
    );

    await handlers.selectThread("thread-2");
    await handlers.archiveThread(selected);
    await handlers.deleteArchivedThread(selected);
    await handlers.renameThread(selected);

    expect(threadListSpy.selectParams?.threadId).toBe("thread-2");
    expect(threadListSpy.archiveParams?.showArchivedThreads).toBe(true);
    expect(threadListSpy.deleteParams?.confirm).toBe(confirm);
    expect(threadListSpy.deleteParams?.showArchivedThreads).toBe(true);
    expect(threadListSpy.renameParams?.prompt).toBe(prompt);
  });

  it("records the archived visibility returned by the toggle action", async () => {
    const recordShowArchivedThreads = vi.fn();
    const handlers = createAppThreadRuntimeHandlers(
      createParams({
        getShowArchivedThreads: () => false,
        recordShowArchivedThreads,
      }),
    );

    await handlers.toggleArchivedThreads();

    expect(threadListSpy.toggleParams?.showArchivedThreads).toBe(false);
    expect(recordShowArchivedThreads).toHaveBeenCalledWith(true);
  });

  it("keeps createThread shared between direct creation and sendMessage", async () => {
    const handlers = createAppThreadRuntimeHandlers(createParams());

    await handlers.createThread("direct", "review");
    await handlers.sendMessage("hello");
    await threadMessageSpy.sendParams?.createThread("from-send");

    expect(threadMessageSpy.create).toHaveBeenCalledTimes(2);
    expect(threadMessageSpy.create.mock.calls[0]?.[0]).toMatchObject({
      initialPrompt: "direct",
      threadSource: "review",
    });
    expect(threadMessageSpy.create.mock.calls[1]?.[0]).toMatchObject({
      initialPrompt: "from-send",
      threadSource: "control-api",
    });
    expect(threadMessageSpy.sendParams).toMatchObject({
      activeTurnId: "turn-1",
      selectedThreadId: "selected-thread",
      text: "hello",
    });
  });

  it("passes Provider execution preparation into the standard thread creator", async () => {
    const preparation = {
      workspaceKey: "workspace-1",
      afterStart: vi.fn(async () => undefined),
    };
    const handlers = createAppThreadRuntimeHandlers(
      createParams({
        prepareThreadExecutionContext: () => preparation,
      }),
    );

    await handlers.sendMessageInNewThread("provider prompt");
    await threadMessageSpy.sendParams?.createThread("provider prompt");

    expect(threadMessageSpy.createParams).toMatchObject({
      executionContextPreparation: preparation,
      threadSource: "control-api",
    });
  });

  it("wires draft creation and active turn interruption", async () => {
    const handlers = createAppThreadRuntimeHandlers(createParams());

    handlers.startDraftThread();
    await handlers.interruptActiveTurn();

    expect(threadListSpy.startDraft).toHaveBeenCalledOnce();
    expect(threadMessageSpy.interruptParams).toMatchObject({
      activeTurnId: "turn-1",
      selectedThreadId: "selected-thread",
    });
  });

  it("does not revive a persisted running turn without a live handle", async () => {
    const handlers = createAppThreadRuntimeHandlers(
      createParams({
        activeTurnId: null,
        selectedThread: runningThread("selected-thread", "turn-recovered"),
      }),
    );

    await handlers.interruptActiveTurn();
    await handlers.sendMessage("add guidance");

    expect(threadMessageSpy.interruptParams).toMatchObject({
      activeTurnId: null,
      selectedThreadId: "selected-thread",
    });
    expect(threadMessageSpy.sendParams).toMatchObject({
      activeTurnId: null,
      selectedThreadId: "selected-thread",
    });
  });

  it("can send from the command home as a new thread even when another thread is selected", async () => {
    const handlers = createAppThreadRuntimeHandlers(createParams());

    await handlers.sendMessageInNewThread("fresh prompt");

    expect(threadMessageSpy.sendParams).toMatchObject({
      activeTurnId: null,
      selectedThread: null,
      selectedThreadId: null,
      text: "fresh prompt",
    });

    await threadMessageSpy.sendParams?.createThread("fresh prompt");
    expect(threadMessageSpy.createParams?.workspaceCwd).toBeUndefined();
  });

  it("passes the command workspace selection into new thread creation", async () => {
    const handlers = createAppThreadRuntimeHandlers(createParams());

    await handlers.sendMessageInNewThread(
      "workspace prompt",
      undefined,
      "/repo/selected",
    );
    await threadMessageSpy.sendParams?.createThread("workspace prompt");

    expect(threadMessageSpy.createParams?.workspaceCwd).toBe("/repo/selected");
  });

  it("shares createThread with review and side chat handlers", async () => {
    const handlers = createAppThreadRuntimeHandlers(createParams());

    await handlers.startReview();
    await handlers.startSideChat();
    await threadToolSpy.reviewParams?.createThread();
    await threadToolSpy.sideChatParams?.createThread();

    expect(threadToolSpy.reviewParams).toMatchObject({
      isDemo: false,
      selectedThread: thread("selected-thread"),
    });
    expect(threadToolSpy.sideChatParams).toMatchObject({
      isDemo: false,
      selectedThread: thread("selected-thread"),
    });
    expect(threadMessageSpy.create).toHaveBeenCalledTimes(2);
  });
});
