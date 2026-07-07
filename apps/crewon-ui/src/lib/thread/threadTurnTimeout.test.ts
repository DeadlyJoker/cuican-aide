import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import {
  markModelResponseTimedOut,
  modelResponseTimeoutDelayMs,
  turnHasModelProgress,
} from "./threadTurnTimeout";

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 100,
    completedAt: null,
    durationMs: null,
    ...overrides,
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
    createdAt: 100,
    updatedAt: 100,
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
    turns: [turn()],
    ...overrides,
  };
}

function userMessage(): ThreadItem {
  return {
    id: "user-1",
    type: "userMessage",
    clientId: null,
    content: [{ type: "text", text: "hello", text_elements: [] }],
  };
}

describe("thread turn timeout", () => {
  it("treats user-only empty turns as having no model progress", () => {
    expect(turnHasModelProgress(turn({ items: [userMessage()] }))).toBe(false);
    expect(
      turnHasModelProgress(
        turn({
          items: [
            userMessage(),
            {
              id: "agent-1",
              type: "agentMessage",
              text: "started",
              phase: null,
              memoryCitation: null,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("returns a timeout delay only for stalled in-progress turns", () => {
    expect(
      modelResponseTimeoutDelayMs({
        nowMs: 112_000,
        streamingText: "",
        thread: thread({ turns: [turn({ items: [userMessage()] })] }),
        timeoutMs: 15_000,
        turnId: "turn-1",
      }),
    ).toBe(3_000);

    expect(
      modelResponseTimeoutDelayMs({
        nowMs: 120_000,
        streamingText: "",
        thread: thread({ turns: [turn({ items: [userMessage()] })] }),
        timeoutMs: 15_000,
        turnId: "turn-1",
      }),
    ).toBe(0);

    expect(
      modelResponseTimeoutDelayMs({
        nowMs: 120_000,
        streamingText: "partial",
        thread: thread({ turns: [turn({ items: [userMessage()] })] }),
        timeoutMs: 15_000,
        turnId: "turn-1",
      }),
    ).toBeNull();
  });

  it("marks stalled model turns as failed with a user-visible error", () => {
    const threads = [thread({ turns: [turn({ items: [userMessage()] })] })];

    expect(
      markModelResponseTimedOut({
        completedAt: 130,
        locale: "zh",
        threadId: "thread-1",
        threads,
        turnId: "turn-1",
      })[0]?.turns[0],
    ).toMatchObject({
      status: "failed",
      completedAt: 130,
      error: {
        message: "模型连接超时，当前任务已停止。请稍后重试，或检查模型与网络连接。",
      },
    });
  });
});
