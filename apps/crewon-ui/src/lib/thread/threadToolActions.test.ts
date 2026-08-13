import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  startReviewAction,
  startSideChatAction,
  type StartReviewActionParams,
} from "./threadToolActions";

type ThreadToolClient = NonNullable<StartReviewActionParams["client"]>;

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    agentNickname: null,
    agentRole: null,
    clientVersion: "test",
    createdAt: 1,
    cwd: "/repo",
    ephemeral: false,
    forkedFromId: null,
    gitInfo: null,
    id: "thread-1",
    modelProvider: "openai",
    name: "Main thread",
    parentThreadId: null,
    path: null,
    preview: "Main preview",
    sessionId: "session-1",
    source: "unknown",
    status: { type: "idle" },
    threadSource: null,
    turns: [],
    updatedAt: 1,
    ...overrides,
  };
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    completedAt: 2,
    durationMs: 100,
    error: null,
    id: "turn-1",
    items: [],
    itemsView: "full",
    startedAt: 1,
    status: "completed",
    ...overrides,
  };
}

function baseClient(overrides: Partial<ThreadToolClient> = {}): ThreadToolClient {
  return {
    async forkThread() {
      return { thread: thread({ id: "side-thread" }) };
    },
    async startReview() {
      return { reviewThreadId: "thread-1", turn: turn() };
    },
    ...overrides,
  };
}

function panelSink() {
  let panel: CapabilityPanel | null = null;
  return {
    get panel() {
      return panel;
    },
    setCapabilityPanel: (
      panelOrUpdater:
        | CapabilityPanel
        | null
        | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
    ) => {
      panel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(panel)
          : panelOrUpdater;
    },
  };
}

function baseParams(
  overrides: Partial<StartReviewActionParams> = {},
): StartReviewActionParams {
  const sink = panelSink();
  return {
    busyToolId: null,
    client: baseClient(),
    createThread: async () => thread({ id: "created-thread" }),
    isConnected: true,
    isDemo: false,
    isDemoPreview: false,
    locale: "en",
    selectedThread: thread(),
    setBusyToolId: () => {},
    setCapabilityPanel: sink.setCapabilityPanel,
    setNotice: () => {},
    setSelectedThreadId: () => {},
    setThreads: () => {},
    ...overrides,
  };
}

describe("thread tool actions", () => {
  it("opens review demo panel without backend calls", async () => {
    const sink = panelSink();
    let called = false;

    await startReviewAction(
      baseParams({
        client: baseClient({
          async startReview() {
            called = true;
            return { reviewThreadId: "thread-1", turn: turn() };
          },
        }),
        isDemo: true,
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    );

    expect(called).toBe(false);
    expect(sink.panel).toMatchObject({
      subtitle: "Code review · demo-1",
      title: "Review",
    });
  });

  it("starts review on the selected thread and inserts the review turn", async () => {
    const busyStates: Array<string | null> = [];
    const selectedIds: string[] = [];
    let threads = [thread()];
    const reviewedThreads: string[] = [];

    await startReviewAction(
      baseParams({
        client: baseClient({
          async startReview(threadId) {
            reviewedThreads.push(threadId);
            return { reviewThreadId: threadId, turn: turn({ id: "review-turn" }) };
          },
        }),
        setBusyToolId: (toolId) => {
          busyStates.push(toolId);
        },
        setSelectedThreadId: (threadId) => {
          selectedIds.push(threadId);
        },
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    );

    expect(reviewedThreads).toEqual(["thread-1"]);
    expect(selectedIds).toEqual(["thread-1"]);
    expect(busyStates).toEqual(["review", null]);
    expect(threads[0]?.turns).toEqual([turn({ id: "review-turn" })]);
  });

  it("creates a thread before review in demo preview", async () => {
    const reviewedThreads: string[] = [];
    let created = false;

    await startReviewAction(
      baseParams({
        client: baseClient({
          async startReview(threadId) {
            reviewedThreads.push(threadId);
            return { reviewThreadId: threadId, turn: turn() };
          },
        }),
        createThread: async () => {
          created = true;
          return thread({ id: "created-thread" });
        },
        isDemoPreview: true,
      }),
    );

    expect(created).toBe(true);
    expect(reviewedThreads).toEqual(["created-thread"]);
  });

  it("reports review failures", async () => {
    const busyStates: Array<string | null> = [];
    let notice: NoticeState | null = null;

    await startReviewAction(
      baseParams({
        client: baseClient({
          async startReview() {
            throw new Error("review failed");
          },
        }),
        setBusyToolId: (toolId) => {
          busyStates.push(toolId);
        },
        setNotice: (nextNotice) => {
          notice = nextNotice;
        },
      }),
    );

    expect(busyStates).toEqual(["review", null]);
    expect(notice).toEqual({
      text: "review failed",
      tone: "warning",
    });
  });

  it("forks a side chat and selects it", async () => {
    const sink = panelSink();
    const busyStates: Array<string | null> = [];
    const forkedThreads: string[] = [];
    const selectedIds: string[] = [];
    let threads = [thread()];

    await startSideChatAction({
      ...baseParams({
        client: baseClient({
          async forkThread(threadId) {
            forkedThreads.push(threadId);
            return {
              thread: thread({
                forkedFromId: threadId,
                id: "side-thread",
                name: "Side thread",
              }),
            };
          },
        }),
        setBusyToolId: (toolId) => {
          busyStates.push(toolId);
        },
        setCapabilityPanel: sink.setCapabilityPanel,
        setSelectedThreadId: (threadId) => {
          selectedIds.push(threadId);
        },
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    });

    expect(forkedThreads).toEqual(["thread-1"]);
    expect(selectedIds).toEqual(["side-thread"]);
    expect(busyStates).toEqual(["sidechat", null]);
    expect(threads.map((candidate) => candidate.id)).toEqual([
      "side-thread",
      "thread-1",
    ]);
    expect(sink.panel).toEqual({
      body: "Forked side chat created",
      subtitle: "side-thread",
      title: "Side chat",
    });
  });

  it("opens side chat demo panel without forking", async () => {
    const sink = panelSink();
    let called = false;

    await startSideChatAction({
      ...baseParams({
        client: baseClient({
          async forkThread() {
            called = true;
            return { thread: thread({ id: "side-thread" }) };
          },
        }),
        isDemo: true,
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    });

    expect(called).toBe(false);
    expect(sink.panel).toMatchObject({
      subtitle: "Forked from current session",
      title: "Side chat",
    });
  });
});
