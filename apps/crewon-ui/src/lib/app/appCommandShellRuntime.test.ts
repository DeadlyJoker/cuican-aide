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
  it("uses the streaming thread while command home selection is catching up", () => {
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
      activeTurnId: "turn-1",
      selectedThread: streamingThread,
      selectedThreadId: "thread-streaming",
      streamingText: "Live answer",
    });
  });
});
