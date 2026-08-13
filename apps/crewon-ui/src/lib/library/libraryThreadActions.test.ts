import type { Thread } from "@crewon-ui-model/v2/Thread";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { AppView } from "../shared/appView";
import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import { handleLibraryThreadAction } from "./libraryThreadActions";

type CapturedLibraryThreadState = {
  appView: AppView;
  capabilityPanel: CapabilityPanel | null;
  libraryPanel: LibraryPanel | null;
  notice: NoticeState | null;
  selectedThreadId: string | null;
  threads: Thread[];
};

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
    name: "Opened thread",
    turns: [],
    ...overrides,
  };
}

async function handleAction(
  action: LibraryPanelAction,
  options: {
    readError?: unknown;
    thread?: Thread | null;
  } = {},
): Promise<{ handled: boolean; state: CapturedLibraryThreadState }> {
  const state: CapturedLibraryThreadState = {
    appView: "library",
    capabilityPanel: { title: "Capability" },
    libraryPanel: {
      kind: "automation",
      title: "Automation",
      subtitle: "Runs",
      items: [],
    },
    notice: null,
    selectedThreadId: null,
    threads: [thread({ id: "existing-thread", name: "Existing" })],
  };

  const handled = await handleLibraryThreadAction({
    action,
    locale: "en",
    readThread: async () => {
      if (options.readError) {
        throw options.readError;
      }
      return Object.hasOwn(options, "thread")
        ? options.thread
        : thread();
    },
    setAppView: (view) => {
      state.appView = view;
    },
    setCapabilityPanel: (panel) => {
      state.capabilityPanel = panel;
    },
    setLibraryPanel: (panel) => {
      state.libraryPanel = panel;
    },
    setNotice: (notice) => {
      state.notice = notice;
    },
    setSelectedThreadId: (threadId) => {
      state.selectedThreadId = threadId;
    },
    setThreads: (updater) => {
      state.threads = updater(state.threads);
    },
  });

  return { handled, state };
}

describe("library thread actions", () => {
  it("opens a backend thread and moves back to chat", async () => {
    const { handled, state } = await handleAction({
      id: "open-thread",
      label: "Open thread",
      threadId: "thread-1",
    });

    expect(handled).toBe(true);
    expect(state.selectedThreadId).toBe("thread-1");
    expect(state.appView).toBe("chat");
    expect(state.libraryPanel).toBeNull();
    expect(state.capabilityPanel).toBeNull();
    expect(state.threads.map((item) => item.id)).toEqual([
      "thread-1",
      "existing-thread",
    ]);
    expect(state.notice).toEqual({
      text: "Opened backend thread: Opened thread",
      tone: "success",
    });
  });

  it("reports open-thread actions without a thread id", async () => {
    const { handled, state } = await handleAction({
      id: "open-thread",
      label: "Open thread",
    });

    expect(handled).toBe(true);
    expect(state.notice).toEqual({
      text: "No backend thread is available to open",
      tone: "warning",
    });
    expect(state.appView).toBe("library");
  });

  it("reports read failures without navigating away", async () => {
    const { handled, state } = await handleAction(
      {
        id: "open-thread",
        label: "Open thread",
        threadId: "thread-1",
      },
      { readError: new Error("missing") },
    );

    expect(handled).toBe(true);
    expect(state.notice).toEqual({ text: "missing", tone: "warning" });
    expect(state.appView).toBe("library");
    expect(state.selectedThreadId).toBeNull();
  });

  it("leaves unrelated actions for the app handler", async () => {
    const { handled } = await handleAction({
      id: "refresh-knowledge",
      label: "Refresh",
    });

    expect(handled).toBe(false);
  });
});
