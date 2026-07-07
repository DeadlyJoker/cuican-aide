import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import {
  handleKnowledgeLibraryAction,
  knowledgeMemoryThreadContext,
} from "./libraryKnowledgeActions";

type CapturedKnowledgeActionState = {
  confirmedMessages: string[];
  libraryOpened: number;
  memoryResets: number;
  notice: NoticeState | null;
  panel: LibraryPanel | null;
  writtenMemories: number;
};

function panel(): LibraryPanel {
  return {
    kind: "knowledge",
    title: "Knowledge",
    subtitle: "Workspace memory",
    body: "Existing",
    items: [],
  };
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
    cwd: "/repo",
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

async function handleAction(
  action: LibraryPanelAction,
  options: {
    confirmResult?: boolean;
    isConnected?: boolean;
    isDemo?: boolean;
    writePath?: string | null;
  } = {},
): Promise<{ handled: boolean; state: CapturedKnowledgeActionState }> {
  const state: CapturedKnowledgeActionState = {
    confirmedMessages: [],
    libraryOpened: 0,
    memoryResets: 0,
    notice: null,
    panel: panel(),
    writtenMemories: 0,
  };

  const handled = await handleKnowledgeLibraryAction({
    action,
    confirm: (message) => {
      state.confirmedMessages.push(message);
      return options.confirmResult ?? true;
    },
    isConnected: options.isConnected ?? true,
    isDemo: options.isDemo ?? false,
    locale: "en",
    openKnowledgeLibrary: async () => {
      state.libraryOpened += 1;
    },
    resetMemory: async () => {
      state.memoryResets += 1;
    },
    setLibraryPanel: (updater) => {
      state.panel = updater(state.panel);
    },
    setNotice: (notice) => {
      state.notice = notice;
    },
    writeKnowledgeMemory: async () => {
      state.writtenMemories += 1;
      return Object.hasOwn(options, "writePath")
        ? (options.writePath ?? null)
        : "/repo/.crewon/memory.md";
    },
  });

  return { handled, state };
}

describe("knowledge library actions", () => {
  it("builds knowledge memory context from the selected backend thread", () => {
    expect(
      knowledgeMemoryThreadContext({
        selectedThreadId: "thread-1",
        threads: [thread({ name: "Backend thread" })],
      }),
    ).toEqual({
      selectedThreadId: "thread-1",
      selectedThreadTitle: "Backend thread",
    });
  });

  it("omits knowledge memory thread context for demo or missing threads", () => {
    expect(
      knowledgeMemoryThreadContext({
        selectedThreadId: "demo-1",
        threads: [thread({ id: "thread-1", name: "Backend thread" })],
      }),
    ).toEqual({
      selectedThreadId: null,
      selectedThreadTitle: null,
    });

    expect(
      knowledgeMemoryThreadContext({
        selectedThreadId: "thread-2",
        threads: [thread({ id: "thread-1", name: "Backend thread" })],
      }),
    ).toEqual({
      selectedThreadId: null,
      selectedThreadTitle: null,
    });
  });

  it("uses null knowledge memory title when the selected thread is untitled", () => {
    expect(
      knowledgeMemoryThreadContext({
        selectedThreadId: "thread-1",
        threads: [thread({ name: null, preview: "" })],
      }),
    ).toEqual({
      selectedThreadId: "thread-1",
      selectedThreadTitle: null,
    });
  });

  it("refreshes the knowledge library", async () => {
    const { handled, state } = await handleAction({
      id: "refresh-knowledge",
      label: "Refresh",
    });

    expect(handled).toBe(true);
    expect(state.libraryOpened).toBe(1);
  });

  it("confirms and resets memory when connected", async () => {
    const { handled, state } = await handleAction({
      id: "reset-memory",
      label: "Reset",
    });

    expect(handled).toBe(true);
    expect(state.confirmedMessages).toEqual([
      "Resetting memory clears reusable model memory state. Continue?",
    ]);
    expect(state.memoryResets).toBe(1);
    expect(state.libraryOpened).toBe(1);
    expect(state.notice).toEqual({
      text: "Global memory reset",
      tone: "success",
    });
  });

  it("stops reset when confirmation is declined", async () => {
    const { handled, state } = await handleAction(
      { id: "reset-memory", label: "Reset" },
      { confirmResult: false },
    );

    expect(handled).toBe(true);
    expect(state.memoryResets).toBe(0);
    expect(state.libraryOpened).toBe(0);
  });

  it("shows a missing workspace panel when knowledge write has no path", async () => {
    const { handled, state } = await handleAction(
      {
        id: "create-knowledge-memory",
        label: "Create",
      },
      { writePath: null },
    );

    expect(handled).toBe(true);
    expect(state.writtenMemories).toBe(1);
    expect(state.notice).toBeNull();
    expect(state.panel?.error).toBe("No workspace path is available for writing knowledge.");
  });

  it("leaves unrelated actions for the app handler", async () => {
    const { handled } = await handleAction({
      id: "open-thread",
      label: "Open",
      threadId: "thread-1",
    });

    expect(handled).toBe(false);
  });
});
