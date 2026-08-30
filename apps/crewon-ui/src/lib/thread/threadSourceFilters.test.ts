import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import { isSingleConversationThread } from "./threadSourceFilters";

function userTurn(text: string): Turn {
  return {
    id: "turn-1",
    items: [
      {
        type: "userMessage",
        id: "item-1",
        clientId: null,
        content: [{ type: "text", text, text_elements: [] }],
      },
    ],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
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

describe("thread source filters", () => {
  it("keeps regular app-server threads in single conversations", () => {
    expect(isSingleConversationThread(thread({ threadSource: "app_server" }))).toBe(true);
  });

  it("keeps unknown non-domain threads in single conversations", () => {
    expect(isSingleConversationThread(thread({ threadSource: "worktree" }))).toBe(true);
  });

  it("keeps the singleton assistant out of workspace conversations", () => {
    expect(isSingleConversationThread(thread({ threadSource: "assistant" }))).toBe(
      false,
    );
  });

  it("excludes office source threads from single conversations", () => {
    expect(isSingleConversationThread(thread({ threadSource: "office" }))).toBe(false);
  });

  it("excludes server-owned Office manager runtimes from single conversations", () => {
    expect(
      isSingleConversationThread(
        thread({ threadSource: "office_manager_runtime_v1" }),
      ),
    ).toBe(false);
  });

  it("excludes office member runtime sources from single conversations", () => {
    expect(isSingleConversationThread(thread({ threadSource: "office_member_runtime" }))).toBe(
      false,
    );
    expect(
      isSingleConversationThread(thread({ threadSource: "office_member_runtime_repair_v2" })),
    ).toBe(false);
  });

  it("excludes office group chat prompt threads from single conversations", () => {
    expect(
      isSingleConversationThread(
        thread({
          preview: 'Office "Frontend Office" group chat message: Ship it',
          threadSource: "app_server",
        }),
      ),
    ).toBe(false);
  });

  it("excludes historical office bind prompt threads from single conversations", () => {
    expect(
      isSingleConversationThread(
        thread({
          threadSource: null,
          turns: [userTurn("绑定办公室：前端办公室")],
        }),
      ),
    ).toBe(false);
  });
});
