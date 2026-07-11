import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import { commandShellRuntimeState } from "./appCommandShellRuntime";

function thread(id: string): Thread {
  return {
    id,
    sessionId: `${id}-session`,
    forkedFromId: null,
    parentThreadId: null,
    preview: id,
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    clientVersion: "test",
    source: "appServer",
    threadSource: "app_server",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

describe("command shell runtime state", () => {
  it("does not keep a stale thread after the user starts a blank task", () => {
    expect(
      commandShellRuntimeState({
        activeTurnByThread: {},
        activeTurnId: null,
        renderCommandShell: true,
        selectedThread: thread("stale-thread"),
        selectedThreadId: null,
        streamingTextByThread: {},
        threads: [],
      }),
    ).toEqual({
      activeTurnId: null,
      selectedThread: null,
      selectedThreadId: null,
      streamingText: "",
    });
  });

  it("ignores completed streaming text when there is no active turn", () => {
    expect(
      commandShellRuntimeState({
        activeTurnByThread: {},
        activeTurnId: null,
        renderCommandShell: true,
        selectedThread: thread("completed-thread"),
        selectedThreadId: null,
        streamingTextByThread: { "completed-thread": "Completed answer" },
        threads: [thread("completed-thread")],
      }),
    ).toEqual({
      activeTurnId: null,
      selectedThread: null,
      selectedThreadId: null,
      streamingText: "",
    });
  });

  it("does not reopen a stale selected thread from an old active-turn entry", () => {
    expect(
      commandShellRuntimeState({
        activeTurnByThread: { "stale-thread": "turn-old" },
        activeTurnId: null,
        renderCommandShell: true,
        selectedThread: thread("stale-thread"),
        selectedThreadId: null,
        streamingTextByThread: { "stale-thread": "Old answer" },
        threads: [thread("stale-thread")],
      }),
    ).toEqual({
      activeTurnId: null,
      selectedThread: null,
      selectedThreadId: null,
      streamingText: "",
    });
  });

  it("does not surface an unselected streaming thread over a blank draft", () => {
    const streamingThread = thread("thread-streaming");

    expect(
      commandShellRuntimeState({
        activeTurnByThread: { "thread-streaming": "turn-1" },
        activeTurnId: null,
        renderCommandShell: true,
        selectedThread: null,
        selectedThreadId: null,
        streamingTextByThread: { "thread-streaming": "Live answer" },
        threads: [streamingThread],
      }),
    ).toEqual({
      activeTurnId: null,
      selectedThread: null,
      selectedThreadId: null,
      streamingText: "",
    });
  });
});
