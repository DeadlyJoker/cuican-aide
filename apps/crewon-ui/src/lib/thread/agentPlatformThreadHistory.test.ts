import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it, vi } from "vitest";

import {
  agentPlatformAgentIdFromThreadSource,
  restoreAgentPlatformThread,
} from "./agentPlatformThreadHistory";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    clientVersion: "test",
    source: "appServer",
    threadSource: "agent-platform:agents:7",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

describe("Agent Platform thread history", () => {
  it("extracts only a non-empty Agent Platform agent id", () => {
    expect(agentPlatformAgentIdFromThreadSource("agent-platform:agents:7")).toBe(
      "7",
    );
    expect(agentPlatformAgentIdFromThreadSource("agent-platform:agents:")).toBeNull();
    expect(agentPlatformAgentIdFromThreadSource("app_server")).toBeNull();
  });

  it("restores completed rounds for an empty external Agent thread", async () => {
    const readAgentPlatformSession = vi.fn().mockResolvedValue([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
    ]);

    const restored = await restoreAgentPlatformThread({
      client: { readAgentPlatformSession },
      readAccessToken: async () => "access-token",
      thread: thread(),
    });

    expect(readAgentPlatformSession).toHaveBeenCalledWith(
      "access-token",
      "thread-1",
      "7",
    );
    expect(restored.turns).toHaveLength(1);
    expect(restored.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "userMessage" }),
        expect.objectContaining({ type: "agentMessage", text: "answer" }),
      ]),
    );
  });

  it("does not read BFF history for local or already populated threads", async () => {
    const readAgentPlatformSession = vi.fn();
    const existing = thread({
      turns: [
        {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null,
        } as unknown as Thread["turns"][number],
      ],
    });

    await restoreAgentPlatformThread({
      client: { readAgentPlatformSession },
      readAccessToken: async () => "access-token",
      thread: existing,
    });
    await restoreAgentPlatformThread({
      client: { readAgentPlatformSession },
      readAccessToken: async () => "access-token",
      thread: thread({ threadSource: "app_server" }),
    });

    expect(readAgentPlatformSession).not.toHaveBeenCalled();
  });
});
